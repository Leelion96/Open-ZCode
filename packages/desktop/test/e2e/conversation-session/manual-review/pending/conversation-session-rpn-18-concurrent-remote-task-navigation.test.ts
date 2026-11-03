import { BufferReader, BufferWriter, deserialize, serialize, VSBuffer } from "@zcode/rpc";
import { join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  InternalChannels,
  PlatformChannels,
  ServiceChannels,
  buildRemoteHostWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import type { ProjectTree } from "@zcode/services";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { getToastMessages } from "#e2e/helpers/conversation-session-toast";
import {
  ensureProjectExpanded,
  selectRemoteProjectDirectory,
  startDraftFromProject,
} from "#e2e/helpers/project-sidebar";
import {
  callHandoffHost,
  installHandoffRpcProbe,
  restoreHandoffProbes,
} from "#e2e/helpers/remote-project-handoff-probe";
import {
  connectSSHWorkspace,
  prepareSSHConnectionPage,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E, waitForV4ConversationState } from "#e2e/helpers/v4-conversation";
import { selectTaskOrganizeMode } from "#e2e/helpers/workspace-agent-warmup";

// RPN-18（2026-10-20 用户日志回归）：Source 在线、窗口内没有项目 session 时点击远程任务，首连
// Provisioning 可达十几秒。期间再次点击曾导致：重复 connect 被 Main 拒绝（“尚无可用 renderer
// attachment”），旧点击在连接迟到成功后释放共享 session，最新点击也失败。
const CASE_MARKER = "E2E_RPN18_CONCURRENT_REMOTE_TASK_NAVIGATION";
const artifactDir = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/rpn-18-concurrent-remote-task-navigation",
);
const ERROR_TOAST = /Error:|renderer attachment|navigation-cancelled/u;
type Handler = (...args: unknown[]) => Promise<unknown>;
interface ConnectRemoteResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}
declare global {
  interface Window {
    __rpn18ScopedPorts?: Map<string, MessagePort>;
    __rpn18ScopedPortListener?: (event: MessageEvent) => void;
    __rpn18ConnectHostRequests?: { count: number; restore(): void };
  }
  var __rpn18ConnectProbe:
    | {
        calls: number;
        held: number;
        release(): void;
        restore(): void;
        duplicate(): Promise<unknown>;
      }
    | undefined;
}

/** 记录 renderer 收到的远程 scoped port，供用例在远端写入历史任务夹具（不发模型请求）。 */
async function captureScopedPorts() {
  await browser.execute((channel) => {
    const ports = new Map<string, MessagePort>();
    const listener = (event: MessageEvent) => {
      const data = event.data as { type?: string; workspaceIdentity?: string } | undefined;
      if (data?.type === channel && data.workspaceIdentity && event.ports[0])
        ports.set(data.workspaceIdentity, event.ports[0]);
    };
    window.__rpn18ScopedPorts = ports;
    window.__rpn18ScopedPortListener = listener;
    window.addEventListener("message", listener);
  }, InternalChannels.ScopedServicePort);
}

let fixtureRequestId = -18_000;
async function callRemoteFixture<T>(
  identity: string,
  channel: string,
  command: string,
  args: unknown[],
): Promise<T> {
  const id = fixtureRequestId--;
  const writer = new BufferWriter();
  serialize(writer, [100, id, channel, command]);
  serialize(writer, args);
  const prefixes = [201, 202, 203].map((type) => {
    const prefix = new BufferWriter();
    serialize(prefix, [type, id]);
    return Array.from(prefix.buffer.buffer);
  });
  const reply = await browser.execute(
    (workspaceIdentity, request, signatures) => {
      const port = window.__rpn18ScopedPorts?.get(workspaceIdentity);
      if (!port) throw new Error(`Scoped port unavailable: ${workspaceIdentity}`);
      return new Promise<number[]>((resolve) => {
        const receive = (event: MessageEvent) => {
          if (
            !(event.data instanceof Uint8Array) ||
            !signatures.some((prefix) => prefix.every((byte, index) => event.data[index] === byte))
          )
            return;
          port.removeEventListener("message", receive);
          resolve(Array.from(event.data));
        };
        port.addEventListener("message", receive);
        port.postMessage(Uint8Array.from(request));
      });
    },
    identity,
    Array.from(writer.buffer.buffer),
    prefixes,
  );
  const reader = new BufferReader(VSBuffer.wrap(Uint8Array.from(reply)));
  const header = deserialize(reader) as [number, number];
  const body = deserialize(reader);
  if (header[0] !== 201) throw new Error(typeof body === "string" ? body : body.message);
  return body as T;
}

