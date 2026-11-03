import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompactTrigger,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  ModelErrorCode,
  type ContextSourcePort,
  type ContextSourceRequest,
  type ModelRequest,
  type ModelResult,
  type SkillPort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import type { AgentDefinitionsSnapshot } from "../src/subagent/definitions.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { systemReminderAttachmentEntry } from "../src/agent/message-history.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  buildCompactLeadingAnnouncements,
  buildRequestAnnouncements,
  restateContextAfterCompact,
} from "../src/runtime/methods/context-refresh.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../src/runtime/types.js";
import { formatWorkflowStallNotification } from "../src/runtime-task/workflow-notification-copy.js";

const snapshot = (...names: string[]): AgentDefinitionsSnapshot => ({
  activeAgents: names.map((name) => ({
    name,
    description: `Description ${name}`,
    source: "user",
    systemPrompt: "private",
  })),
});
const result = {
  finishReason: "stop" as const,
  text: "Summary of current work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};
let sessionId: ReturnType<typeof createSessionId>;
let store: ReturnType<typeof createRecordingMessageStore>;
let requests: ModelRequest[];
const definitions = vi.fn(() => snapshot("A"));
const respond = vi.fn<(request: ModelRequest) => Promise<ModelResult>>();
let runtime: ReturnType<typeof createTestAgentRuntime>;

function createRuntime(
  deps: Partial<AgentRuntimeDeps> = {},
  config: Partial<AgentRuntimeConfig> = {},
  { mcs = true, fold = false }: { mcs?: boolean; fold?: boolean } = {},
) {
  const modelFactory = createTestModelFactory({
    properties: { supportsMidConversationSystem: mcs },
    generateText: async (request) => {
      requests.push(request);
      return respond(request);
    },
  });
  return createTestAgentRuntime(
    sessionId,
    { mode: "yolo", compact: { enabled: false }, titleGeneration: { enabled: false }, ...config },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as never,
      getAgentDefinitions: definitions,
      modelFactory: fold
        ? (input) => ({
            ...modelFactory(input),
            requestCapabilities: { foldRemindersIntoToolResults: true },
          })
        : modelFactory,
      ...deps,
    },
  );
}
const entries = () =>
  (runtime as unknown as AgentRuntimeInternal).messageHistory.toRuntimeEntries();
const compact = (value: ReturnType<typeof createTestAgentRuntime>, trigger?: CompactTrigger) =>
  (value as unknown as AgentRuntimeInternal).compactActiveConversation(
    undefined,
    createRootTraceContext({ sessionId }),
    [],
    { trigger },
  );

beforeEach(() => {
  sessionId = createSessionId();
  store = createRecordingMessageStore();
  requests = [];
  definitions.mockReset().mockImplementation(() => snapshot("A"));
  respond.mockReset().mockResolvedValue(result);
  runtime = createRuntime();
});

const skillPort: SkillPort = {
  async discoverSkills() {
    return {
      skills: [
        {
          name: "search",
          description: "search things",
          path: "/workspace/.agents/skills/search/SKILL.md",
          directory: "/workspace/.agents/skills/search",
          rootPath: "/workspace/.agents/skills",
          scope: "project" as const,
          source: "agents" as const,
          safeToAutoLoad: true,
          frontmatterKeys: [],
        },
      ],
      diagnostics: [],
      totalDiscovered: 1,
    };
  },
  async loadSkill() {
    throw new Error("not needed");
  },
};

