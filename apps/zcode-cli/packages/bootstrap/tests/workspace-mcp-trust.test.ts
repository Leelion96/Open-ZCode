import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import {
  convertToZCodeAgentMcpServer,
  type McpServerConfig as HostMcpServerConfig,
} from "@zcode/shared";
import type { McpPort } from "@zcode/contracts";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("工作区直接 MCP 不得被当作用户可信配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-mcp-trust-"));
  roots.push(root);
  await mkdir(join(root, ".zcode"));
  await writeFile(
    join(root, ".zcode/config.json"),
    JSON.stringify({
      mcp: {
        servers: {
          probe: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(0)"] },
        },
      },
    }),
  );
  const result = resolveAppRuntimeConfig({
    cliStorageRoot: join(root, "storage"),
    configResult: createConfig({ workingDirectory: root, skipUserConfig: true, env: {} }),
    options: {},
    subagentOutputRootDir: join(root, "output"),
    workingDirectory: root,
  });
  expect(result.untrustedProjectMcpServers.has("probe")).toBe(true);
});

import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createMcpAdapter, createMcpAdapterConnectionPool } from "@zcode/adapters/mcp";
import type { McpServerConfig } from "@zcode/contracts";
import { createWorkspaceMcpTrust } from "../src/workspace-mcp-trust/index.js";