/** 空 createSession 只是草稿；用公开历史导入在远端建立正式任务，不发送模型请求。 */
async function createRemoteHistoryTask(target: {
  workspacePath: string;
  workspaceIdentity: string;
  projectId: string;
}): Promise<string> {
  const created = await callRemoteFixture<{ session: { sessionId: string } }>(
    target.workspaceIdentity,
    ServiceChannels.ZCodeAgent,
    "createSession",
    [
      {
        ...target,
        persistence: "immediate",
        importedHistory: {
          source: "claudeCode",
          title: `${CASE_MARKER}${target.workspacePath}`,
          messages: [
            { role: "user", content: CASE_MARKER },
            { role: "assistant", content: "Fixture ready" },
          ],
        },
      },
    ],
  );
  const taskId = created.session.sessionId;
  await callRemoteFixture(target.workspaceIdentity, ServiceChannels.ZCodeTask, "resumeTask", [
    { taskId, workspacePath: target.workspacePath, workspaceIdentity: target.workspaceIdentity },
  ]);
  return taskId;
}

/**
 * 包装 Main 的 ConnectRemote：统计 renderer 发起次数；`hold` 时真实连接照常完成，只扣住返回结果，
 * 模拟首连 Provisioning 的长等待。`duplicate` 用第一次请求的窗口上下文、新 requestId 重放一次
 * 真实 ConnectRemote，模拟另一个入口在首连期间并发连接（不计入 renderer 次数）。
 */
