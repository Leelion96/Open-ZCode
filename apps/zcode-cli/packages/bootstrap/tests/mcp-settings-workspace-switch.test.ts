import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMcpConnectionPool } from "@zcode/adapters/mcp";
import type { McpPort, McpServerStatus } from "@zcode/contracts";
import { convertToZCodeAgentMcpServer, type ZCodeProtocolMcpServer } from "@zcode/shared";
import * as trustModule from "../src/workspace-mcp-trust/index.js";
const { createWorkspaceMcpTrust } = trustModule;
import { listMcpServers, setWorkspaceMcpTrust } from "../src/zcode-protocol/mcp.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const isolated = vi.hoisted(() => ({ home: undefined as string | undefined }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: () => isolated.home ?? actual.homedir() };
});
afterEach(async () => {
  const root = isolated.home;
  isolated.home = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "mcp-settings-switch-"));
  isolated.home = root;
  await mkdir(join(root, ".zcode/cli"), { recursive: true });
  await writeFile(
    join(root, ".zcode/cli/config.json"),
    JSON.stringify({ storage: { dir: join(root, "storage") }, plugins: { enabled: false } }),
  );
  return root;
}

it("跨 workspace 状态查询保持现有连接，显式切换后迟到 OAuth 不能复活旧连接", async () => {
  const root = await setup();
  const gate = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const starts: string[] = [];
  const pool = createMcpConnectionPool({
    idleGraceMs: 60_000,
    createAdapter: ({ serverName, config }) => {
      const label = config.type === "stdio" ? config.command : "oauth";
      let connected = false;
      const snapshot = (): McpServerStatus => ({
        status: connected ? "connected" : "connecting",
        transport: config.type,
        toolCount: connected ? 1 : 0,
        updatedAt: new Date().toISOString(),
        ...(!connected && serverName === "slow"
          ? {
              authorization: {
                type: "oauth_authorization_code" as const,
                authorizationUrl: "https://example.test/authorize",
                startedAt: new Date().toISOString(),
              },
            }
          : {}),
      });
      return {
        async connectServer() {
          starts.push(label);
          if (serverName === "slow") {
            await gate.promise;
            finished.resolve();
          }
          connected = true;
          return snapshot();
        },
        async status() {
          return { [serverName]: snapshot() };
        },
        async listTools() {
          return connected
            ? [{ serverName, name: label, description: label, inputSchema: { type: "object" } }]
            : [];
        },
        async disconnectServer() {},
        async close() {},
        async pingServer() {
          return true;
        },
      } as McpPort;
    },
  });
  const raw = pool.acquireLease();
  // 直接观察 gate 的整次配置收敛，避免用时间窗口判断旧任务已经结束。
  const completions: Promise<unknown>[] = [];
  const wrap = vi.spyOn(trustModule, "createWorkspaceMcpTrust").mockImplementation((options) => {
    const authority = createWorkspaceMcpTrust(options);
    const guard = authority.guard;
    authority.guard = (...args) => {
      const port = guard(...args);
      return new Proxy(port, {
        get(target, key) {
          if (key === "connectConfiguredServers")
            return (...input: Parameters<McpPort["connectConfiguredServers"]>) => {
              const pending = target.connectConfiguredServers(...input);
              completions.push(pending);
              return pending;
            };
          return Reflect.get(target, key, target);
        },
      });
    };
    return authority;
  });
  async function params(label: string) {
    const workspace = join(root, label);
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    const config = { type: "stdio" as const, command: label, args: [] };
    await writeFile(
      join(workspace, ".zcode/config.json"),
      JSON.stringify({ mcp: { servers: { probe: config } } }),
    );
    const authority = createWorkspaceMcpTrust({ workingDirectory: workspace, env: {} });
    await authority.decide("probe", (await authority.inspect()).probe!.declarationDigest, true);
    return {
      workspace: { workspacePath: workspace, workspaceKey: workspace },
      mcpServers: [
        convertToZCodeAgentMcpServer("probe", config, "workspace")!,
      ] as ZCodeProtocolMcpServer[],
    };
  }
  try {
    const context = { deps: { env: {}, mcpPort: raw } } as ZCodeProtocolAgentServerContext;
    const a = await params("A"),
      b = await params("B"),
      c = await params("C");
    a.mcpServers.push({
      name: "fast",
      command: "user-fast",
      args: [],
      env: [],
      scope: "user",
    });
    a.mcpServers.push({
      name: "slow",
      type: "http",
      url: "https://example.test/mcp",
      headers: [],
      scope: "user",
    });
    const first = await listMcpServers(context, a);
    expect(first.statuses.slow?.authorization).toBeDefined();
    expect(first.statuses.fast?.status).toBe("connected");
    const foreignStatus = await listMcpServers(context, { ...b, mode: "status" });
    expect(foreignStatus.statuses.probe?.status).toBe("disconnected");
    expect(foreignStatus.statuses.fast).toBeUndefined();
    expect(foreignStatus.statuses.slow).toBeUndefined();
    const retainedStatus = await listMcpServers(context, { ...a, mode: "status" });
    expect(retainedStatus.statuses.fast?.status).toBe("connected");
    expect(retainedStatus.statuses.slow?.authorization).toBeDefined();
    expect(completions).toHaveLength(1);
    expect((await raw.listTools()).map((tool) => tool.name)).toEqual(["user-fast"]);
    // 切换与连接都走真实 mcp/list 和连接池；只有远端握手由 barrier 控制。
    await listMcpServers(context, b);
    expect((await raw.listTools()).map((tool) => tool.name)).toEqual(["B"]);
    gate.resolve();
    await finished.promise;
    await completions[0];
    expect((await raw.listTools()).map((tool) => tool.name)).toEqual(["B"]);
    await listMcpServers(context, c);
    expect((await raw.listTools()).map((tool) => tool.name)).toEqual(["C"]);
    expect(starts).not.toContain("A");
  } finally {
    gate.resolve();
    await Promise.allSettled(completions);
    wrap.mockRestore();
    await pool.close();
  }
});