describe("runtime context announcements", () => {
  // 顺序即宣告顺序：environment → model → (agent listing) → skills → instructions → git → date。
  const sources = new Set([
    "environment",
    "model",
    "skills_listing",
    "context_prefix",
    "session_context",
    "date",
  ]);
  // 动态公告按隐藏提醒落盘：类型只记在 runtimeMessage.source，不写顶层 source。
  const runtimeSourceOf = (message: { metadata?: Record<string, unknown> }) =>
    (message.metadata?.runtimeMessage as { source?: string } | undefined)?.source;
  const isAnnouncementRecord = (message: {
    semantics?: { kind?: string };
    metadata?: Record<string, unknown>;
  }) =>
    message.semantics?.kind === "system_reminder" && sources.has(runtimeSourceOf(message) ?? "");
  const contextEntries = (value: ReturnType<typeof createTestAgentRuntime>) =>
    (value as unknown as AgentRuntimeInternal).messageHistory
      .toRuntimeEntries()
      .filter((entry) => entry.kind === "attachment" && sources.has(entry.metadata.source));
  const config: Partial<AgentRuntimeConfig> = {
    workingDirectory: "/workspace",
    currentDate: "2026-10-14",
    envInfo: {
      cwd: "/workspace",
      platform: "linux",
      shell: "bash",
      osVersion: "Linux",
      nodeVersion: "24",
      isGitRepository: true,
      gitStatus: "clean",
      gitBranch: "original",
    },
  };
  const now = () => new Date(2026, 9, 14, 12);
  const instructionsPort = (): ContextSourcePort => ({
    async resolveEnvironment() {
      return config.envInfo!;
    },
    async resolveGitContext() {
      return config.envInfo!;
    },
    async resolveContextSources() {
      return {
        workingDirectory: "/workspace",
        envInfo: config.envInfo!,
        userInstructions: {
          filePath: "/workspace/AGENTS.md",
          fileName: "AGENTS.md",
          content: "Project rule.",
          bytesRead: 13,
          sizeBytes: 13,
          truncated: false,
        },
        diagnostics: [],
      };
    },
  });
  const environmentPort = () =>
    ({
      async resolveContextSources() {
        return { workingDirectory: "/workspace", envInfo: config.envInfo!, diagnostics: [] };
      },
      resolveEnvironment: vi.fn(
        async ({
          workingDirectory,
          effectiveShellDisplayName,
        }: Pick<ContextSourceRequest, "workingDirectory" | "effectiveShellDisplayName">) => ({
          ...config.envInfo!,
          cwd: workingDirectory,
          shell: effectiveShellDisplayName ?? config.envInfo!.shell,
          isGitRepository: workingDirectory.startsWith("/workspace"),
        }),
      ),
    }) satisfies ContextSourcePort;

  // 把当前 store 复制成独立的冷存储，再从中恢复一个新 runtime。
  const coldRuntimeWith = async (
    port: SkillPort = skillPort,
    coldConfig: Partial<AgentRuntimeConfig> = config,
    coldDeps: Partial<AgentRuntimeDeps> = {},
  ) => {
    const recording = createRecordingMessageStore();
    // rewind 只需把分支信息写回会话；录制 store 没有 setRevert，用 updateSession 承接。
    const coldStore = Object.assign(recording, {
      async setRevert(input: { sessionID: string; revert: unknown }) {
        await recording.updateSession({ id: input.sessionID, revert: input.revert });
      },
    });
    await coldStore.createSession(await store.getSession(sessionId));
    coldStore.savedMessages.push(...structuredClone(store.savedMessages));
    coldStore.savedParts.push(...structuredClone(store.savedParts));
    const cold = createRuntime(
      {
        now,
        skillPort: port,
        contextSourcePort: instructionsPort(),
        sessionStore: coldStore as never,
        ...coldDeps,
      },
      coldConfig,
    );
    await cold.resumeFromStore();
    return { cold, coldStore };
  };

  it("announces environment and model for a custom system prompt", async () => {
    runtime = createRuntime(
      { now, contextSourcePort: environmentPort() },
      { ...config, systemPrompt: "Host override." },
    );
    await runtime.executeTurn("first task");
    // 自定义 prompt 只替换 system 正文，环境与模型公告照常发送；Git 仍不发。
    expect(contextEntries(runtime).map((entry) => entry.metadata?.source)).toEqual([
      "environment",
      "model",
      "date",
    ]);
    expect(String(requests[0]!.messages[1]!.content)).toBe("\nHost override.");
  });

  it.each([false, true])(
    "uses shared environment/model lifecycle for a specialized child (MCS=%s)",
    async (mcs) => {
      const contextSourcePort = environmentPort();
      const resolveContextSources = vi.spyOn(contextSourcePort, "resolveContextSources");
      const childConfig: Partial<AgentRuntimeConfig> = {
        ...config,
        taskType: "subagent_child",
        subagentContext: { agentPrompt: "Dedicated child identity." },
        subagents: { enabled: false },
      };
      runtime = createRuntime({ now, contextSourcePort }, childConfig, { mcs });
      await runtime.executeTurn("first child task");
      const initial = contextEntries(runtime);
      expect(initial.map((entry) => entry.metadata?.source)).toEqual([
        "environment",
        "model",
        "date",
      ]);
      expect(
        requests[0]?.messages.find((message) => String(message.content).includes("# Environment\n"))
          ?.role,
      ).toBe(mcs ? "system" : "user");
      const initialBody = requests[0]!.messages[1]!.content;
      runtime.setWorkingDirectory("/outside");
      const nextSelection = createTestModelSelection("test/child-next");
      runtime.setSessionModelSelection(nextSelection);
      await runtime.executeTurn("second child task");
      const changed = contextEntries(runtime);
      expect(
        changed.filter((entry) => entry.metadata?.source === "environment").at(-1),
      ).toMatchObject({
        content:
          "# Environment update\n - Primary working directory: /outside (was /workspace)\n - Is a git repository: false (was true)",
      });
      expect(changed.filter((entry) => entry.metadata?.source === "model").at(-1)).toMatchObject({
        content: "You are powered by the model named test/child-next.",
      });
      await runtime.executeTurn("unchanged child task");
      expect(contextEntries(runtime)).toEqual(changed);
      expect(requests.at(-1)!.messages[1]!.content).toEqual(initialBody);
      // child 初始快照只用父级传下的配置；端口只用于 cd 之后的环境探测。
      expect(resolveContextSources).not.toHaveBeenCalled();
      expect(contextSourcePort.resolveEnvironment).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "orders the first user turn by attachment collection order (MCS=%s)",
    async (mcs) => {
      runtime = createRuntime(
        { now, skillPort, contextSourcePort: instructionsPort() },
        { ...config, outputStyle: { name: "Learning", prompt: "Explain tradeoffs." } },
        { mcs },
      );
      await runtime.executeTurn("first");
      // 先产出全部输入附件（含每次收集的 output_style），请求前公告在其后，最后是本轮输入。
      const markers = [
        ["environment", "# Environment"],
        ["model", "You are powered by"],
        ["output_style_instructions", "# Output Style: Learning"],
        ["agents", "Available agent types"],
        ["skills", "The following skills"],
        ["output_style", "Learning output style is active"],
        ["instructions", "Codebase and user instructions"],
        ["session_context", "As you answer"],
        ["date", "Today's date is"],
      ] as const;
      const messages = requests[0]!.messages.filter((message) => message.role !== "system");
      const userTexts = messages.map((message) => String(message.content));
      const promptIndex = userTexts.indexOf("first");
      const kinds = userTexts.slice(0, promptIndex).map((text) => {
        const body = text.replace(/^<system-reminder>\n/u, "");
        return markers.find(([, marker]) => body.startsWith(marker))?.[0];
      });
      const userSide = ["instructions", "session_context"];
      expect(kinds).toEqual(mcs ? userSide : markers.map(([kind]) => kind));
      if (mcs) {
        // MCS 下其余公告在 user run 末尾合成一条 system，顺序不变，user 侧没有 skill 列表。
        const system = requests[0]!.messages.at(-1)!;
        expect(system.role).toBe("system");
        const positions = markers
          .filter(([kind]) => !userSide.includes(kind))
          .map(([, marker]) => String(system.content).indexOf(marker));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(userTexts.some((text) => text.includes("search things"))).toBe(false);
      }
      // 默认测试模型不合并相邻 user，紧挨输入的那一块也不补换行。
      expect(userTexts.slice(0, promptIndex).every((text) => !text.endsWith("\n"))).toBe(true);
    },
  );

  it("ends only the block right before the first input with a newline when the model merges adjacent user content", async () => {
    // 声明合并相邻 user 内容（foldRemindersIntoToolResults）时，紧挨输入的那一块以换行结尾，其余块不补。
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config, {
      mcs: false,
      fold: true,
    });
    await runtime.executeTurn("first");
    const userTexts = requests[0]!.messages
      .filter((message) => message.role !== "system")
      .map((message) => String(message.content));
    const promptIndex = userTexts.indexOf("first");
    expect(promptIndex).toBeGreaterThan(1);
    expect(userTexts[promptIndex - 1]).toMatch(/<\/system-reminder>\n$/u);
    expect(userTexts.slice(0, promptIndex - 1).every((text) => !text.endsWith("\n"))).toBe(true);
  });

  describe("turns started by a notification", () => {
    const marker = "NOTIFICATION_MARKER";
    const startTurn = {
      task_notification: () =>
        (runtime as any).enqueueBackgroundTaskNotification({
          text: `<task-notification><task-id>${marker}</task-id><status>completed</status></task-notification>`,
          traceContext: createRootTraceContext({ sessionId }),
        }),
      subagent_reply: () =>
        (runtime as any).enqueueSubagentMessage({
          responseId: "response",
          agentId: "agent",
          agentType: "general-purpose",
          childSessionId: createSessionId(),
          childToolCallId: "child-call",
          summary: "progress",
          message: marker,
          traceContext: createRootTraceContext({ sessionId }),
        }),
    };
    const contextMarkers = [
      "# Environment",
      "You are powered by",
      "Available agent types",
      "The following skills",
      "Codebase and user instructions",
      "Today's date is",
    ];
    const waitForRequests = (count: number) =>
      vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(count));
    const requestText = (request: ModelRequest) =>
      request.messages.map((message) => JSON.stringify(message.content)).join("\n");
    const createNotifiedRuntime = (mcs: boolean, deps: Partial<AgentRuntimeDeps> = {}) =>
      createRuntime({ now, skillPort, contextSourcePort: instructionsPort(), ...deps }, config, {
        mcs,
      });

    it.each([
      ["task_notification", false],
      ["task_notification", true],
      ["subagent_reply", false],
      ["subagent_reply", true],
    ] as const)(
      "skips input attachments but keeps request announcements on the first %s request (MCS=%s)",
      async (input, mcs) => {
        runtime = createNotifiedRuntime(mcs);
        await runtime.ensureSessionPersistedForExternalActivity("initial session");
        startTurn[input]();
        await waitForRequests(1);

        const messages = requests[0]!.messages;
        const indexOf = (text: string) =>
          messages.findIndex((message) => JSON.stringify(message.content).includes(text));
        const notificationIndex = indexOf(marker);
        expect(messages[notificationIndex]!.role).toBe("user");
        // 跳过附件时只跳过输入附件；请求前公告照常运行。
        for (const contextMarker of contextMarkers.slice(0, 4)) {
          expect(requestText(requests[0]!)).not.toContain(contextMarker);
        }
        // 公告冒泡到通知之前；MCS 文本落在 user run 末尾。
        expect(indexOf("Codebase and user instructions")).toBeLessThan(notificationIndex);
        if (mcs) {
          expect(messages.at(-1)!.role).toBe("system");
          expect(indexOf("Today's date is")).toBe(messages.length - 1);
        } else {
          expect(indexOf("Today's date is")).toBeLessThan(notificationIndex);
          expect(notificationIndex).toBe(messages.length - 1);
        }
        expect(contextEntries(runtime).map((entry) => entry.metadata.source)).toEqual(
          expect.arrayContaining(["context_prefix", "date"]),
        );
        expect(
          contextEntries(runtime).some((entry) =>
            ["environment", "model", "skills_listing"].includes(entry.metadata.source),
          ),
        ).toBe(false);
      },
    );

    // 修复原因：空闲整批原来存成一个 "\n\n" 连接的字符串，投影时再按 <task-notification> 开头猜边界；
    // workflow 运行中通知不以它开头，被并进前一条通知的包装。现在每条通知是同一条消息的一个文本块，
    // 整条消息一个事务写入，冷恢复保留这些块，live 与冷恢复发出的块逐字节相同。
    it.each([true, false])(
      "keeps each notification of an idle batch in its own block live and after a cold resume (MCS=%s)",
      async (mcs) => {
        const bundles: { messages: { info: { source?: string }; parts: unknown[] }[] }[] = [];
        Object.assign(store, {
          async commitMessageBundle(bundle: (typeof bundles)[number]) {
            bundles.push(structuredClone(bundle));
            for (const message of bundle.messages) {
              store.savedMessages.push(message.info);
              store.savedParts.push(...message.parts);
            }
          },
        });
        let releaseFirst!: () => void;
        const firstHeld = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        respond.mockImplementationOnce(async () => {
          await firstHeld;
          return result;
        });
        runtime = createNotifiedRuntime(mcs);
        await runtime.ensureSessionPersistedForExternalActivity("initial session");
        const enqueue = (text: string) =>
          (runtime as any).enqueueBackgroundTaskNotification({
            text,
            traceContext: createRootTraceContext({ sessionId }),
          });
        const stall = formatWorkflowStallNotification({
          runLabel: "wf",
          runId: "run_1",
          sinceMs: 600000,
        });
        enqueue("<task-notification><task-id>first</task-id></task-notification>");
        await waitForRequests(1);
        // 第一条通知的请求进行中到达的两条，在下一次空闲时成为同一批。
        enqueue("<task-notification><task-id>bash-1</task-id></task-notification>");
        enqueue(stall);
        releaseFirst();
        await waitForRequests(2);
        await vi.waitFor(() => expect(runtime.getActiveTurnInfo()).toBeUndefined());

        const batchMessage = (request: ModelRequest) =>
          request.messages.find(
            (message) =>
              message.role === "user" &&
              Array.isArray(message.content) &&
              JSON.stringify(message.content).includes("bash-1"),
          );
        const live = batchMessage(requests[1]!)!;
        const blocks = live.content as { type: string; text: string }[];
        expect(blocks.map((block) => block.type)).toEqual(["text", "text"]);
        expect(blocks[0]!.text).toMatch(
          /^<system-reminder>\n\[SYSTEM NOTIFICATION - NOT USER INPUT\]/u,
        );
        expect(blocks[0]!.text).toContain("bash-1");
        expect(blocks[0]!.text).not.toContain("workflow-stall");
        expect(blocks[0]!.text.endsWith("</system-reminder>\n")).toBe(true);
        expect(blocks[1]!.text).toContain("<workflow-stall>");
        expect(blocks[1]!.text.endsWith("</system-reminder>")).toBe(true);
        // 一个事务写入一条消息、两个 part。
        const batchBundles = bundles.filter((bundle) =>
          bundle.messages.some((message) => message.info.source === "background_task"),
        );
        expect(batchBundles.map((bundle) => bundle.messages.map((m) => m.parts.length))).toEqual([
          [2],
        ]);

        const coldStore = createRecordingMessageStore();
        await coldStore.createSession(await store.getSession(sessionId));
        coldStore.savedMessages.push(...structuredClone(store.savedMessages));
        coldStore.savedParts.push(...structuredClone(store.savedParts));
        const cold = createRuntime(
          {
            now,
            skillPort,
            contextSourcePort: instructionsPort(),
            sessionStore: coldStore as never,
          },
          config,
          { mcs },
        );
        await cold.resumeFromStore();
        await cold.executeTurn("after resume");
        expect(batchMessage(requests.at(-1)!)?.content).toEqual(live.content);
      },
    );

    it("collects the skipped context after a tool result in the same turn", async () => {
      const registry = createToolRegistry();
      registry.register({
        inputSchema: {},
        metadata: {
          name: "Probe",
          concurrentSafe: true,
          destructive: false,
          needsApproval: false,
          readOnly: true,
          riskLevel: "low",
          sideEffectScope: "none",
        },
        handler: async () => "probed",
      });
      runtime = createNotifiedRuntime(false, { toolRegistry: registry });
      respond.mockResolvedValueOnce({
        ...result,
        text: "",
        finishReason: "tool-calls",
        toolCalls: [{ id: "probe", name: "Probe", input: {} }],
      });
      await runtime.ensureSessionPersistedForExternalActivity("initial session");
      startTurn.task_notification();
      await waitForRequests(2);

      const texts = requests[1]!.messages.map((message) => JSON.stringify(message.content));
      const notificationIndex = texts.findIndex((text) => text.includes(marker));
      const toolIndex = requests[1]!.messages.findIndex((message) => message.role === "tool");
      const environmentIndex = texts.findIndex((text) => text.includes("# Environment"));
      expect(notificationIndex).toBeLessThan(toolIndex);
      expect(environmentIndex).toBeGreaterThan(toolIndex);
    });

    it("keeps the plan-mode exit reminder pending for the next collected request", async () => {
      runtime = createNotifiedRuntime(false);
      (runtime as unknown as AgentRuntimeInternal).needsPlanModeExitReminder = true;
      await runtime.ensureSessionPersistedForExternalActivity("initial session");
      startTurn.task_notification();
      await waitForRequests(1);
      await vi.waitFor(() => expect(runtime.getActiveTurnInfo()).toBeUndefined());

      const planExit = () =>
        entries().filter((entry) => entry.metadata?.source === "plan_mode_exit");
      expect(planExit()).toHaveLength(0);
      expect((runtime as unknown as AgentRuntimeInternal).needsPlanModeExitReminder).toBe(true);

      await runtime.executeTurn("next");
      expect((runtime as unknown as AgentRuntimeInternal).needsPlanModeExitReminder).toBe(false);
      expect(planExit()).toHaveLength(1);
    });
  });

  it("announces output style instructions after the model once per change and resets when cleared", async () => {
    runtime = createRuntime(
      { now, skillPort },
      { ...config, outputStyle: { name: "Learning", prompt: "Explain tradeoffs.\n" } },
    );
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    runtime.updateConfig({ outputStyle: { name: "Learning", prompt: "Explain briefly." } });
    await runtime.executeTurn("third");
    runtime.updateConfig({ outputStyle: undefined });
    await runtime.executeTurn("fourth");
    await runtime.executeTurn("fifth");
    const attachments = entries().filter((entry) => entry.kind === "attachment");
    expect(
      attachments
        .filter((entry) => entry.metadata.source === "output_style_instructions")
        .map((entry) => entry.content),
    ).toEqual([
      "# Output Style: Learning\nExplain tradeoffs.",
      "# Output Style: Learning\nExplain briefly.",
      "The output style was reset to the default. Respond in your usual style.",
    ]);
    // 输入附件顺序：environment → model → output style 指令。
    const order = attachments.map((entry) => entry.metadata.source);
    expect(order.indexOf("output_style_instructions")).toBe(order.indexOf("model") + 1);
    // system 不再携带 output style 指令。
    expect(
      JSON.stringify(requests[0]!.messages.slice(0, 3).map((message) => message.content)),
    ).not.toContain("# Output Style");
  });

  it("restates the latest output style after compact unless the kept tail has one or it was reset", () => {
    runtime = createRuntime({ now, skillPort }, config);
    const internal = runtime as unknown as AgentRuntimeInternal;
    // output style 的重述不受 env_info 门控。
    internal.latestContextBuildResult = { sections: [] } as never;
    const style = systemReminderAttachmentEntry(
      "output_style_instructions",
      "# Output Style: Learning\nExplain tradeoffs.",
    );
    const reset = systemReminderAttachmentEntry(
      "output_style_instructions",
      "The output style was reset to the default. Respond in your usual style.",
    );
    expect(restateContextAfterCompact(internal, [style], []).map((entry) => entry.content)).toEqual(
      [style.content],
    );
    expect(restateContextAfterCompact(internal, [style], [style])).toEqual([]);
    expect(restateContextAfterCompact(internal, [style, reset], [])).toEqual([]);
  });

  it("derives the plan-mode exit reminder from history after resume", async () => {
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
    const internal = runtime as unknown as AgentRuntimeInternal;
    await runtime.executeTurn("planned");
    internal.messageHistory.addEntries([
      systemReminderAttachmentEntry("runtime_mode", "Plan mode is active."),
      { message: { role: "assistant", content: "plan ready" } },
    ]);
    // 冷恢复后内存标记为 false；按历史中最近的 plan 提醒判断。
    internal.needsPlanModeExitReminder = false;
    await runtime.executeTurn("build it");
    await runtime.executeTurn("again");
    const planExit = entries().filter((entry) => entry.metadata?.source === "plan_mode_exit");
    expect(planExit).toHaveLength(1);
  });

  it.each([undefined, CompactTrigger.Manual, CompactTrigger.Reactive])(
    "restores context without duplicate announcements after compact=%s",
    async (trigger) => {
      runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
      await runtime.executeTurn("first");
      const initialContext = contextEntries(runtime);
      expect(initialContext.map((entry) => entry.metadata?.source)).toEqual([...sources]);
      await runtime.executeTurn("second");
      expect(contextEntries(runtime)).toEqual(initialContext);
      const announcements = store.savedMessages.filter(isAnnouncementRecord);
      expect(announcements).toHaveLength(6);
      for (const announcement of announcements) {
        // 顶层 source 不写新值：旧版本 App 按封闭列表校验，会拒绝整个会话。
        expect(announcement.source).toBeUndefined();
        expect(announcement.semantics?.source).toBe(runtimeSourceOf(announcement));
        expect(announcement).toMatchObject({
          semantics: {
            uiVisibility: "hidden",
            transcriptVisibility: "hidden",
            providerVisibility: "visible",
          },
        });
      }
      if (trigger) {
        const compacted = await compact(runtime, trigger);
        expect(compacted.outcome).toBe("compacted");
        await runtime.executeTurn("continue after compact");
        // 每个来源仍只宣告一次；顺序按 compact 后布局（见 "lays out the post-compact context"）。
        const bySource = (items: ReturnType<typeof contextEntries>) =>
          [...items].sort((a, b) => a.metadata.source.localeCompare(b.metadata.source));
        expect(bySource(contextEntries(runtime))).toEqual(bySource(initialContext));
      }
      const liveContext = contextEntries(runtime);
      const { cold, coldStore } = await coldRuntimeWith(skillPort, {
        ...config,
        envInfo: { ...config.envInfo!, gitBranch: "new-probe-must-not-replace-history" },
      });
      const before = coldStore.savedMessages.filter(isAnnouncementRecord).length;
      await cold.executeTurn("resumed");
      expect(contextEntries(cold)).toEqual(liveContext);
      expect(coldStore.savedMessages.filter(isAnnouncementRecord)).toHaveLength(before);
    },
  );

  const withSkills = (
    skills: (base: Awaited<ReturnType<SkillPort["discoverSkills"]>>["skills"]) => typeof base,
  ): SkillPort => ({
    ...skillPort,
    async discoverSkills(request, options) {
      const outcome = await skillPort.discoverSkills(request, options);
      const next = skills(outcome.skills);
      return { ...outcome, skills: next, totalDiscovered: next.length };
    },
  });
  const withReviewSkill = withSkills((base) => [
    ...base,
    {
      ...base[0]!,
      name: "review",
      description: "review things",
      path: "/workspace/.agents/skills/review/SKILL.md",
      directory: "/workspace/.agents/skills/review",
    },
  ]);
  const skillsListingRecordTexts = (value: ReturnType<typeof createRecordingMessageStore>) =>
    value.savedParts
      .filter((part) => part.metadata?.runtimeMessage?.source === "skills_listing")
      .map((part) => String((part as { text?: string }).text));
  const historyIndexOfListing = (value: ReturnType<typeof createTestAgentRuntime>) =>
    (value as unknown as AgentRuntimeInternal).messageHistory
      .toRuntimeEntries()
      .findIndex(
        (entry) => entry.kind === "attachment" && entry.metadata.source === "skills_listing",
      );
  it("updates the restored skill listing in place when a resumed session finds a changed catalog", async () => {
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
    await runtime.executeTurn("first");
    const liveIndex = historyIndexOfListing(runtime);
    const { cold, coldStore } = await coldRuntimeWith(withReviewSkill);
    const storedTexts = skillsListingRecordTexts(coldStore);
    await cold.executeTurn("resumed");
    await cold.executeTurn("again");
    // 目录变化不插入新公告：原位置上的那一条换成当前目录，之后不再变化。
    const listings = contextEntries(cold).filter(
      (entry) => entry.metadata.source === "skills_listing",
    );
    expect(listings).toHaveLength(1);
    expect(listings[0]!.content).toContain("- review: review things");
    expect(listings[0]!.content).toContain("- search: search things");
    expect(historyIndexOfListing(cold)).toBe(liveIndex);
    const lastRequest = JSON.stringify(requests.at(-1)?.messages);
    expect(lastRequest.split("- review: review things")).toHaveLength(2);
    // 只改内存：库里的记录不变，也没有新增 skill 列表记录。
    expect(skillsListingRecordTexts(coldStore)).toEqual(storedTexts);
    // 先确认确实存过一条，否则空数组上的 every 恒为真。
    expect(storedTexts).toHaveLength(1);
    expect(storedTexts.every((text) => !text.includes("review"))).toBe(true);
  });

  it("drops the restored skill listing when a resumed session finds no skills", async () => {
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
    await runtime.executeTurn("first");
    const { cold, coldStore } = await coldRuntimeWith(withSkills(() => []));
    const storedTexts = skillsListingRecordTexts(coldStore);
    await cold.executeTurn("resumed");
    // 目录清空时没有新内容可宣告，旧名单必须从历史里去掉，不能继续发给模型。
    expect(contextEntries(cold).some((entry) => entry.metadata.source === "skills_listing")).toBe(
      false,
    );
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(
      "The following skills are available",
    );
    expect(skillsListingRecordTexts(coldStore)).toEqual(storedTexts);
  });

  it("applies the current catalog again when a rewind reloads history from the store", async () => {
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
    await runtime.executeTurn("first");
    const { cold, coldStore } = await coldRuntimeWith(withReviewSkill);
    await cold.executeTurn("resumed");
    await cold.executeTurn("again");
    const againPart = coldStore.savedParts.find(
      (part) => (part as { text?: string }).text === "again",
    );
    expect(againPart).toBeDefined();
    await cold.rewindConversationToMessage({
      events: [],
      targetMessageId: againPart!.messageID,
      traceContext: createRootTraceContext({ sessionId }),
    });
    await cold.executeTurn("edited");
    // rewind 从库重新加载历史，库里仍是旧名单；加载后同样按当前目录原位更新。
    const listings = contextEntries(cold).filter(
      (entry) => entry.metadata.source === "skills_listing",
    );
    expect(listings).toHaveLength(1);
    expect(listings[0]!.content).toContain("- review: review things");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("- review: review things");
  });

  describe("restored instructions after a history load", () => {
    const cliStorageRoot = "/storage/cli";
    const memoryConfig: Partial<AgentRuntimeConfig> = {
      ...config,
      memory: { cliStorageRoot, enabled: true, use: true },
    };
    const indexPath = join(
      resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: "/workspace" }),
      "MEMORY.md",
    );
    const oldIndex = "- [Old policy](old-policy.md) — announced before the restart";
    const newIndex = "- [New policy](new-policy.md) — written to disk after the announcement";
    const instructionTexts = (value: ReturnType<typeof createTestAgentRuntime>) =>
      contextEntries(value)
        .filter((entry) => entry.metadata.source === "context_prefix")
        .map((entry) => entry.content);
    const instructionRecordTexts = (value: ReturnType<typeof createRecordingMessageStore>) =>
      value.savedParts
        .filter((part) => part.metadata?.runtimeMessage?.source === "context_prefix")
        .map((part) => String((part as { text?: string }).text));
    const announceOldIndexThenChangeDisk = async () => {
      const files = new MemoryFileSystem({ [indexPath]: oldIndex });
      runtime = createRuntime(
        { now, skillPort, contextSourcePort: instructionsPort(), fileSystemPort: files },
        memoryConfig,
      );
      await runtime.executeTurn("first");
      expect(instructionTexts(runtime)).toEqual([expect.stringContaining(oldIndex)]);
      files.files[indexPath] = newIndex;
      return files;
    };

    it("updates the restored instructions in place to the Memory index read on resume", async () => {
      const files = await announceOldIndexThenChangeDisk();
      const { cold, coldStore } = await coldRuntimeWith(skillPort, memoryConfig, {
        fileSystemPort: files,
      });
      const storedTexts = instructionRecordTexts(coldStore);
      await cold.executeTurn("resumed");

      // 修复原因：恢复的旧公告原样发给模型，读文件状态却记录磁盘上的新索引；
      // Write 的新鲜度检查因此放行，模型按看到的旧索引写入，会覆盖它没见过的新索引。
      expect(instructionTexts(cold)).toEqual([expect.stringContaining(newIndex)]);
      const lastRequest = JSON.stringify(requests.at(-1)?.messages);
      expect(lastRequest).toContain(newIndex);
      expect(lastRequest).not.toContain(oldIndex);
      const readState = (cold as unknown as AgentRuntimeInternal).readFileState.get(
        createReadFileStatePathKey(indexPath),
      );
      expect(readState?.content).toBe(newIndex);
      // 只改内存：库里的记录保持第一次的内容，也没有新增指令公告。
      expect(instructionRecordTexts(coldStore)).toEqual(storedTexts);
      // 先确认确实存过一条，否则空数组上的 every 恒为真。
      expect(storedTexts).toHaveLength(1);
      expect(storedTexts.every((text) => text.includes(oldIndex))).toBe(true);

      // 模型看到的内容与读文件状态一致，Write 按这份内容检查。录制 store 没有项目权限规则。
      Object.assign(coldStore, { getProjectPermission: async () => null });
      const write = await cold.getToolExecutor().execute({
        id: createToolCallId("write-memory-index-after-resume"),
        input: { content: `${newIndex}\n- [Added](added.md) — added`, file_path: indexPath },
        name: "Write",
      });
      expect(write.success).toBe(true);
      expect(files.files[indexPath]).toBe(`${newIndex}\n- [Added](added.md) — added`);
    });

    it("keeps the current Memory index when a rewind reloads the old record from the store", async () => {
      const files = await announceOldIndexThenChangeDisk();
      const { cold, coldStore } = await coldRuntimeWith(skillPort, memoryConfig, {
        fileSystemPort: files,
      });
      await cold.executeTurn("resumed");
      await cold.executeTurn("again");
      const againPart = coldStore.savedParts.find(
        (part) => (part as { text?: string }).text === "again",
      );
      expect(againPart).toBeDefined();
      await cold.rewindConversationToMessage({
        events: [],
        targetMessageId: againPart!.messageID,
        traceContext: createRootTraceContext({ sessionId }),
      });
      await cold.executeTurn("edited");
      // rewind 从库重新加载历史，库里仍是旧索引；加载后同样原位换成当前内容。
      expect(instructionTexts(cold)).toEqual([expect.stringContaining(newIndex)]);
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(oldIndex);
    });

    it("drops the restored instructions when the resumed runtime has none", async () => {
      await announceOldIndexThenChangeDisk();
      const { cold } = await coldRuntimeWith(skillPort, config, {
        contextSourcePort: {
          ...instructionsPort(),
          async resolveContextSources() {
            return { workingDirectory: "/workspace", envInfo: config.envInfo!, diagnostics: [] };
          },
        },
      });
      await cold.executeTurn("resumed");
      // 当前没有指令文件和 Memory 索引时没有新内容可宣告，旧公告必须从历史里去掉。
      expect(instructionTexts(cold)).toEqual([]);
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(oldIndex);
    });
  });

  it.each([CompactTrigger.Reactive, CompactTrigger.Manual])(
    "lays out the post-compact context in announcement order after compact=%s",
    async (trigger) => {
      runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      const compacted = await compact(runtime, trigger);
      expect(compacted.outcome).toBe("compacted");
      const layout = (value: ReturnType<typeof createTestAgentRuntime>) =>
        (value as unknown as AgentRuntimeInternal).messageHistory
          .toRuntimeEntries()
          .filter((entry) => entry.kind === "attachment" || entry.message.role !== "system")
          .map((entry) =>
            entry.kind === "attachment"
              ? entry.metadata.source
              : String(entry.message.content).startsWith("This session is being continued")
                ? "summary"
                : entry.message.role,
          );
      const live = layout(runtime);
      const summaryIndex = live.indexOf("summary");
      const tail = live.slice(summaryIndex + 1);
      // 保留段非空时，请求前公告放在 summary 之前，且不重复保留段已有的来源。
      const leading = live.slice(0, summaryIndex);
      const requestSources = ["context_prefix", "session_context", "date"];
      if (trigger === CompactTrigger.Reactive) {
        expect(leading).toEqual(requestSources.filter((source) => !tail.includes(source)));
      } else {
        expect(leading).toEqual([]);
      }
      // compaction 附件末尾：agent listing → skill 列表 → environment → model。
      // compaction 必须产出 skill 列表，否则 compact 后第一次请求看不到 skill 名单。
      expect(tail.slice(-4)).toEqual([
        "agent_listing_delta",
        "skills_listing",
        "environment",
        "model",
      ]);
      for (const source of ["skills_listing", "environment", "model"]) {
        expect(tail.filter((item) => item === source)).toHaveLength(1);
      }

      // 存储顺序与 live 一致：公告写在 summary 之前，并由 summary 的 compaction part 声明。
      const summaryRow = store.savedMessages.findIndex(
        (message) => message.semantics?.kind === "compact_summary",
      );
      const declared =
        store.savedParts.find((part) => part.type === "compaction" && part.compactBoundary)
          ?.metadata?.compactLeadingMessageIds ?? [];
      expect(declared).toHaveLength(leading.length);
      expect(
        store.savedMessages
          .slice(summaryRow - declared.length, summaryRow)
          .map((message) => message.id),
      ).toEqual(declared);

      // 冷恢复得到相同布局。
      const { cold } = await coldRuntimeWith();
      expect(layout(cold)).toEqual(live);
    },
  );

  it("does not place a date before the summary when the kept tail already has one", () => {
    // 保留段里已有 date 类型的公告（哪怕已过期）时，summary 之前不放日期；
    // 之后的请求以保留段里的旧日期为基准，在末尾宣告一次日期变化。
    runtime = createRuntime(
      { now: () => new Date(2026, 9, 15, 0, 10), skillPort, contextSourcePort: instructionsPort() },
      config,
    );
    const internal = runtime as unknown as AgentRuntimeInternal;
    const kept = [
      { message: { role: "assistant" as const, content: "Working on it." } },
      systemReminderAttachmentEntry("date", "Today's date is 2026-10-14."),
      { message: { role: "assistant" as const, content: "Done." } },
    ];
    const leading = buildCompactLeadingAnnouncements(internal, kept);
    expect(leading.map((entry) => entry.metadata.source)).not.toContain("date");
    // 普通请求前公告不受影响：同一份历史仍宣告日期变化。
    expect(
      buildRequestAnnouncements(internal, kept).map((entry) => entry.metadata.source),
    ).toContain("date");
  });

  it("does not invent environment or model notices after compact when history has none", () => {
    // 只重述 compact 前历史里真有的公告；历史里没有时由下一次请求的收集补上。
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
    const internal = runtime as unknown as AgentRuntimeInternal;
    internal.latestContextBuildResult = {
      sections: [{ source: "env_info" }],
    } as never;
    const restated = restateContextAfterCompact(
      internal,
      [{ message: { role: "user", content: "legacy history" }, metadata: { source: "real_user" } }],
      [],
    );
    expect(restated).toEqual([]);
  });

  it("commits announcements, summary and attachments in one store transaction", async () => {
    const bundles: { messages: { info: { id: string }; parts: unknown[] }[] }[] = [];
    const saveMessage = vi.spyOn(store, "saveMessage");
    Object.assign(store, {
      async commitMessageBundle(bundle: (typeof bundles)[number]) {
        bundles.push(structuredClone(bundle));
        for (const message of bundle.messages) {
          store.savedMessages.push(message.info);
          store.savedParts.push(...message.parts);
        }
      },
    });
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    const savedBefore = saveMessage.mock.calls.length;
    const compacted = await compact(runtime, CompactTrigger.Reactive);
    expect(compacted.outcome).toBe("compacted");
    expect(bundles).toHaveLength(1);
    const bundleIds = bundles[0]!.messages.map((message) => message.info.id);
    const committed = new Set(bundleIds);
    // 整组记录只经过事务入口，不再逐条写入。
    expect(
      saveMessage.mock.calls.slice(savedBefore).filter(([info]) => committed.has(info.id)),
    ).toEqual([]);
    const summaryIndex = bundles[0]!.messages.findIndex((message) =>
      message.parts.some((part) => (part as { type?: string }).type === "compaction"),
    );
    const declared = (
      bundles[0]!.messages[summaryIndex]!.parts.find(
        (part) => (part as { type?: string }).type === "compaction",
      ) as { metadata?: { compactLeadingMessageIds?: string[] } }
    ).metadata?.compactLeadingMessageIds;
    expect(declared?.length).toBeGreaterThan(0);
    expect(bundleIds.slice(0, summaryIndex)).toEqual(declared);
    expect(bundleIds.length).toBeGreaterThan(summaryIndex + 1);
  });

  it.each([CompactTrigger.Reactive, CompactTrigger.Manual])(
    "re-reads Git for the session context re-announced after compact=%s",
    async (trigger) => {
      const resolveGitContext = vi.fn(async () => ({
        ...config.envInfo!,
        gitBranch: "after-compact",
      }));
      runtime = createRuntime(
        { now, skillPort, contextSourcePort: { ...instructionsPort(), resolveGitContext } },
        config,
      );
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      expect(resolveGitContext).not.toHaveBeenCalled();
      await compact(runtime, trigger);
      await runtime.executeTurn("after compact");
      // 历史中没有 session_context 时重新读取 git，compact 后的快照是最新的。
      expect(resolveGitContext).toHaveBeenCalledTimes(1);
      const gitContext = contextEntries(runtime).filter(
        (entry) => entry.metadata.source === "session_context",
      );
      expect(gitContext).toHaveLength(1);
      expect(gitContext[0]!.content).toContain("after-compact");
      expect(gitContext[0]!.content).not.toContain("original");
      // 只刷新会话上下文；system 前缀不含 Git 事实，字节不变。
      const prefix = (request: ModelRequest) =>
        request.messages.slice(
          0,
          request.messages.findIndex((message) => message.role !== "system"),
        );
      expect(prefix(requests.at(-1)!)).toEqual(prefix(requests[0]!));
    },
  );

  it("keeps the re-read Git only inside the compacted history, so a failed compaction leaves none", async () => {
    const resolveGitContext = vi.fn(async () => ({
      ...config.envInfo!,
      gitBranch: "after-compact",
    }));
    let failCommit = true;
    Object.assign(store, {
      async commitMessageBundle(bundle: { messages: { info: never; parts: never[] }[] }) {
        if (failCommit) throw new Error("disk full");
        for (const message of bundle.messages) {
          store.savedMessages.push(message.info);
          store.savedParts.push(...message.parts);
        }
      },
    });
    runtime = createRuntime(
      { now, skillPort, contextSourcePort: { ...instructionsPort(), resolveGitContext } },
      config,
    );
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    const internal = runtime as unknown as {
      config: { envInfo?: { gitBranch?: string } };
      contextSourceSnapshot?: { envInfo: { gitBranch?: string } };
    };
    const announcedGit = () =>
      contextEntries(runtime)
        .filter((entry) => entry.metadata.source === "session_context")
        .map((entry) => entry.content);
    await expect(compact(runtime, CompactTrigger.Reactive)).rejects.toThrow("disk full");
    // 写库失败：历史没有替换，仍是原来的公告；runtime 没有任何新的 Git 事实。
    expect(resolveGitContext).toHaveBeenCalledTimes(1);
    expect(announcedGit()).toEqual([expect.stringContaining("original")]);
    expect(internal.contextSourceSnapshot?.envInfo.gitBranch).toBe("original");
    expect(internal.config.envInfo?.gitBranch).toBe("original");

    failCommit = false;
    await compact(runtime, CompactTrigger.Reactive);
    expect(announcedGit()).toEqual([expect.stringContaining("after-compact")]);
    // 新的 Git 只存在于 compact 后的公告里；会话快照保持会话起始值。
    expect(internal.contextSourceSnapshot?.envInfo.gitBranch).toBe("original");
    expect(internal.config.envInfo?.gitBranch).toBe("original");
  });

  describe("Git session context decided once per window, only by history", () => {
    const nonRepository = { ...config.envInfo!, isGitRepository: false, gitStatus: "not_repo" };
    const repositories = new Set<string>();
    const resolveGitContext = vi.fn(
      async ({ workingDirectory }: Pick<ContextSourceRequest, "workingDirectory">) =>
        repositories.has(workingDirectory)
          ? { ...config.envInfo!, gitBranch: `repo:${workingDirectory}` }
          : { isGitRepository: false, gitStatus: "not_repo" as const },
    );
    const resolveEnvironment = vi.fn(
      async ({ workingDirectory }: Pick<ContextSourceRequest, "workingDirectory">) => ({
        ...config.envInfo!,
        cwd: workingDirectory,
        isGitRepository: repositories.has(workingDirectory),
      }),
    );
    const portStartingIn = (
      envInfo: NonNullable<AgentRuntimeConfig["envInfo"]>,
    ): ContextSourcePort => ({
      ...instructionsPort(),
      async resolveContextSources() {
        return { workingDirectory: "/workspace", envInfo, diagnostics: [] };
      },
      resolveEnvironment,
      resolveGitContext,
    });
    const announcedGit = (value = runtime) =>
      contextEntries(value)
        .filter((entry) => entry.metadata.source === "session_context")
        .map((entry) => entry.content);
    const environments = (value: ReturnType<typeof createTestAgentRuntime>) =>
      contextEntries(value)
        .filter((entry) => entry.metadata.source === "environment")
        .map((entry) => entry.content);
    const cd = (value: ReturnType<typeof createTestAgentRuntime>, directory: string) => {
      (value as unknown as AgentRuntimeInternal).workingDirectory = directory;
    };

    beforeEach(() => {
      repositories.clear();
      resolveGitContext.mockClear();
      resolveEnvironment.mockClear();
    });

    it("decides once per window: a non-repository start reads nothing later, also after moving into a repository", async () => {
      runtime = createRuntime({ now, contextSourcePort: portStartingIn(nonRepository) }, config);
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      await runtime.executeTurn("third");
      // 修复原因：起始快照来自文件系统查找，"不是仓库"是确定结论；原来不记住，第二个请求
      // 还要再检查一次。现在首个请求用快照并记住目录，同一目录之后不再检查。
      expect(resolveGitContext).not.toHaveBeenCalled();
      expect(announcedGit()).toEqual([]);

      repositories.add("/workspace/repo");
      cd(runtime, "/workspace/repo");
      await runtime.executeTurn("fourth");
      await runtime.executeTurn("fifth");
      // 本窗口已在首个请求决定过（没有 Git），进入仓库也不再读；环境公告照常报告新目录。
      expect(resolveGitContext).not.toHaveBeenCalled();
      expect(announcedGit()).toEqual([]);
      expect(environments(runtime).at(-1)).toContain("Is a git repository: true (was false)");

      await compact(runtime, CompactTrigger.Manual);
      await runtime.executeTurn("next window");
      // compaction 开始新窗口，新窗口的首个请求按当前目录读取。
      expect(resolveGitContext).toHaveBeenCalledTimes(1);
      expect(announcedGit()).toEqual([expect.stringContaining("repo:/workspace/repo")]);
    });

    it("reads Git again in a new window and remembers a directory that is not a repository", async () => {
      runtime = createRuntime({ now, contextSourcePort: portStartingIn(config.envInfo!) }, config);
      await runtime.executeTurn("first");
      expect(announcedGit()).toEqual([expect.stringContaining("original")]);

      await compact(runtime, CompactTrigger.Manual);
      cd(runtime, "/scratch");
      await runtime.executeTurn("outside repository");
      await runtime.executeTurn("still outside");
      // compaction 删掉了旧公告；新窗口的首个请求检查一次，非仓库目录记住。
      expect(resolveGitContext).toHaveBeenCalledTimes(1);
      expect(announcedGit()).toEqual([]);

      await compact(runtime, CompactTrigger.Manual);
      await runtime.executeTurn("outside again");
      // 记住的目录在之后的窗口也不再检查。
      expect(resolveGitContext).toHaveBeenCalledTimes(1);

      repositories.add("/workspace");
      cd(runtime, "/workspace");
      await runtime.executeTurn("back in repository");
      expect(resolveGitContext).toHaveBeenCalledTimes(1);
      expect(announcedGit()).toEqual([]);

      await compact(runtime, CompactTrigger.Manual);
      await runtime.executeTurn("repository window");
      expect(resolveGitContext).toHaveBeenCalledTimes(2);
      expect(announcedGit()).toEqual([expect.stringContaining("repo:/workspace")]);
    });

    it("lets a compaction that keeps a tail decide again although the tail holds a date announcement", async () => {
      let today = new Date(2026, 9, 14, 12);
      runtime = createRuntime(
        { now: () => today, contextSourcePort: portStartingIn(nonRepository) },
        { ...config, compact: { enabled: true } },
      );
      await runtime.executeTurn("first");
      await runtime.executeTurn("second");
      repositories.add("/workspace/repo");
      cd(runtime, "/workspace/repo");
      today = new Date(2026, 9, 15, 12);
      // 第三个输入的请求前公告（日期变化）先写入历史，模型随后报告上下文超限，触发 reactive compaction。
      // 保留段是最后一个 assistant 之后的内容，带着这条日期变化公告。
      respond.mockRejectedValueOnce(
        Object.assign(new Error("provider context window exceeded"), {
          code: ModelErrorCode.ModelContextExceeded,
        }),
      );
      await runtime.executeTurn("third");

      // date 只表示请求前已决定；compaction 为压缩后的历史重新决定，仍按当前目录读取。
      expect(
        contextEntries(runtime)
          .filter((entry) => entry.metadata.source === "date")
          .map((entry) => entry.content),
      ).toEqual([expect.stringContaining("The date has changed")]);
      expect(resolveGitContext).toHaveBeenCalledTimes(1);
      expect(announcedGit()).toEqual([expect.stringContaining("repo:/workspace/repo")]);
    });

    it("continues the restored window after a cold resume: membership is re-read for the environment, Git waits for the next window", async () => {
      runtime = createRuntime({ now, contextSourcePort: portStartingIn(nonRepository) }, config);
      await runtime.executeTurn("first");
      expect(announcedGit()).toEqual([]);

      // 会话中途 git init：live runtime 不再检查，环境与 Git 都不变。
      repositories.add("/workspace");
      await runtime.executeTurn("live after git init");
      expect(resolveEnvironment).not.toHaveBeenCalled();
      expect(resolveGitContext).not.toHaveBeenCalled();
      expect(environments(runtime)).toHaveLength(1);

      const coldStore = createRecordingMessageStore();
      await coldStore.createSession(await store.getSession(sessionId));
      coldStore.savedMessages.push(...structuredClone(store.savedMessages));
      coldStore.savedParts.push(...structuredClone(store.savedParts));
      const cold = createRuntime(
        { now, contextSourcePort: portStartingIn(nonRepository), sessionStore: coldStore as never },
        config,
      );
      await cold.resumeFromStore();
      await cold.executeTurn("after resume");
      await cold.executeTurn("again");
      // 修复原因：非仓库窗口没有 Git 公告，"不是仓库"原来只记在 runtime 内存里；冷恢复后的新
      // runtime 没有这份记忆，又读 Git 并宣告，而环境公告仍写 "Is a git repository: false"。
      // 现在恢复的窗口沿用历史，不读 Git；新 runtime 只重读一次是否仓库，在环境公告里报告变化。
      expect(resolveGitContext).not.toHaveBeenCalled();
      expect(announcedGit(cold)).toEqual([]);
      expect(resolveEnvironment).toHaveBeenCalledTimes(1);
      expect(environments(cold).slice(1)).toEqual([
        "# Environment update\n - Is a git repository: true (was false)",
      ]);

      await compact(cold, CompactTrigger.Manual);
      await cold.executeTurn("next window");
      expect(resolveGitContext).toHaveBeenCalledTimes(1);
      expect(announcedGit(cold)).toEqual([expect.stringContaining("repo:/workspace")]);
    });

    it("does not use a resumed session's stored snapshot as the prefetch when the restored window has not decided", async () => {
      runtime = createRuntime({ now, contextSourcePort: portStartingIn(nonRepository) }, config);
      await runtime.executeTurn("first");
      repositories.add("/workspace");
      // 恢复的历史还没有做过决定（没有 date 公告，例如旧版本写下的历史）。
      const coldStore = createRecordingMessageStore();
      await coldStore.createSession(await store.getSession(sessionId));
      const undecided = store.savedMessages.filter(
        (message) => runtimeSourceOf(message) !== "date",
      );
      const kept = new Set(undecided.map((message) => message.id));
      coldStore.savedMessages.push(...structuredClone(undecided));
      coldStore.savedParts.push(
        ...structuredClone(store.savedParts.filter((part) => kept.has(part.messageID))),
      );
      const cold = createRuntime(
        { now, contextSourcePort: portStartingIn(nonRepository), sessionStore: coldStore as never },
        config,
      );
      await cold.resumeFromStore();
      await cold.executeTurn("after resume");
      // 存储里的快照不是刚读的，不能当预取；恢复后的首个请求读一次 Git。
      expect(resolveGitContext).toHaveBeenCalledTimes(1);
      expect(announcedGit(cold)).toEqual([expect.stringContaining("repo:/workspace")]);
      expect(environments(cold).at(-1)).toBe(
        "# Environment update\n - Is a git repository: true (was false)",
      );
    });
  });

  it("appends changed cwd once and keeps the initial Git snapshot", async () => {
    runtime = createRuntime({ now }, config);
    await runtime.executeTurn("first");
    (runtime as unknown as AgentRuntimeInternal).workingDirectory = "/workspace/subdir";
    await runtime.executeTurn("second");
    await runtime.executeTurn("third");
    const all = contextEntries(runtime);
    const environments = all.filter((entry) => entry.metadata?.source === "environment");
    expect(environments).toHaveLength(2);
    expect(environments[1]).toMatchObject({
      content:
        "# Environment update\n - Primary working directory: /workspace/subdir (was /workspace)",
    });
    expect(all.filter((entry) => entry.metadata?.source === "session_context")).toHaveLength(1);
    expect(requests[1]?.messages.map(({ role, content }) => ({ role, content }))).toEqual(
      requests[2]?.messages.slice(0, -2).map(({ role, content }) => ({ role, content })),
    );
  });

  it("lists additional working directories and announces only their change after cold resume", async () => {
    const environmentEntries = (value: ReturnType<typeof createTestAgentRuntime>) =>
      contextEntries(value).filter((entry) => entry.metadata?.source === "environment");
    runtime = createRuntime(
      { now },
      { ...config, additionalDirectories: ["/work/backend", "C:\\work\\shared folder"] },
    );
    await runtime.executeTurn("first");
    const [full] = environmentEntries(runtime);

    // 运行实例内目录不变；冷恢复按新运行配置比较最近一次公告，只追加增量，原块不改写。
    const cold = createRuntime(
      { now },
      { ...config, additionalDirectories: ["/work/backend", "/work/docs"] },
    );
    await cold.resumeFromStore();
    await cold.executeTurn("resumed");
    const environments = environmentEntries(cold);
    expect(environments).toHaveLength(2);
    expect(environments[0]).toEqual(full);
    expect(environments[1]).toMatchObject({
      content:
        "# Environment update\n - Additional working directories added:\n  - /work/docs\n - Additional working directories removed:\n  - C:\\work\\shared folder",
      metadata: {
        environment: {
          full: false,
          snapshot: { additionalWorkingDirectories: ["/work/backend", "/work/docs"] },
        },
      },
    });
    const visible = (request: ModelRequest) =>
      request.messages.map(({ role, content }) => ({ role, content }));
    expect(visible(requests.at(-1)!).slice(0, requests[0]!.messages.length)).toEqual(
      visible(requests[0]!),
    );
  });

  it("refreshes repository membership, deduplicates, and compares the return trip with the latest snapshot", async () => {
    const contextSourcePort = environmentPort();
    runtime = createRuntime({ now, contextSourcePort }, config);
    await runtime.executeTurn("first");
    const initialGit = contextEntries(runtime).find(
      (entry) => entry.metadata?.source === "session_context",
    );
    runtime.setWorkingDirectory("/outside");
    await runtime.executeTurn("leave repo");
    await runtime.executeTurn("same directory");
    const updates = contextEntries(runtime).filter(
      (entry) => entry.metadata?.source === "environment",
    );
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      content:
        "# Environment update\n - Primary working directory: /outside (was /workspace)\n - Is a git repository: false (was true)",
      metadata: {
        environment: { full: false, snapshot: { cwd: "/outside", isGitRepository: false } },
      },
    });
    expect(contextSourcePort.resolveEnvironment).toHaveBeenCalledTimes(1);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "system",
      content: updates[1]?.kind === "attachment" ? updates[1].content : "",
    });
    runtime.setWorkingDirectory("/workspace");
    await runtime.executeTurn("return to repo");
    expect(
      contextEntries(runtime)
        .filter((entry) => entry.metadata?.source === "environment")
        .at(-1),
    ).toMatchObject({
      content:
        "# Environment update\n - Primary working directory: /workspace (was /outside)\n - Is a git repository: true (was false)",
    });
    expect(
      contextEntries(runtime).filter((entry) => entry.metadata?.source === "session_context"),
    ).toEqual([initialGit]);
  });

  it("re-reads only repository membership once after a cold resume and announces a change as an update", async () => {
    runtime = createRuntime({ now, contextSourcePort: environmentPort() }, config);
    await runtime.executeTurn("first");
    const environmentsOf = (value: ReturnType<typeof createTestAgentRuntime>) =>
      contextEntries(value)
        .filter((entry) => entry.metadata?.source === "environment")
        .map((entry) => entry.content);
    const gitOf = (value: ReturnType<typeof createTestAgentRuntime>) =>
      contextEntries(value).filter((entry) => entry.metadata?.source === "session_context");

    // 是否仓库没变：新 runtime 读一次，不追加公告。
    const unchanged = environmentPort();
    const { cold: same } = await coldRuntimeWith(skillPort, config, {
      contextSourcePort: unchanged,
    });
    await same.executeTurn("resumed");
    await same.executeTurn("again");
    expect(unchanged.resolveEnvironment).toHaveBeenCalledTimes(1);
    expect(environmentsOf(same)).toEqual(environmentsOf(runtime));

    // .git 已删除：只取是否仓库，平台与系统版本沿用历史，不出完整块；Git 公告沿用历史。
    const changed = environmentPort();
    changed.resolveEnvironment.mockImplementation(async ({ workingDirectory }) => ({
      ...config.envInfo!,
      cwd: workingDirectory,
      platform: "darwin",
      osVersion: "Darwin",
      isGitRepository: false,
    }));
    const { cold } = await coldRuntimeWith(skillPort, config, { contextSourcePort: changed });
    await cold.executeTurn("resumed");
    await cold.executeTurn("again");
    expect(changed.resolveEnvironment).toHaveBeenCalledTimes(1);
    expect(environmentsOf(cold)).toEqual([
      ...environmentsOf(runtime),
      "# Environment update\n - Is a git repository: false (was true)",
    ]);
    expect(gitOf(cold)).toEqual(gitOf(runtime));
  });

  it("restores environment snapshot metadata and emits a full block when its original block is removed", async () => {
    const contextSourcePort = environmentPort();
    runtime = createRuntime({ now, contextSourcePort }, config);
    await runtime.executeTurn("first");
    runtime.setWorkingDirectory("/outside");
    await runtime.executeTurn("leave repo");
    const cold = createRuntime({ now, contextSourcePort }, config);
    await cold.resumeFromStore();
    cold.setWorkingDirectory("/outside");
    await cold.executeTurn("resume here");
    expect(contextEntries(cold)).toEqual(contextEntries(runtime));
    const internal = cold as unknown as AgentRuntimeInternal;
    internal.messageHistory.replaceMessages(
      internal.messageHistory
        .toRuntimeEntries()
        .filter(
          (entry) =>
            !(
              entry.kind === "attachment" &&
              entry.metadata.source === "environment" &&
              entry.metadata.environment?.full
            ),
        ),
    );
    await cold.executeTurn("after history reduction");
    expect(
      contextEntries(cold)
        .filter((entry) => entry.metadata?.source === "environment")
        .at(-1),
    ).toMatchObject({
      content: expect.stringContaining("# Environment\n"),
      metadata: {
        environment: { full: true, snapshot: { cwd: "/outside", isGitRepository: false } },
      },
    });
  });

  it("replaces the full block on shell or platform changes and catches up a directory moved during the probe", async () => {
    const contextSourcePort = environmentPort();
    runtime = createRuntime({ now, contextSourcePort }, config);
    await runtime.executeTurn("first");
    contextSourcePort.resolveEnvironment.mockImplementationOnce(async () => {
      runtime.setWorkingDirectory("/latest");
      return { ...config.envInfo!, cwd: "/probed", shell: "fish", isGitRepository: true };
    });
    contextSourcePort.resolveEnvironment.mockImplementationOnce(async ({ workingDirectory }) => ({
      ...config.envInfo!,
      cwd: workingDirectory,
      platform: "darwin",
      isGitRepository: false,
    }));
    const latestEnvironment = () =>
      contextEntries(runtime)
        .filter((entry) => entry.metadata?.source === "environment")
        .at(-1);
    runtime.setWorkingDirectory("/probed");
    await runtime.executeTurn("move during probe");
    // 公告使用探测前读到的目录及其事实，不重试；目录在 IO 期间的变化留给下一次请求。
    expect(latestEnvironment()).toMatchObject({
      content: expect.stringContaining("# Environment\n"),
      metadata: {
        environment: { full: true, snapshot: { cwd: "/probed", shell: "fish" } },
      },
    });
    expect(contextSourcePort.resolveEnvironment).toHaveBeenCalledTimes(1);

    await runtime.executeTurn("next");
    expect(latestEnvironment()).toMatchObject({
      content: expect.stringContaining("# Environment\n"),
      metadata: {
        environment: {
          full: true,
          snapshot: { cwd: "/latest", platform: "darwin", isGitRepository: false },
        },
      },
    });
    expect(contextSourcePort.resolveEnvironment).toHaveBeenCalledTimes(2);
  });

  it("republishes a full block for legacy metadata and does not leak snapshot metadata on MCS downgrade", async () => {
    runtime = createRuntime({ now, contextSourcePort: environmentPort() }, config);
    await runtime.executeTurn("first");
    const internal = runtime as unknown as AgentRuntimeInternal;
    const legacy = internal.messageHistory.toRuntimeEntries();
    for (const entry of legacy) {
      if (entry.metadata?.source === "environment") delete entry.metadata.environment;
    }
    internal.messageHistory.replaceMessages(legacy);
    await runtime.executeTurn("legacy history");
    expect(
      contextEntries(runtime).filter((entry) => entry.metadata?.source === "environment"),
    ).toHaveLength(2);
    runtime.setWorkingDirectory("/outside");
    await runtime.executeTurn("leave");
    const returnedEntries = internal.messageHistory.toRuntimeEntries();
    const returnedEnvironment = returnedEntries
      .filter((entry) => entry.metadata?.source === "environment")
      .at(-1)!;
    returnedEnvironment.metadata!.environment!.snapshot.cwd = "/mutated-entry";
    expect(contextEntries(runtime).at(-1)).not.toEqual(returnedEnvironment);
    const projected = buildProviderRequestMessages({
      entries: internal.messageHistory.toRuntimeEntries(),
      useMidConversationSystem: false,
    }).messages;
    expect(JSON.stringify(projected)).not.toMatch(/"(?:metadata|snapshot|environment)"/u);
    expect(
      projected.some(
        (message) =>
          message.role === "user" &&
          String(message.content).includes("<system-reminder>\n# Environment update\n"),
      ),
    ).toBe(true);
  });

  it("does not commit a failed context write and retries the missing sources", async () => {
    runtime = createRuntime({ now, skillPort, contextSourcePort: instructionsPort() }, config);
    const savePart = store.savePart;
    store.savePart = async (part) => {
      if (part.metadata?.runtimeMessage?.source === "environment")
        throw new Error("context write failed");
      await savePart(part);
    };
    await expect(runtime.executeTurn("first")).rejects.toThrow();
    expect(respond).not.toHaveBeenCalled();
    // environment 是第一条公告；它写入失败时，后续来源都不会提交。
    expect(contextEntries(runtime).map((entry) => entry.metadata?.source)).toEqual([]);
    store.savePart = savePart;
    await runtime.executeTurn("retry");
    expect(contextEntries(runtime).map((entry) => entry.metadata?.source)).toEqual([...sources]);
  });
});