async function installConnectProbe(options: { hold: boolean }) {
  await browser.electron.execute(
    (electron, channel, hold) => {
      globalThis.__rpn18ConnectProbe?.restore();
      const handlers = (electron.ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error("Remote connection handler is unavailable");
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstArgs: unknown[] | undefined;
      const probe = {
        calls: 0,
        held: 0,
        release,
        restore() {
          release();
          handlers.set(channel, original);
          delete globalThis.__rpn18ConnectProbe;
        },
        duplicate() {
          if (!firstArgs) throw new Error("No ConnectRemote request to replay");
          const [event, payload] = firstArgs;
          return original(event, {
            ...(payload as Record<string, unknown>),
            requestId: crypto.randomUUID(),
          });
        },
      };
      handlers.set(channel, async (...args) => {
        probe.calls++;
        firstArgs ??= args;
        const settled = await Promise.allSettled([original(...args)]);
        probe.held++;
        if (hold) await barrier;
        const [result] = settled;
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      globalThis.__rpn18ConnectProbe = probe;
    },
    PlatformChannels.ConnectRemote,
    options.hold,
  );
}

const connectProbe = () =>
  browser.electron.execute(() => ({
    calls: globalThis.__rpn18ConnectProbe?.calls ?? 0,
    held: globalThis.__rpn18ConnectProbe?.held ?? 0,
  }));

/** 统计侧栏导航发出的 connectHost 请求，作为“后续点击已走到连接阶段”的确定信号。 */
async function countConnectHostRequests() {
  await browser.execute((channel) => {
    const original = MessagePort.prototype.postMessage;
    const counter = {
      count: 0,
      restore() {
        MessagePort.prototype.postMessage = original;
        delete window.__rpn18ConnectHostRequests;
      },
    };
    MessagePort.prototype.postMessage = function (message: unknown, options?: unknown) {
      if (message instanceof Uint8Array) {
        const text = new TextDecoder().decode(message);
        if (text.includes(channel) && text.includes("connectHost")) counter.count++;
      }
      Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
    };
    window.__rpn18ConnectHostRequests = counter;
  }, ServiceChannels.RemoteProjects);
}

const connectHostRequests = () =>
  browser.execute(() => window.__rpn18ConnectHostRequests?.count ?? 0);

/** 本次运行的 Main 日志（含 Host 转发行），按文件名排序拼接。 */
async function readMainLogLines(): Promise<string[]> {
  const directory = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
  if (!directory) throw new Error(`${CASE_MARKER}: 缺少本次 Main 日志目录`);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".log")).sort();
  const contents = await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")));
  return contents.join("").split("\n");
}

async function waitForMainLog(
  fromLine: number,
  pattern: RegExp,
  timeoutMsg: string,
  timeout = 60_000,
): Promise<void> {
  await browser.waitUntil(
    async () => (await readMainLogLines()).slice(fromLine).some((line) => pattern.test(line)),
    { timeout, interval: 50, timeoutMsg },
  );
}

/** 关闭项目 tab 会释放窗口内的 logical session；等 Host 回到 0 个 session，下一次点击才会走完整首连。 */
async function closeWorkspaceTabs(identities: string[]) {
  const fromLine = (await readMainLogLines()).length;
  for (const identity of identities) {
    await browser.execute((workspaceIdentity) => {
      const store = (
        window as Window & {
          __zcodeTabStoreE2E?: {
            getState(): {
              tabs: Array<{ id: string; workspaceIdentity?: string }>;
              closeTab(id: string, origin?: "user-close"): void;
            };
          };
        }
      ).__zcodeTabStoreE2E;
      const tab = store
        ?.getState()
        .tabs.find((item) => item.workspaceIdentity === workspaceIdentity);
      if (!store || !tab) throw new Error(`Missing remote workspace tab: ${workspaceIdentity}`);
      store.getState().closeTab(tab.id, "user-close");
    }, identity);
    await browser.waitUntil(
      async () => (await readRemoteTabSnapshot(identity)).workspaceIdentity === null,
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 远程项目 tab 没有关闭 ${identity}` },
    );
  }
  await waitForMainLog(
    fromLine,
    /reason=remote-session-disposed, .*logicalSessions=0/u,
    `${CASE_MARKER}: 关闭 tab 后 Host 仍有 logical session`,
  );
}

/** 每个场景独立起步：关闭残留的项目 tab，并以 Host 最近一次拓扑确认窗口内没有 logical session。 */
async function resetRemoteTabs(identities: string[]) {
  const open: string[] = [];
  for (const identity of identities)
    if ((await readRemoteTabSnapshot(identity)).workspaceIdentity === identity) open.push(identity);
  if (open.length > 0) await closeWorkspaceTabs(open);
  const topology = (await readMainLogLines())
    .filter((line) => /window Host topology, reason=/u.test(line))
    .at(-1);
  expect(topology).toMatch(/logicalSessions=0/u);
}

async function expectNoErrorToasts() {
  expect((await getToastMessages()).filter((text) => ERROR_TOAST.test(text))).toEqual([]);
}

async function saveArtifact(name: string) {
  await mkdir(artifactDir, { recursive: true });
  await browser.saveScreenshot(join(artifactDir, name));
}

describe(`${CASE_MARKER}: 首次配置同步期间并发打开同设备下的远程任务`, () => {
  const projectA = { path: "", identity: "", taskId: "" };
  const projectB = { path: "", identity: "", taskId: "" };

  before(async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    [projectA.path, projectB.path] = config.workspacePaths as [string, string];
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await captureScopedPorts();
    const connected = await connectSSHWorkspace({
      caseMarker: CASE_MARKER,
      config,
      workspacePath: projectA.path,
    });
    if (!connected.workspaceIdentity) throw new Error(`${CASE_MARKER}: 项目 A 缺少 identity`);
    projectA.identity = connected.workspaceIdentity;
    const hostId = remoteHostIdFromWorkspaceIdentity(projectA.identity);
    if (!hostId) throw new Error(`${CASE_MARKER}: 无法从 identity 解析设备`);
    await installHandoffRpcProbe();
    await selectTaskOrganizeMode(["项目", "Project"]);

    // 同一设备上的第二个项目：Host 对未指定目录的连接按设备复用 session，跨项目连点共享同一连接。
    await $('[data-testid="project-section"]').moveTo();
    await $('[data-testid="virtual-project-add"]').click();
    await $('[data-testid="virtual-project-name"]').waitForDisplayed();
    await $('[data-testid="virtual-project-device"]').click();
    await $(`[role="option"][data-device-id=${JSON.stringify(hostId)}]`).click();
    await selectRemoteProjectDirectory(projectB.path);
    await $('[data-testid="virtual-project-name"]').setValue(projectB.path.split("/").at(-1)!);
    await $('[data-testid="virtual-project-save"]').click();
    await $('[data-testid="project-folder-trust-confirm"]').waitForDisplayed();
    await $('[data-testid="project-folder-trust-confirm"]').click();
    await ensureProjectExpanded(projectB.path);
    // 远程项目草稿按 workspace identity 记录；只传路径时 helper 会等错草稿键。
    projectB.identity = buildRemoteHostWorkspaceIdentity(hostId, projectB.path);
    await startDraftFromProject(projectB.path, { workspaceIdentity: projectB.identity });
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: projectB.identity,
      expectedPath: projectB.path,
    });

    const tree = await callHandoffHost<ProjectTree>(ServiceChannels.Project, "readTree", [
      { hostId },
    ]);
    for (const project of [projectA, projectB]) {
      const entry = tree.projects.find((item) =>
        item.roots.some((root) => root.rootPath === project.path),
      );
      if (!entry) throw new Error(`${CASE_MARKER}: 找不到远程项目 ${project.path}`);
      project.taskId = await createRemoteHistoryTask({
        workspacePath: project.path,
        workspaceIdentity: project.identity,
        projectId: entry.id,
      });
    }

    // 复现现场：Source 保持在线，只关闭项目 tab 释放窗口内的 logical session；
    // 不走主动断开，避免 Source 重新上线时的自动恢复混入额外连接。
    await closeWorkspaceTabs([projectA.identity, projectB.identity]);
    for (const project of [projectA, projectB]) {
      await ensureProjectExpanded(project.path);
      await $(`[data-testid="${testId(TID_TASK_ITEM, project.taskId)}"]`).waitForDisplayed({
        timeout: 30_000,
      });
    }
    await countConnectHostRequests();
  });

  afterEach(async function () {
    await browser.electron
      .execute(() => globalThis.__rpn18ConnectProbe?.restore())
      .catch(() => undefined);
    if (this.currentTest?.state !== "failed") return;
    const name = (this.currentTest.title.match(/^[\w-]+/u)?.[0] ?? "case").toLowerCase();
    await saveArtifact(`${name}-failure.png`);
    await writeFile(join(artifactDir, `${name}-failure.txt`), await $("body").getText());
  });

  after(async () => {
    await browser
      .execute(() => window.__rpn18ConnectHostRequests?.restore())
      .catch(() => undefined);
    await browser
      .execute(() => {
        if (window.__rpn18ScopedPortListener)
          window.removeEventListener("message", window.__rpn18ScopedPortListener);
      })
      .catch(() => undefined);
    await restoreHandoffProbes();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  /** 第一次点击完成真实连接后扣住结果，再点第二个任务；断言只连接一次且最新点击接管。 */
  async function clickTwiceDuringFirstConnect(first: typeof projectA, second: typeof projectA) {
    await installConnectProbe({ hold: true });
    const requestsBefore = await connectHostRequests();
    await clickTestIdByDom(testId(TID_TASK_ITEM, first.taskId));
    await browser.waitUntil(async () => (await connectProbe()).held === 1, {
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: 第一次点击没有完成真实连接`,
    });
    await clickTestIdByDom(testId(TID_TASK_ITEM, second.taskId));
    await browser.waitUntil(async () => (await connectHostRequests()) >= requestsBefore + 2, {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: 第二次点击没有走到连接阶段`,
    });
    // 负向观察窗口：旧实现会在 connectHost 返回后立即再发一次 ConnectRemote。
    await browser.pause(2_000);
    expect((await connectProbe()).calls).toBe(1);

    await browser.electron.execute(() => globalThis.__rpn18ConnectProbe?.release());
    const opened = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: second.identity,
      expectedPath: second.path,
    });
    expect(opened.remoteSessionId).toBeTruthy();
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === second.taskId,
      `${CASE_MARKER}: 最后点击的任务没有打开`,
      60_000,
    );
    return opened;
  }

  it("RPN-18a 首连期间连点同一任务：只连接一次、无错误提示，任务打开且连接不被旧点击释放", async function () {
    this.timeout(10 * 60_000);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    const opened = await clickTwiceDuringFirstConnect(projectA, projectA);
    await saveArtifact("rpn-18a-task-opened.png");
    // 旧实现会在这里由被替代的点击释放共享 session；保持一段时间确认 session 不被回收。
    await browser.pause(3_000);
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBe(
      opened.remoteSessionId,
    );
    expect((await connectProbe()).calls).toBe(1);
    await expectNoErrorToasts();
  });

  it("RPN-18b 首连期间先点 A 项目再点同设备 B 项目：只连接一次，B 打开且连接不被 A 释放", async function () {
    this.timeout(10 * 60_000);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    const opened = await clickTwiceDuringFirstConnect(projectA, projectB);
    await saveArtifact("rpn-18b-task-opened.png");
    await browser.pause(3_000);
    expect((await readRemoteTabSnapshot(projectB.identity)).remoteSessionId).toBe(
      opened.remoteSessionId,
    );
    // 被替代的 A 不能借共享连接绑定自己的目录。
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBeNull();
    expect((await connectProbe()).calls).toBe(1);
    await expectNoErrorToasts();
  });

  it("DRS-RR-11 首连 Provisioning 期间另一入口 join 同一 session：等待同一结果，不报尚无 attachment", async function () {
    this.timeout(10 * 60_000);
    await resetRemoteTabs([projectA.identity, projectB.identity]);
    await installConnectProbe({ hold: false });
    const fromLine = (await readMainLogLines()).length;
    await clickTestIdByDom(testId(TID_TASK_ITEM, projectA.taskId));
    // Host 已回报连接 = Main route 已建立，首次同步与首个 attachment 尚未完成。
    await waitForMainLog(
      fromLine,
      /window Host topology, reason=remote-connected/u,
      `${CASE_MARKER}: 第一次点击没有建立远程连接`,
      120_000,
    );
    const duplicate = (await browser.electron.execute(
      async () => await globalThis.__rpn18ConnectProbe?.duplicate(),
    )) as ConnectRemoteResult;
    expect(duplicate).toMatchObject({ success: true });

    const opened = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: projectA.identity,
      expectedPath: projectA.path,
    });
    expect(duplicate.sessionId).toBe(opened.remoteSessionId);
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === projectA.taskId,
      `${CASE_MARKER}: 任务没有打开`,
      60_000,
    );
    await saveArtifact("drs-rr-11-task-opened.png");

    // 证据边界：重复 connect 的 join 必须早于首次同步完成，否则没有命中“尚无 attachment”窗口。
    const lines = (await readMainLogLines()).slice(fromLine);
    const connected = lines.flatMap((line, index) =>
      /window Host topology, reason=remote-connected/u.test(line) ? [index] : [],
    );
    const synced = lines.findIndex((line) =>
      /\[provider-provisioning\] Environment sync completed/u.test(line),
    );
    expect(connected.length).toBeGreaterThanOrEqual(2);
    if (synced < 0 || connected[1]! > synced) {
      throw new Error(`${CASE_MARKER}: 重复 connect 晚于首次同步完成，未命中首连窗口，结论无效`);
    }
    expect(lines.some((line) => /尚无可用 renderer attachment/u.test(line))).toBe(false);
    await browser.pause(3_000);
    expect((await readRemoteTabSnapshot(projectA.identity)).remoteSessionId).toBe(
      opened.remoteSessionId,
    );
    await expectNoErrorToasts();
  });
});
