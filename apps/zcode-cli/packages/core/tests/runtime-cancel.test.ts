import { describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  type SessionGoal,
  type SessionStorePort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import { modelMessageContentToText, type ModelInputMessage } from "@zcode/contracts";
import type { ToolExecutionResult } from "../src/runtime/deps.js";
import {
  USER_STOPPED_TOOL_RESULT_CONTENT,
  withUserStoppedToolResultContent,
} from "../src/runtime/methods/interrupt-marker.js";
import { createExternalTurnFaultError } from "../src/runtime/helpers/turn-errors.js";

describe("AgentRuntime turn cancellation", () => {
  // Bugfix 回归：用户主动取消（TurnCancelled）属于正常结束，事件流应以 TurnComplete(cancelled)
  // 结尾、绝不出现 TurnError，避免被下游映射成 turn.failed。
  it("emits TurnComplete(cancelled) instead of TurnError when the turn is aborted", async () => {
    const sessionId = createSessionId("runtime-cancel-turn");
    const eventStore = createTestSessionEventStore();
    const abortController = new AbortController();

    const runtime = createTestAgentRuntime(
      sessionId,
      { systemPrompt: "You are a cancel test agent." },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            // 模拟用户在模型请求进行中按下取消。
            abortController.abort(new Error("user cancelled"));
            throw new Error("user cancelled");
          },
        } as never),
      },
    );

    await expect(
      runtime.executeTurn("do something long", undefined, {
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const events = await eventStore.getEvents(sessionId);
    const types = events.map((event) => event.type);

    expect(types).not.toContain(SessionEventType.TurnError);
    expect(types[types.length - 1]).toBe(SessionEventType.TurnComplete);

    const completeEvent = events[events.length - 1];
    expect((completeEvent.payload as { resultType?: string }).resultType).toBe("cancelled");
  });

  describe("interrupt marker", () => {
    // 默认测试模型不合并相邻 user 内容，所以标记和前一条 prompt 都不补换行。
    // 只替换被取消的工具结果；已完成的结果、未停止的批次和 send-now 抢占都不动。
    it("rewrites only cancelled tool results of a user-stopped batch", () => {
      const result = (id: string, errorType?: string): ToolExecutionResult => ({
        toolCallId: id,
        toolName: "Bash",
        success: errorType === undefined,
        output: errorType === undefined ? "done" : null,
        ...(errorType === undefined ? {} : { error: { type: errorType, message: "cancelled" } }),
        durationMs: 0,
        startedAt: new Date(0),
        completedAt: new Date(0),
      });
      const results = [
        result("completed"),
        result("cancelled", CoreErrorType.ToolCancelled),
        result("timeout", CoreErrorType.ToolTimeout),
      ];
      const stopped = new AbortController();
      stopped.abort();
      const run = (signal: AbortSignal, preempt: boolean) =>
        withUserStoppedToolResultContent(
          {
            activeForegroundExecution: preempt
              ? { preserveQueueAutoDrainOnCancel: true }
              : undefined,
          } as never,
          { turnAbortSignal: signal } as never,
          results,
        ).map((item) => item.modelContent);

      expect(run(stopped.signal, false)).toEqual([
        undefined,
        USER_STOPPED_TOOL_RESULT_CONTENT,
        undefined,
      ]);
      expect(run(new AbortController().signal, false)).toEqual([undefined, undefined, undefined]);
      expect(run(stopped.signal, true)).toEqual([undefined, undefined, undefined]);
    });

    const MARKER = "[Request interrupted by user]";
    const userTexts = (messages: readonly ModelInputMessage[]) =>
      messages
        .filter((message) => message.role === "user")
        .map((message) => modelMessageContentToText(message.content))
        .filter((text) => !text.startsWith("<system-reminder>"));

    function createCancelRuntime(
      store: ReturnType<typeof createRecordingMessageStore>,
      requests: ModelInputMessage[][],
      stop: (runtime: ReturnType<typeof createTestAgentRuntime>) => void,
    ) {
      const sessionId = createSessionId("runtime-cancel-interrupt-marker");
      const build = () => {
        const runtime: ReturnType<typeof createTestAgentRuntime> = createTestAgentRuntime(
          sessionId,
          { titleGeneration: { enabled: false } },
          {
            eventStore: createTestSessionEventStore(),
            sessionStore: store as unknown as SessionStorePort,
            modelFactory: createTestModelFactory({
              async generateText(request: { messages: ModelInputMessage[] }) {
                requests.push(structuredClone(request.messages));
                if (requests.length === 1) {
                  // 模拟模型请求进行中被停止，没有收到任何输出。
                  stop(runtime);
                  throw new Error("stopped");
                }
                return modelTextResult("answer");
              },
            } as never),
          },
        );
        return runtime;
      };
      return { build };
    }

    it("records the marker after a cancelled request and keeps it after cold resume", async () => {
      const store = createRecordingMessageStore();
      const requests: ModelInputMessage[][] = [];
      const { build } = createCancelRuntime(store, requests, (runtime) =>
        runtime.stopActiveForegroundExecution({ reason: "v4 session stopped" }),
      );
      const runtime = build();
      await expect(runtime.executeTurn("first prompt")).rejects.toMatchObject({
        type: CoreErrorType.TurnCancelled,
      });
      await runtime.executeTurn("next prompt");
      // 前一条 user 文本以换行结尾，标记自身也以换行结尾。
      expect(userTexts(requests[1]!)).toEqual(["first prompt", MARKER, "next prompt"]);
      // 标记按隐藏提醒落盘：不写顶层 source（旧版本 App 按封闭列表校验它），类型在 runtimeMessage。
      const markerPart = store.savedParts.find(
        (part) => part.metadata?.runtimeMessage?.source === "interrupt_marker",
      );
      const markerInfo = store.savedMessages.find(
        (message) => message.id === markerPart?.messageID,
      );
      expect(markerInfo?.source).toBeUndefined();
      expect(markerInfo).toMatchObject({
        visibility: "model-only",
        semantics: {
          origin: "agent_runtime",
          kind: "system_reminder",
          source: "interrupt_marker",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
      });

      const resumed = build();
      await resumed.resumeFromStore();
      await resumed.executeTurn("after resume");
      expect(userTexts(requests[2]!).slice(0, 2)).toEqual(["first prompt", MARKER]);
    });

    it("records the marker when a host fault aborts the turn", async () => {
      const store = createRecordingMessageStore();
      const requests: ModelInputMessage[][] = [];
      const fault = new AbortController();
      const { build } = createCancelRuntime(store, requests, () =>
        fault.abort(createExternalTurnFaultError("proto.payloadTooLarge")),
      );
      const runtime = build();
      await expect(
        runtime.executeTurn("first prompt", undefined, { abortSignal: fault.signal }),
      ).rejects.toMatchObject({ type: CoreErrorType.UnknownError });
      await runtime.executeTurn("next prompt");
      // 宿主故障中止本轮也是中止：与用户停止一样留中断标记。
      expect(userTexts(requests[1]!)).toEqual(["first prompt", MARKER, "next prompt"]);
    });

    it("records no marker when a send-now preempts the turn", async () => {
      const store = createRecordingMessageStore();
      const requests: ModelInputMessage[][] = [];
      const { build } = createCancelRuntime(store, requests, (runtime) =>
        runtime.stopActiveForegroundExecution({ preserveQueueAutoDrainOnCancel: true }),
      );
      const runtime = build();
      await expect(runtime.executeTurn("first prompt")).rejects.toMatchObject({
        type: CoreErrorType.TurnCancelled,
      });
      await runtime.executeTurn("next prompt");
      expect(userTexts(requests[1]!)).toEqual(["first prompt", "next prompt"]);
    });
  });

  it("keeps a cancelled goal paused when resuming the session", async () => {
    const sessionId = createSessionId("runtime-cancel-paused-goal-resume");
    let target: SessionGoal = {
      sessionID: sessionId,
      targetID: "target-paused" as never,
      objective: "Ship the paused goal",
      summaryTitle: null,
      status: "paused",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      time: {
        created: 1,
        updated: 1,
      },
    };
    let updateTargetStatusCalls = 0;
    const sessionStore = {
      async readTarget() {
        return target;
      },
      async updateTargetStatus(input: { status: SessionGoal["status"] }) {
        updateTargetStatusCalls += 1;
        target = {
          ...target,
          status: input.status,
          time: {
            ...target.time,
            updated: target.time.updated + 1,
          },
        };
        return target;
      },
    } as unknown as SessionStorePort;
    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore,
      },
    );

    const resumedTarget = await runtime.activatePausedTargetAfterResume(
      createRootTraceContext({ sessionId }),
    );

    expect(resumedTarget).toMatchObject({ status: "paused" });
    expect(updateTargetStatusCalls).toBe(0);
    await expect(sessionStore.readTarget({ sessionID: sessionId })).resolves.toMatchObject({
      status: "paused",
    });
  });

  it("rejects a cancelled queued prompt before the active turn finishes", async () => {
    const sessionId = createSessionId("runtime-cancel-queued-prompt");
    const firstModelStarted = deferred<void>();
    const firstModelCanFinish = deferred<void>();
    const abortController = new AbortController();
    let modelCallCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      { systemPrompt: "You are a command queue cancellation test agent." },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCallCount += 1;
            if (modelCallCount === 1) {
              firstModelStarted.resolve();
              await firstModelCanFinish.promise;
              return modelTextResult("first complete");
            }
            return modelTextResult("second should not start");
          },
        } as never),
      },
    );

    const firstTurn = runtime.executeTurn("first prompt");
    await firstModelStarted.promise;

    const secondTurn = runtime.executeTurn("second prompt", undefined, {
      abortSignal: abortController.signal,
    });
    let secondRejected = false;
    let secondError: unknown;
    const observedSecondTurn = secondTurn.catch((error) => {
      secondRejected = true;
      secondError = error;
      return error;
    });

    try {
      abortController.abort(new Error("queued prompt cancelled"));
      await waitForMacrotask();

      expect(secondRejected).toBe(true);
      expect(modelCallCount).toBe(1);
    } finally {
      firstModelCanFinish.resolve();
      await firstTurn.catch(() => undefined);
      await observedSecondTurn;
    }

    expect(secondError).toMatchObject({ type: CoreErrorType.TurnCancelled });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function modelTextResult(text: string) {
  return {
    finishReason: "stop",
    model: "test",
    providerMetadata: undefined,
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

async function waitForMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
