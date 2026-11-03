import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteAgentProcesses,
} from "#e2e/helpers/ssh-remote-lifecycle";

const state = vi.hoisted(() => {
  const sent: Array<{ identity: string; model: string }> = [];
  return {
    identity: "",
    model: "local-default",
    localDraftCreations: 0,
    remoteIdentity: "remote:server:fixture:/work",
    sent,
    runSSHCommand: vi.fn(),
  };
});

vi.mock("#e2e/helpers/project-sidebar", () => ({}));
vi.mock("#e2e/helpers/desktop-app", () => ({ waitForWorkspaceApp: vi.fn() }));
vi.mock("#e2e/helpers/custom-openai-provider", () => ({}));
vi.mock("#e2e/helpers/upstream-provider", () => ({
  selectUpstreamProviderModelById: async (model: string) => {
    state.model = model;
  },
  selectUpstreamThoughtLevelValue: vi.fn(),
}));
vi.mock("#e2e/helpers/conversation-session-network", () => ({
  getUpstreamRequestRecordCount: async () => state.sent.length,
  waitForUpstreamRequest: vi.fn(),
}));
vi.mock("#e2e/helpers/v4-conversation", () => ({
  // 全局新建按产品合同切换到本地未分类任务，不能冒充远程项目内新建。
  startNewV4Draft: async () => {
    state.localDraftCreations += 1;
    state.identity = "";
    state.model = "local-default";
  },
  sendV4PromptAndWaitAccepted: async () => {
    state.sent.push({ identity: state.identity, model: state.model });
  },
  waitForV4ConversationState: async (predicate: (value: unknown) => boolean) => {
    const snapshot = {
      taskId: state.identity ? "remote-task" : "local-task",
      state: "idle",
      queueCount: 0,
    };
    expect(predicate(snapshot)).toBe(true);
    return snapshot;
  },
  waitForV4AssistantMessageContaining: vi.fn(),
}));
vi.mock("#e2e/helpers/ssh-remote-p0", () => ({
  SSH_WORKSPACE_READY_TIMEOUT_MS: 1_000,
  runSSHCommand: (...args: unknown[]) => state.runSSHCommand(...args),
  clickLastEnabledSSHDialogButton: vi.fn(),
  fillSSHPasswordSettings: vi.fn(),
  openSSHRemoteDialog: vi.fn(),
  ensureSSHProjectDirectoryStep: vi.fn(),
  selectSSHRemoteDirectory: async () => {
    state.identity = state.remoteIdentity;
  },
  waitForRemoteTab: async () => ({
    remoteKind: "ssh",
    remoteHost: "127.0.0.1",
    remoteSessionId: "attachment",
    secretPersistedInTab: false,
    workspaceIdentity: state.remoteIdentity,
  }),
  readRemoteTabSnapshot: async () => ({
    activeWorkspaceIdentity: state.identity || null,
    activeWorkspacePath: state.identity ? "/work" : "/local",
  }),
}));

beforeEach(() => {
  vi.stubGlobal("expect", expect);
  state.identity = "";
  state.model = "local-default";
  state.localDraftCreations = 0;
  state.sent.length = 0;
});

afterEach(() => vi.unstubAllGlobals());

it("远程项目首发保留新建项目草稿和已选模型，不跳到全局本地任务", async () => {
  const task = await connectSSHWorkspaceAndSendFirstTurn({
    caseMarker: "E2E_REMOTE_DRAFT",
    config: { host: "127.0.0.1", port: 43210, username: "dev", password: "fixture" },
    label: "A",
    workspacePath: "/work",
    provider: {
      id: "fixture-provider",
      name: "Fixture provider",
      tunnel: { baseURL: "http://127.0.0.1:43211", close: async () => {} },
    },
  });
  expect(state.sent).toEqual([
    { identity: state.remoteIdentity, model: "e2e-ssh-remote-lifecycle-model" },
  ]);
  expect(task.taskId).toBe("remote-task");
  expect(task.identity).toBe(state.remoteIdentity);
  expect(state.localDraftCreations).toBe(0);
});

it("冷恢复只终止 Core 所属 Agent，不把查询 shell 或插件进程当成 Agent", async () => {
  const ps = [
    "146 135 /runtime/node /runtime/server-core.js 1",
    "174 146 zcode-cli",
    "180 146 /runtime/node /runtime/zcode.cjs app-server --stdio",
    "236 174 zcode-cli",
    "316 314 sh -c ps -eo pid,args | awk '/app-server --stdio/'",
  ].join("\n");
  const detailCommands: string[] = [];
  state.runSSHCommand.mockImplementation(async (_config, command: string) => {
    if (command === "ps -eo pid=,ppid=,args=") return { code: 0, stdout: ps, stderr: "" };
    detailCommands.push(command);
    // 真实进程快照：旧正则仅匹配到查询 shell；新路径须按已验证的 PID 读取 /proc。
    const pids = command
      .match(/^for pid in ([\d ]+);/)?.[1]
      ?.trim()
      .split(" ") ?? ["316"];
    return {
      code: 0,
      stdout: pids.map((pid) => `${pid}\t146\t1000\t/home/dev`).join("\n"),
      stderr: "",
    };
  });
  expect(
    await listRemoteAgentProcesses({
      host: "127.0.0.1",
      port: 22,
      username: "dev",
      password: "fixture",
    }),
  ).toEqual([
    { pid: 174, ppid: 146, startTicks: 1000, cwd: "/home/dev" },
    { pid: 180, ppid: 146, startTicks: 1000, cwd: "/home/dev" },
  ]);
  expect(detailCommands).toHaveLength(1);
});