it("状态读取期间显式切换 workspace 时丢弃旧请求的共享连接快照", async () => {
  const root = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const connected: McpServerStatus = {
    status: "connected",
    transport: "stdio",
    toolCount: 1,
    updatedAt: new Date().toISOString(),
  };
  const status = vi.fn(async () => ({ probe: connected }));
  const raw = {
    status,
    disconnectServer: vi.fn(async () => undefined),
    connectConfiguredServers: vi.fn(async () => ({ statuses: { probe: connected }, tools: [] })),
    listTools: vi.fn(async () => []),
  } as unknown as McpPort;
  const context = { deps: { env: {}, mcpPort: raw } } as ZCodeProtocolAgentServerContext;
  const params = (name: string) => ({
    workspace: { workspaceKey: name, workspacePath: root },
    mcpServers: [{ name: "probe", command: name, scope: "user", args: [], env: [] }],
  });
  await listMcpServers(context, params("A"));
  status.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { probe: connected };
  });
  const pending = listMcpServers(context, { ...params("A"), mode: "status" });
  try {
    await entered.promise;
    await listMcpServers(context, params("B"));
  } finally {
    release.resolve();
  }
  expect((await pending).statuses.probe?.status).toBe("disconnected");
  expect(
    (await listMcpServers(context, { ...params("B"), mode: "status" })).statuses.probe?.status,
  ).toBe("connected");
});

it("mcp/list 的坏 fallback 邻项不拖垮用户 MCP 列表", async () => {
  const root = await setup(),
    workspace = join(root, "workspace");
  await mkdir(join(workspace, ".agents"), { recursive: true });
  await writeFile(
    join(workspace, ".agents/mcp.json"),
    JSON.stringify({ mcpServers: { bad: { command: "fake", description: "extra" } } }),
  );
  const context = { deps: { env: {} } } as ZCodeProtocolAgentServerContext;
  const result = await listMcpServers(context, {
    workspace: { workspacePath: workspace, workspaceKey: workspace },
    mcpServers: [{ name: "good", scope: "user", command: "fake", args: [], env: [] }],
    mode: "status",
  });
  expect(result.statuses.good).toBeDefined();
});

it("设置连接清理失败后，同一 workspace 可以重试", async () => {
  const root = await setup();
  const raw = {
    status: vi
      .fn()
      .mockRejectedValueOnce(new Error("transient status failure"))
      .mockResolvedValue({}),
    connectConfiguredServers: vi.fn(async () => ({ statuses: {}, tools: [] })),
    listTools: vi.fn(async () => []),
  } as unknown as McpPort;
  const context = { deps: { env: {}, mcpPort: raw } } as ZCodeProtocolAgentServerContext;
  const params = { workspace: { workspaceKey: root, workspacePath: root }, mcpServers: [] };
  await expect(listMcpServers(context, params)).rejects.toThrow("transient status failure");
  await expect(listMcpServers(context, params)).resolves.toEqual({ statuses: {} });
});

it("设置授权只通知相同 workspace 的活跃会话，刷新失败不改写已落盘的授权结果", async () => {
  const root = await setup(),
    workspace = join(root, "workspace");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(
    join(workspace, ".zcode/config.json"),
    JSON.stringify({ mcp: { servers: { probe: { type: "stdio", command: "fake" } } } }),
  );
  const authority = createWorkspaceMcpTrust({
    workingDirectory: workspace,
    workspaceIdentity: "identity-A",
    env: {},
  });
  const digest = (await authority.inspect()).probe!.declarationDigest;
  const refresh = vi.fn(async () => undefined),
    otherRefresh = vi.fn(async () => undefined);
  const context = {
    deps: { env: {} },
    logger: { warn: vi.fn() },
    sessions: new Map([
      [
        "a",
        {
          workspace: { workspaceKey: "identity-A", workspacePath: workspace },
          app: { reloadWorkspaceMcpTrust: refresh },
        },
      ],
      [
        "b",
        {
          workspace: { workspaceKey: "identity-B", workspacePath: workspace },
          app: { reloadWorkspaceMcpTrust: otherRefresh },
        },
      ],
    ]),
  } as unknown as ZCodeProtocolAgentServerContext;
  const params = {
    workspace: {
      workspaceKey: "identity-A",
      workspacePath: workspace,
      workspaceIdentity: "identity-A",
    },
    serverName: "probe",
    declarationDigest: digest,
    trusted: true,
  };
  expect(await setWorkspaceMcpTrust(context, params)).toEqual({ accepted: true });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(otherRefresh).not.toHaveBeenCalled();
  refresh.mockRejectedValueOnce(new Error("publication failed"));
  expect(await setWorkspaceMcpTrust(context, { ...params, trusted: false })).toEqual({
    accepted: true,
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(context.logger?.warn).toHaveBeenCalled();
  expect(
    await setWorkspaceMcpTrust(context, { ...params, declarationDigest: "b".repeat(64) }),
  ).toMatchObject({ accepted: false });
  expect(refresh).toHaveBeenCalledTimes(2);
});
