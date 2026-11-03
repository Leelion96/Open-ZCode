import { describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId, type ModelRequest } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";

// 隐藏提醒记录（公告、中断标记）写在用户输入与 assistant 之间，它们是模型上下文，不是对话消息。
const ENV_INFO = {
  cwd: "/workspace",
  platform: "linux",
  shell: "bash",
  osVersion: "Linux",
  nodeVersion: "24",
  isGitRepository: false,
};
const OUTPUT_STYLE = { name: "Learning", prompt: "Explain tradeoffs." };

type RecordingStore = ReturnType<typeof createStore>;

function createStore() {
  const recording = createRecordingMessageStore();
  return Object.assign(recording, {
    async setRevert(input: { sessionID: string; revert: unknown }) {
      await recording.updateSession({ id: input.sessionID, revert: input.revert });
    },
  });
}

function createRuntime(
  sessionId: ReturnType<typeof createSessionId>,
  store: RecordingStore,
  requests: ModelRequest[],
  options: { agentListing?: boolean } = {},
) {
  const agentDefinitions = options.agentListing
    ? {}
    : { getAgentDefinitions: () => ({ activeAgents: [] }) };
  return createTestAgentRuntime(
    sessionId,
    {
      mode: "yolo",
      compact: { enabled: false },
      titleGeneration: { enabled: false },
      workingDirectory: "/workspace",
      currentDate: "2026-10-14",
      envInfo: ENV_INFO,
      outputStyle: OUTPUT_STYLE,
    } as never,
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as never,
      ...agentDefinitions,
      modelFactory: createTestModelFactory({
        properties: { supportsMidConversationSystem: true },
        generateText: async (request: ModelRequest) => {
          requests.push(request);
          return {
            finishReason: "stop" as const,
            text: `answer ${requests.length}`,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    } as never,
  ) as unknown as RuntimeView;
}

interface RuntimeView {
  executeTurn(input: string): Promise<unknown>;
  resumeFromStore(): Promise<unknown>;
  rewindConversationToMessage(input: {
    events: unknown[];
    targetMessageId: string;
    traceContext: ReturnType<typeof createRootTraceContext>;
  }): Promise<unknown>;
  stopActiveForegroundExecution(input: { reason: string }): unknown;
  autoCompactIfNeeded(...args: unknown[]): unknown;
  latestConversationMessageId?: string;
  turnNumber: number;
}

function recordPointerAtCompaction(runtime: RuntimeView): Array<string | undefined> {
  // auto-compaction 在这里读指针作为覆盖边界（lastSummarizedMessageId / tail_start_id）；
  // 此时本轮公告已写入，指针不能停在公告上。
  const pointers: Array<string | undefined> = [];
  const autoCompactIfNeeded = runtime.autoCompactIfNeeded;
  runtime.autoCompactIfNeeded = function (this: RuntimeView, ...args: unknown[]) {
    pointers.push(this.latestConversationMessageId);
    return autoCompactIfNeeded.apply(this, args);
  };
  return pointers;
}

function isHiddenReminder(store: RecordingStore, messageId: string | undefined): boolean {
  const info = store.savedMessages.find((message) => message.id === messageId);
  return info?.semantics?.kind === "system_reminder";
}

function userMessageId(store: RecordingStore, text: string): string | undefined {
  return store.savedParts.find((part) => part.type === "text" && part.text === text)?.messageID;
}

describe("hidden runtime reminder records", () => {
  it("rewinds an assistant anchor to the turn's user input, past the hidden reminders", async () => {
    const sessionId = createSessionId();
    const store = createStore();
    const requests: ModelRequest[] = [];
    const runtime = createRuntime(sessionId, store, requests);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");
    const assistant = store.savedMessages.find(
      (message) =>
        message.role === "assistant" && message.parentID === userMessageId(store, "second"),
    );

    await runtime.rewindConversationToMessage({
      events: [],
      targetMessageId: assistant!.id,
      traceContext: createRootTraceContext({ sessionId }),
    });
    await runtime.executeTurn("edited");

    const wire = JSON.stringify(requests.at(-1)?.messages);
    expect(wire).toContain("edited");
    expect(wire).not.toContain('"second"');
  });

  it("counts the same turnNumber live and after resume", async () => {
    const sessionId = createSessionId();
    const store = createStore();
    const runtime = createRuntime(sessionId, store, []);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    const cold = createRuntime(sessionId, store, []);
    await cold.resumeFromStore();

    expect(runtime.turnNumber).toBe(2);
    expect(cold.turnNumber).toBe(runtime.turnNumber);
  });

  it("keeps the conversation pointer on conversation messages", async () => {
    const sessionId = createSessionId();
    const store = createStore();
    const runtime = createRuntime(sessionId, store, []);
    const pointersAtCompaction = recordPointerAtCompaction(runtime);
    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    expect(pointersAtCompaction).toEqual([
      userMessageId(store, "first"),
      userMessageId(store, "second"),
    ]);

    const originalSaveMessage = store.saveMessage.bind(store);
    let stopped = false;
    store.saveMessage = async (message) => {
      await originalSaveMessage(message);
      if (!stopped && message.role === "assistant" && message.time?.completed && !message.error) {
        stopped = true;
        runtime.stopActiveForegroundExecution({ reason: "user stop" });
      }
    };
    await runtime.executeTurn("third").catch(() => undefined);
    const marker = store.savedParts.find(
      (part) => part.type === "text" && part.text === "[Request interrupted by user]",
    );
    expect(marker).toBeDefined();
    expect(isHiddenReminder(store, runtime.latestConversationMessageId)).toBe(false);

    const cold = createRuntime(sessionId, store, []);
    await cold.resumeFromStore();
    expect(cold.latestConversationMessageId).toBe(runtime.latestConversationMessageId);
  });

  it("keeps the conversation pointer off agent listing announcements", async () => {
    const sessionId = createSessionId();
    const store = createStore();
    const runtime = createRuntime(sessionId, store, [], { agentListing: true });
    const pointersAtCompaction = recordPointerAtCompaction(runtime);
    await runtime.executeTurn("first");

    expect(store.savedMessages.some((message) => message.source === "agent_listing_delta")).toBe(
      true,
    );
    expect(pointersAtCompaction).toEqual([userMessageId(store, "first")]);
    const cold = createRuntime(sessionId, store, [], { agentListing: true });
    await cold.resumeFromStore();
    expect(cold.latestConversationMessageId).toBe(runtime.latestConversationMessageId);
  });
});