async function fixture(exitAfterCall = false) {
  const root = await mkdtemp(join(tmpdir(), "workspace-mcp-runtime-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const userConfigPath = join(root, "user.json");
  const marker = join(root, "started");
  const script = join(root, "server.mjs");
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(userConfigPath, JSON.stringify({ storage: { dir: join(root, "user-data") } }));
  await writeFile(
    script,
    `import {writeFile, appendFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
await writeFile(process.argv[2], 'started');
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line); if(r.id===undefined) continue;
 const result=r.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'local-test',version:'1'}}:
 r.method==='tools/list'?{tools:[{name:'probe',description:'local probe',inputSchema:{type:'object'}}]}:
 r.method==='tools/call'?{content:[{type:'text',text:'ok'}]}:{};
 if(r.method==='tools/call') await appendFile(process.argv[2], '\\ncall');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n', () => {
   if (${exitAfterCall} && r.method==='tools/call') process.exit(0);
 });
}`,
  );
  const config: McpServerConfig = {
    type: "stdio",
    command: process.execPath,
    args: [script, marker],
    protocolVersion: "legacy",
    source: { kind: "workspace" },
  };
  async function save(value: McpServerConfig = config) {
    const { source: _source, ...raw } = value;
    await writeFile(
      join(workspace, ".zcode/config.json"),
      JSON.stringify({ mcp: { servers: { probe: raw } } }),
    );
  }
  await save();
  const options = { workingDirectory: workspace, userConfigPath, env: {} };
  return {
    root,
    workspace,
    marker,
    config,
    options,
    save,
    authority: createWorkspaceMcpTrust(options),
  };
}

it("真实 stdio：未信任零进程，授权后握手，撤销在下次连接准入生效", async () => {
  const f = await fixture();
  let pendingCount = 0;
  f.authority = createWorkspaceMcpTrust({
    ...f.options,
    onAdmissionChanged: async (state) => {
      pendingCount = state.pendingCount;
    },
  });
  const port = f.authority.guard(createMcpAdapter());
  try {
    expect((await port.connectServer("probe", f.config)).status).toBe("untrusted");
    await expect(access(f.marker)).rejects.toThrow();
    const review = (await f.authority.inspect()).probe!;
    await f.authority.decide("probe", review.declarationDigest, true);
    expect((await port.connectServer("probe", f.config)).status).toBe("connected");
    expect(await readFile(f.marker, "utf8")).toBe("started");
    expect(await createWorkspaceMcpTrust(f.options).allows("probe", f.config)).toBe(true);
    await port.callTool({ serverName: "probe", toolName: "probe", arguments: {} });
    await f.authority.decide("probe", review.declarationDigest, false);
    await port.refreshWorkspaceTrustAdmission!();
    expect(pendingCount).toBe(1);
    await port.callTool({ serverName: "probe", toolName: "probe" });
    expect(await port.listTools()).toHaveLength(1);
    expect((await port.connectServer("probe", f.config)).status).toBe("untrusted");
    await expect(port.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
    expect(await port.listTools()).toEqual([]);
    expect(await readFile(f.marker, "utf8")).toBe("started\ncall\ncall");
  } finally {
    await port.close();
  }
});

it("连接内工具调用、状态、列表与 ping 不重复读取授权，断开后拒绝调用", async () => {
  const f = await fixture();
  await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
  const check = vi.spyOn(f.authority, "allows");
  const port = f.authority.guard(createMcpAdapter());
  try {
    await port.connectServer("probe", f.config);
    check.mockClear();
    for (let i = 0; i < 3; i++) {
      await port.callTool({ serverName: "probe", toolName: "probe" });
      expect((await port.status()).probe?.status).toBe("connected");
      expect(await port.listTools()).toHaveLength(1);
      expect(await port.pingServer!("probe")).toBe(true);
    }
    expect(check).not.toHaveBeenCalled();
    await port.disconnectServer("probe");
    await expect(port.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
    expect(await readFile(f.marker, "utf8")).toBe("started\ncall\ncall\ncall");
  } finally {
    check.mockRestore();
    await port.close();
  }
});

it("真实断线自动重连沿用会话授权，撤销后新会话准入拒绝", async () => {
  const f = await fixture(true);
  const review = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", review.declarationDigest, true);
  const raw = createMcpAdapter();
  const connects = vi.spyOn(raw, "connectServer");
  const check = vi.spyOn(f.authority, "allows");
  const port = f.authority.guard(raw);
  const restarted = createWorkspaceMcpTrust(f.options).guard(createMcpAdapter());
  try {
    await port.connectServer("probe", f.config);
    check.mockClear();
    await port.callTool({ serverName: "probe", toolName: "probe" });
    await vi.waitFor(async () => {
      expect((await port.status()).probe?.status).toBe("disconnected");
    });
    await f.authority.decide("probe", review.declarationDigest, false);
    await expect(port.callTool({ serverName: "probe", toolName: "probe" })).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(connects).toHaveBeenCalledTimes(2);
    expect(check).not.toHaveBeenCalled();
    expect((await restarted.connectServer("probe", f.config)).status).toBe("untrusted");
    await expect(restarted.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
  } finally {
    connects.mockRestore();
    check.mockRestore();
    await port.close();
    await restarted.close();
  }
});

it.each(["changed", "removed", "disabled", "corrupt"] as const)(
  "连接后 %s 不影响已批准连接，下次连接准入拒绝",
  async (change) => {
    const f = await fixture();
    await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
    const port = f.authority.guard(createMcpAdapter());
    try {
      await port.connectServer("probe", f.config);
      if (change === "changed") await f.save({ ...f.config, env: { VERSION: "2" } });
      if (change === "disabled") await f.save({ ...f.config, enabled: false });
      if (change === "removed") await writeFile(join(f.workspace, ".zcode/config.json"), "{}");
      if (change === "corrupt")
        await writeFile(join(f.root, "user-data/security/workspace-mcp-trust-v1.json"), "invalid");
      await port.callTool({ serverName: "probe", toolName: "probe" });
      expect((await port.connectServer("probe", f.config)).status).toBe("untrusted");
      await expect(port.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
        "workspace_mcp_pending_trust",
      );
      expect(await readFile(f.marker, "utf8")).toBe("started\ncall");
    } finally {
      await port.close();
    }
  },
);

it("声明变化拒绝旧审核与旧连接配置；enabled 不扩大或清除授权", async () => {
  const f = await fixture();
  const old = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", old.declarationDigest, true);
  await f.save({ ...f.config, enabled: false });
  expect((await f.authority.inspect()).probe?.declarationDigest).toBe(old.declarationDigest);
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  await f.save({ ...f.config, env: { VERSION: "2" } });
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  await expect(f.authority.decide("probe", old.declarationDigest, true)).rejects.toThrow(
    "workspace_mcp_declaration_changed",
  );
  await writeFile(join(f.workspace, ".zcode/config.json"), "{}");
  expect(await f.authority.allows("probe", f.config)).toBe(false);
});

it("HTTP/SSE 未信任不发出任何请求；secret 不进入审核显示或存储", async () => {
  const f = await fixture();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const port = f.authority.guard(createMcpAdapter());
  try {
    for (const type of ["http", "sse"] as const) {
      const config: McpServerConfig = {
        type,
        url: `http://127.0.0.1:${address.port}/mcp?token=secret-query`,
        headers: { Authorization: "secret-header" },
        source: { kind: "workspace" },
      };
      await f.save(config);
      expect((await port.connectServer("probe", config)).status).toBe("untrusted");
      const review = (await f.authority.inspect()).probe!;
      expect(review.display).not.toContain("secret");
      await f.authority.decide("probe", review.declarationDigest, true);
      const content = await readFile(
        join(f.root, "user-data/security/workspace-mcp-trust-v1.json"),
        "utf8",
      );
      expect(content).not.toContain("secret");
    }
    expect(requests).toBe(0);
  } finally {
    await port.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it("同名 server 不跨 workspaceIdentity 继承授权，包括连接池 lease 复用", async () => {
  const f = await fixture();
  const other = createWorkspaceMcpTrust({ ...f.options, workspaceIdentity: "remote:other" });
  await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
  const pool = createMcpAdapterConnectionPool({ idleGraceMs: 0 });
  const first = f.authority.guard(pool.acquireLease());
  const second = other.guard(pool.acquireLease());
  try {
    expect((await first.connectServer("probe", f.config)).status).toBe("connected");
    expect((await second.connectServer("probe", f.config)).status).toBe("untrusted");
    expect(await second.listTools()).toEqual([]);
  } finally {
    await first.close();
    await second.close();
    await pool.close();
  }
});

it("损坏授权文件拒绝执行与授权；项目 storage.dir 不改变用户域记录位置", async () => {
  const f = await fixture();
  const review = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", review.declarationDigest, true);
  await writeFile(
    join(f.root, "user-data/security/workspace-mcp-trust-v1.json"),
    '{"schemaVersion":99,"records":[]}',
  );
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  await expect(f.authority.decide("probe", review.declarationDigest, true)).rejects.toThrow();
});

it(".agents 工作区 fallback 也必须单独审核；用户和插件来源不被误拦截", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, ".zcode/config.json"), "{}");
  await mkdir(join(f.workspace, ".agents"));
  const { source: _source, ...raw } = f.config;
  await writeFile(
    join(f.workspace, ".agents/mcp.json"),
    JSON.stringify({ mcpServers: { probe: raw } }),
  );
  expect(await f.authority.allows("probe", f.config)).toBe(false);
  expect((await f.authority.inspect()).probe?.sourcePaths).toEqual([
    join(f.workspace, ".agents/mcp.json"),
  ]);
  for (const kind of ["user", "plugin", "builtin"] as const) {
    expect(await f.authority.allows("probe", { ...f.config, source: { kind } })).toBe(true);
  }
});

it("连接使用审核时的私有配置副本，调用方修改对象不能改变实际 spawn", async () => {
  const f = await fixture();
  await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
  const port = f.authority.guard(createMcpAdapter());
  try {
    const connecting = port.connectServer("probe", f.config);
    if (f.config.type === "stdio") f.config.args = ["-e", "throw new Error('mutated')"];
    expect((await connecting).status).toBe("connected");
    expect(await readFile(f.marker, "utf8")).toBe("started");
  } finally {
    await port.close();
  }
});

it("并发进程批准不同 workspace 时不丢失记录", async () => {
  const f = await fixture();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const moduleUrl = new URL("../src/workspace-mcp-trust/index.ts", import.meta.url).href;
  const script = `const { createWorkspaceMcpTrust } = await import(process.argv[1]);
const authority = createWorkspaceMcpTrust(JSON.parse(process.argv[2]));
await authority.decide('probe', (await authority.inspect()).probe.declarationDigest, true);`;
  await Promise.all(
    ["first", "second"].map((workspaceIdentity) =>
      run(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        moduleUrl,
        JSON.stringify({ ...f.options, workspaceIdentity }),
      ]),
    ),
  );
  const store = JSON.parse(
    await readFile(join(f.root, "user-data/security/workspace-mcp-trust-v1.json"), "utf8"),
  );
  expect(
    store.records.map((record: { workspaceIdentity: string }) => record.workspaceIdentity).sort(),
  ).toEqual(["first", "second"]);
});

it("stdio 审核不显示以命令参数传入的常见密钥", async () => {
  const f = await fixture();
  if (f.config.type !== "stdio") throw new Error("expected stdio");
  await f.save({ ...f.config, args: [...f.config.args!, "--token", "secret-command-argument"] });
  expect((await f.authority.inspect()).probe!.display).not.toContain("secret-command-argument");
});

it("并发连接 mutation 串行收敛，避免新声明映射到旧连接", async () => {
  const f = await fixture();
  f.authority.allows = async () => true;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const raw = createMcpAdapter();
  raw.connectServer = async (_name, config) => {
    active++;
    peak = Math.max(peak, active);
    await barrier;
    active--;
    return {
      status: "connected",
      transport: config.type,
      toolCount: 0,
      updatedAt: new Date().toISOString(),
    };
  };
  const port = f.authority.guard(raw);
  const first = port.connectServer("probe", f.config);
  const second = port.connectServer("probe", f.config);
  await new Promise<void>((done) => setImmediate(done));
  release();
  await Promise.all([first, second]);
  expect(peak).toBe(1);
  await port.close();
});

it.each(["single", "configured"])("%s 准入未完成时，工具列表只查内存且默认拒绝", async (mode) => {
  const f = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const check = vi.spyOn(f.authority, "allows").mockImplementation(async () => {
    await barrier;
    return false;
  });
  const raw = createMcpAdapter();
  raw.listTools = async () => [{ serverName: "probe", toolName: "probe", inputSchema: {} }];
  const port = f.authority.guard(raw);
  const connecting =
    mode === "single"
      ? port.connectServer("probe", f.config)
      : port.connectConfiguredServers({ probe: f.config });
  try {
    await new Promise<void>((done) => setImmediate(done));
    const listing = port.listTools();
    await new Promise<void>((done) => setImmediate(done));
    release();
    expect(await listing).toEqual([]);
    expect(check).toHaveBeenCalledTimes(1);
    await connecting;
  } finally {
    release();
    await connecting;
    check.mockRestore();
    await port.close();
  }
});

it.each(["single", "configured"])("关闭 lease 后，迟到的 %s 准入结果不能启动连接", async (mode) => {
  const f = await fixture();
  let resolveAllowed!: (value: boolean) => void;
  f.authority.allows = () =>
    new Promise<boolean>((resolve) => {
      resolveAllowed = resolve;
    });
  const raw = createMcpAdapter();
  let connects = 0;
  raw.connectServer = async (_name, config) => {
    connects++;
    return {
      status: "connected",
      transport: config.type,
      toolCount: 0,
      updatedAt: new Date().toISOString(),
    };
  };
  raw.connectConfiguredServers = async () => {
    connects++;
    return { statuses: {}, tools: [] };
  };
  const port = f.authority.guard(raw);
  const pending = (
    mode === "single"
      ? port.connectServer("probe", f.config)
      : port.connectConfiguredServers({ probe: f.config })
  ).catch(() => undefined);
  await new Promise<void>((done) => setImmediate(done));
  resolveAllowed(true);
  queueMicrotask(() => {
    void port.close();
  });
  await pending;
  expect(connects).toBe(0);
});

it("HTTP URL、header 与 OAuth 凭据的变化都使原授权失效", async () => {
  const f = await fixture();
  const original: McpServerConfig = {
    type: "http",
    url: "https://mcp.example.test/one",
    headers: { Authorization: "first" },
    oauth: { type: "client_credentials", clientId: "client", clientSecret: "first" },
    source: { kind: "workspace" },
  };
  await f.save(original);
  const review = (await f.authority.inspect()).probe!;
  await f.authority.decide("probe", review.declarationDigest, true);
  for (const config of [
    { ...original, url: "https://mcp.example.test/two" },
    { ...original, headers: { Authorization: "second" } },
    {
      ...original,
      oauth: { type: "client_credentials" as const, clientId: "client", clientSecret: "second" },
    },
  ]) {
    await f.save(config);
    expect((await f.authority.inspect()).probe!.declarationDigest).not.toBe(
      review.declarationDigest,
    );
    expect(await f.authority.allows("probe", config)).toBe(false);
    expect(await f.authority.allows("probe", original)).toBe(false);
  }
});

it.each(["environment", "windows-command", "isolation"])(
  "审核与 Host DTO 对 %s 使用相同执行配置，真实字段变化仍拒绝",
  async (variant) => {
    const f = await fixture();
    const raw: HostMcpServerConfig = {
      type: "stdio",
      command: variant === "windows-command" ? "cmd" : "node",
      args: variant === "windows-command" ? ["/c", "npx", "example-mcp"] : ["server.mjs"],
      ...(variant === "environment" ? { environment: { EXAMPLE_TOKEN: "fake-value" } } : {}),
      ...(variant === "isolation" ? { isolation: "session" } : {}),
    };
    await writeFile(
      join(f.workspace, ".zcode/config.json"),
      JSON.stringify({ mcp: { servers: { probe: raw } } }),
    );
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      if (variant === "windows-command")
        Object.defineProperty(process, "platform", { value: "win32" });
      const review = (await f.authority.inspect()).probe;
      expect(review).toBeDefined();
      await f.authority.decide("probe", review!.declarationDigest, true);
      const dto = convertToZCodeAgentMcpServer("probe", raw, "workspace")!;
      const runtime = protocolMcpServersToRuntimeMcpConfig([dto])!.servers.probe!;
      if (variant === "environment")
        expect(runtime).toMatchObject({ env: { EXAMPLE_TOKEN: "fake-value" } });
      if (variant === "windows-command")
        expect(runtime).toMatchObject({ command: "npx", args: ["example-mcp"] });
      expect(await f.authority.allows("probe", runtime)).toBe(true);
      expect(
        await f.authority.allows("probe", { ...runtime, command: "different" } as McpServerConfig),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);

it("空项目 MCP map 使用 fallback；坏邻项不阻止有效声明审核", async () => {
  const f = await fixture();
  await writeFile(
    join(f.workspace, ".zcode/config.json"),
    JSON.stringify({ mcp: { servers: {} } }),
  );
  await mkdir(join(f.workspace, ".agents"));
  const { source: _source, ...config } = f.config;
  await writeFile(
    join(f.workspace, ".agents/mcp.json"),
    JSON.stringify({
      mcpServers: {
        probe: config,
        invalid: { command: "fake", description: "metadata not accepted by the execution schema" },
      },
    }),
  );
  const reviews = await f.authority.inspect();
  expect(Object.keys(reviews)).toEqual(["probe"]);
  await f.authority.decide("probe", reviews.probe!.declarationDigest, true);
  expect(await f.authority.allows("probe", f.config)).toBe(true);
  expect(await f.authority.allows("invalid", { type: "stdio", command: "fake" })).toBe(false);
  await f.save();
  expect(await f.authority.allows("probe", f.config)).toBe(false);
});

it("项目配置损坏时保留 headless 用户来源，工作区声明仍拒绝", async () => {
  const f = await fixture();
  await writeFile(
    f.options.userConfigPath,
    JSON.stringify({
      storage: { dir: join(f.root, "user-data") },
      mcp: { servers: { user_probe: { type: "stdio", command: "fake" } } },
    }),
  );
  await writeFile(join(f.workspace, ".zcode/config.json"), "{broken");
  const runtime = resolveAppRuntimeConfig({
    cliStorageRoot: join(f.root, "user-data"),
    configResult: createConfig(f.options),
    options: {},
    subagentOutputRootDir: join(f.root, "output"),
    workingDirectory: f.workspace,
  });
  expect(runtime.configuredMcpServers.user_probe?.source).toEqual({ kind: "user" });
  expect(await f.authority.allows("user_probe", runtime.configuredMcpServers.user_probe!)).toBe(
    true,
  );
  expect(await f.authority.inspect()).toEqual({});
  expect(await f.authority.allows("probe", f.config)).toBe(false);
});

it("未信任邻项和撤销均不能阻止 MCP App 订阅释放", async () => {
  const f = await fixture();
  const subscribers = new Set<string>();
  const raw = {
    async connectServer() {
      return {
        status: "connected",
        transport: "stdio",
        toolCount: 0,
        updatedAt: new Date().toISOString(),
      };
    },
    async disconnectServer() {},
    async subscribeResource(request: { subscriberKey: string }) {
      subscribers.add(request.subscriberKey);
    },
    async unsubscribeResourcesBySubscriber(prefix: string) {
      let released = 0;
      for (const key of subscribers)
        if (key.startsWith(prefix)) {
          subscribers.delete(key);
          released++;
        }
      return released;
    },
  } as unknown as McpPort;
  const port = f.authority.guard(raw);
  await port.connectServer("user", { type: "stdio", command: "fake", source: { kind: "user" } });
  await port.subscribeResource!({
    serverName: "user",
    uri: "example://resource",
    subscriberKey: "session|app|first",
  });
  await port.connectServer("probe", f.config);
  expect(await port.unsubscribeResourcesBySubscriber!("session|app|")).toBe(1);
  const digest = (await f.authority.inspect()).probe!.declarationDigest;
  await f.authority.decide("probe", digest, true);
  await port.connectServer("probe", f.config);
  await port.subscribeResource!({
    serverName: "probe",
    uri: "example://resource",
    subscriberKey: "session|app|second",
  });
  await f.authority.decide("probe", digest, false);
  expect(await port.unsubscribeResourcesBySubscriber!("session|app|")).toBe(1);
  expect(subscribers.size).toBe(0);
});

it("会话准入提示只包含启用且未信任的声明，授权与撤销刷新但不连接", async () => {
  const f = await fixture();
  const states: Array<{ pendingCount: number; bundleDigest: string; workspaceIdentity?: string }> =
    [];
  const authority = createWorkspaceMcpTrust({
    ...f.options,
    onAdmissionChanged: async (state) => {
      states.push(state);
    },
  });
  const port = authority.guard(createMcpAdapter());
  try {
    await port.refreshWorkspaceTrustAdmission!();
    await port.refreshWorkspaceTrustAdmission!();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ pendingCount: 1, workspaceIdentity: f.workspace });
    const firstDigest = states[0]!.bundleDigest;
    await port.refreshWorkspaceTrustAdmission!(true);
    expect(states).toHaveLength(2);
    await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
    await port.refreshWorkspaceTrustAdmission!();
    expect(states.at(-1)?.pendingCount).toBe(0);
    await expect(access(f.marker)).rejects.toThrow();
    await f.save({ ...f.config, env: { EXAMPLE: "changed" } });
    await port.refreshWorkspaceTrustAdmission!();
    expect(states.at(-1)?.pendingCount).toBe(1);
    expect(states.at(-1)?.bundleDigest).not.toBe(firstDigest);
    await f.save({ ...f.config, enabled: false });
    await port.refreshWorkspaceTrustAdmission!();
    expect(states.at(-1)?.pendingCount).toBe(0);
    expect(JSON.stringify(states)).not.toContain("changed");
    await port.close();
    const count = states.length;
    await port.refreshWorkspaceTrustAdmission!();
    expect(states).toHaveLength(count);
  } finally {
    await port.close();
  }
});

it("准入事件发布串行，授权后的刷新不会被旧 pending 结果覆盖", async () => {
  const f = await fixture();
  const publishing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const states: number[] = [];
  const port = createWorkspaceMcpTrust({
    ...f.options,
    onAdmissionChanged: async (state) => {
      if (states.length === 0) {
        publishing.resolve();
        await release.promise;
      }
      states.push(state.pendingCount);
    },
  }).guard(createMcpAdapter());
  try {
    const first = port.refreshWorkspaceTrustAdmission!();
    await publishing.promise;
    await f.authority.decide("probe", (await f.authority.inspect()).probe!.declarationDigest, true);
    const second = port.refreshWorkspaceTrustAdmission!();
    release.resolve();
    await Promise.all([first, second]);
    expect(states).toEqual([1, 0]);
  } finally {
    release.resolve();
    await port.close();
  }
});
