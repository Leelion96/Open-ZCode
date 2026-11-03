// 流式追加不重算命令 actions（docs/v4-refactor/02-projection.md「命令 actions 的物化时机」）。
//
// 钉住两件事：
// 1. 哪些事件跳过 materializeCommandRowActions：对已打开流式行的追加，且本事件归约结果只有
//    row.delta 或为空；附带其他增量（如清除 apiRetry 的 state.updated）的追加照常物化。
//    由“是否调用物化”的逐事件断言锁定。
// 2. 跳过不改变输出：与每个事件都物化的参考投影逐事件比较 delta、snapshot 与 edit target。
//    它能抓到“只产 row.delta 却改写侧表”而让 canEdit 或历史轮 canFork 变化的回归；运行中的
//    轮次里 canRetry、canRewindFiles 和本轮 canFork 本来就关闭，判据宽窄由第 1 条锁定。
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionEventType as SessionEventTypeUnion,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import type { ConversationDelta, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const BASE_TIMESTAMP_MS = 1_700_000_000_000;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const HISTORY_TURNS = 3;
const LIVE_TURN_ID = "turn-live";
const ACTION_KEYS = ["canEdit", "canRetry", "canFork", "canRewindFiles"];
const STREAMING_APPEND_KINDS = ["reasoning_delta", "text_delta", "tool_input_delta"];

/** 归约结果为空的追加的成因：工具输入已定稿后迟到，或文件工具预览被节流。 */
type EmptyAppendReason = "finalized" | "throttled";
const EMPTY_APPEND_REASONS: EmptyAppendReason[] = ["finalized", "throttled"];

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { turnId?: string; timestampMs?: number } = {},
  ): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(opts.timestampMs ?? BASE_TIMESTAMP_MS + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

/** 测试只通过这两个私有方法观察与控制物化；不依赖其他内部状态。 */
type ActionMaterialization = {
  materializeCommandRowActions: (...args: unknown[]) => unknown;
  shouldMaterializeCommandRowActions: (...args: unknown[]) => boolean;
};

function internals(projection: ProductProjection): ActionMaterialization {
  return projection as unknown as ActionMaterialization;
}

function userMessageId(turn: number | string): string {
  return `message-user-${turn}`;
}

/**
 * 逐事件比较跳过物化的投影与总是物化的参考投影，并断言只有 skipped 中的事件不调用物化。
 * 返回被测投影每个事件后的 delta 与 snapshot，以及出现过的 action 键，供用例补充断言。
 */
function replayAgainstReference(
  events: readonly SessionEvent[],
  skipped: ReadonlySet<string>,
  userEntityIds: readonly string[],
): {
  deltasByEventId: Map<string, ConversationDelta[]>;
  snapshotByEventId: Map<string, ConversationSnapshot>;
  seenActions: Set<string>;
} {
  const subject = new ProductProjection("session-1", "epoch-1");
  const reference = new ProductProjection("session-1", "epoch-1");
  vi.spyOn(internals(reference), "shouldMaterializeCommandRowActions").mockReturnValue(true);
  const materialize = vi.spyOn(internals(subject), "materializeCommandRowActions");
  const deltasByEventId = new Map<string, ConversationDelta[]>();
  const snapshotByEventId = new Map<string, ConversationSnapshot>();
  const seenActions = new Set<string>();

  for (const event of events) {
    const callsBefore = materialize.mock.calls.length;
    const deltas = subject.applyEvent(event);
    deltasByEventId.set(event.id, deltas);
    snapshotByEventId.set(event.id, subject.getSnapshot());
    expect(deltas, event.id).toEqual(reference.applyEvent(event));
    expect(subject.getSnapshot(), event.id).toEqual(reference.getSnapshot());
    for (const entityId of userEntityIds) {
      expect(subject.resolveEditTargetByEntityId(entityId), `${event.id} ${entityId}`).toEqual(
        reference.resolveEditTargetByEntityId(entityId),
      );
    }
    const materialized = materialize.mock.calls.length > callsBefore;
    expect(materialized, event.id).toBe(!skipped.has(event.id));
    for (const row of subject.getSnapshot().rows.window) {
      for (const key of Object.keys(row.actions ?? {})) seenActions.add(key);
    }
  }
  return { deltasByEventId, snapshotByEventId, seenActions };
}

/** 已完成的历史轮：真实用户输入、带 messageId 的正文、文件改动，使四种 actions 都有输入。 */
function pushHistoryTurn(log: EventLog, turn: number, skipped: Set<string>): void {
  const turnId = `turn-${turn}`;
  log.push(
    SessionEventType.TurnStarted,
    { turnNumber: turn, input: `问题 ${turn}`, messageId: userMessageId(turn) },
    { turnId },
  );
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_start", delta: "", done: false, assistantMessageId: `message-assistant-${turn}` },
    { turnId },
  );
  const textDelta = log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_delta", delta: `回答 ${turn}`, done: false },
    { turnId },
  );
  skipped.add(textDelta.id);
  log.push(
    SessionEventType.ModelStreaming,
    { kind: "text_end", delta: "", done: false },
    { turnId },
  );
  log.push(
    SessionEventType.ModelComplete,
    {
      content: `回答 ${turn}`,
      stopReason: "stop",
      querySource: "main_turn",
      contextWindow: 200_000,
      usage: USAGE,
      fileChanges: {
        files: 1,
        additions: 2,
        deletions: 1,
        items: [{ path: `/work/${turn}.ts`, additions: 2, deletions: 1, writeCount: 1 }],
      },
    },
    { turnId },
  );
  log.push(
    SessionEventType.TurnComplete,
    {
      response: `回答 ${turn}`,
      tokenCount: 2,
      toolCallCount: 0,
      duration: 1,
      resultType: "success",
    },
    { turnId },
  );
}

/**
 * 运行中的一轮：reasoning、正文、普通工具与文件工具的流式输入，夹着各种边界事件。
 * 应跳过物化的事件记入 skipped；其中归约结果为空的再按成因记入 emptyAppends。
 */
function pushLiveTurn(
  log: EventLog,
  skipped: Set<string>,
  emptyAppends: Map<string, EmptyAppendReason>,
): void {
  const turnId = LIVE_TURN_ID;
  const stream = (payload: Record<string, unknown>, timestampMs?: number) =>
    log.push(
      SessionEventType.ModelStreaming,
      { delta: "", done: false, ...payload },
      { turnId, timestampMs },
    );
  const skip = (payload: Record<string, unknown>, timestampMs?: number) => {
    const event = stream(payload, timestampMs);
    skipped.add(event.id);
    return event;
  };
  const skipEmpty = (
    reason: EmptyAppendReason,
    payload: Record<string, unknown>,
    timestampMs?: number,
  ) => {
    emptyAppends.set(skip(payload, timestampMs).id, reason);
  };

  log.push(
    SessionEventType.TurnStarted,
    { turnNumber: HISTORY_TURNS + 1, input: "当前问题", messageId: userMessageId("live") },
    { turnId },
  );
  stream({ kind: "reasoning_start" });
  skip({ kind: "reasoning_delta", delta: "先想" });
  skip({ kind: "reasoning_delta", delta: "再想" });
  stream({ kind: "reasoning_end" });
  stream({ kind: "text_start", assistantMessageId: "message-assistant-live-1" });
  skip({ kind: "text_delta", delta: "正在" });
  skip({ kind: "text_delta", delta: "处理" });
  skip({ kind: "text_delta", delta: "。" });
  stream({ kind: "text_end" });

  stream({ kind: "tool_input_start", toolCallId: "tc-bash", toolName: "Bash" });
  skip({ kind: "tool_input_delta", delta: '{"command":', toolCallId: "tc-bash" });
  skip({ kind: "tool_input_delta", delta: '"ls"}', toolCallId: "tc-bash" });
  stream({
    kind: "tool_call",
    done: true,
    input: { command: "ls" },
    toolCallId: "tc-bash",
    toolName: "Bash",
  });
  // 工具输入已定稿后迟到的原始流：仍是已登记工具行的追加，归约结果为空。
  skipEmpty("finalized", { kind: "tool_input_delta", delta: " ", toolCallId: "tc-bash" });
  log.push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId: "tc-bash",
      toolName: "Bash",
      input: { command: "ls" },
      schedule: { parallelGroups: [["tc-bash"]], executionOrder: ["tc-bash"] },
    },
    { turnId },
  );
  log.push(
    SessionEventType.ToolCallStarted,
    { toolCallId: "tc-bash", toolName: "Bash", startedAt: new Date(BASE_TIMESTAMP_MS) },
    { turnId },
  );
  log.push(
    SessionEventType.ToolCallResult,
    { toolCallId: "tc-bash", result: { success: true, content: "ok" }, duration: 10 },
    { turnId },
  );

  // 文件工具预览按时间节流：后两条与首条同一时刻，落在节流间隔内，归约结果为空。
  stream({ kind: "tool_input_start", toolCallId: "tc-write", toolName: "Write" });
  const firstWriteDelta = skip({
    kind: "tool_input_delta",
    delta: '{"file_path":"/work/b.ts",',
    toolCallId: "tc-write",
  });
  const throttledAt = firstWriteDelta.timestamp.getTime();
  skipEmpty(
    "throttled",
    { kind: "tool_input_delta", delta: '"content":', toolCallId: "tc-write" },
    throttledAt,
  );
  skipEmpty(
    "throttled",
    { kind: "tool_input_delta", delta: '"x"}', toolCallId: "tc-write" },
    throttledAt,
  );
  stream({ kind: "tool_input_end", toolCallId: "tc-write" });
  stream({
    kind: "tool_call",
    done: true,
    input: { file_path: "/work/b.ts", content: "x" },
    toolCallId: "tc-write",
    toolName: "Write",
  });

  // 没有 text_start 的 text_delta 会新开一行，不是已打开行的追加。
  stream({ kind: "text_delta", delta: "完成" });
  stream({ kind: "text_end" });
  log.push(
    SessionEventType.ModelComplete,
    {
      content: "完成",
      stopReason: "stop",
      querySource: "main_turn",
      contextWindow: 200_000,
      usage: USAGE,
      fileChanges: {
        files: 1,
        additions: 1,
        deletions: 0,
        items: [{ path: "/work/b.ts", additions: 1, deletions: 0, writeCount: 1 }],
      },
    },
    { turnId },
  );
  log.push(
    SessionEventType.TurnComplete,
    { response: "完成", tokenCount: 2, toolCallCount: 2, duration: 1, resultType: "success" },
    { turnId },
  );
  // 轮结束后迟到的 delta 被拒收，不是已打开行的追加。
  stream({ kind: "text_delta", delta: "迟到" });
}

function pushCompact(log: EventLog): void {
  log.push(SessionEventType.CompactStarted, {
    operationId: "compact-1",
    messageId: "compact-message",
    status: "started",
    trigger: "manual",
    display: "separator",
  });
  log.push(SessionEventType.CompactCompleted, {
    operationId: "compact-1",
    messageId: "compact-message",
    status: "completed",
    trigger: "manual",
    display: "separator",
  });
}

function streamingKind(event: SessionEvent): string {
  return String((event.payload as { kind?: unknown }).kind);
}

describe("命令 actions 的物化时机", () => {
  it("只跳过对已打开流式行的追加，逐事件输出与总是物化的参考投影相同", () => {
    const log = new EventLog();
    const skipped = new Set<string>();
    const emptyAppends = new Map<string, EmptyAppendReason>();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    for (let turn = 1; turn <= HISTORY_TURNS; turn += 1) pushHistoryTurn(log, turn, skipped);
    pushLiveTurn(log, skipped, emptyAppends);
    pushCompact(log);
    const userEntityIds = [
      ...Array.from({ length: HISTORY_TURNS }, (_, index) => userMessageId(index + 1)),
      userMessageId("live"),
    ];

    const { deltasByEventId, seenActions } = replayAgainstReference(
      log.events,
      skipped,
      userEntityIds,
    );

    // 归约结果为空的追加确实为空，且两种成因都在：节流间隔或迟到处理变化时，这条覆盖不会悄悄丢失。
    for (const eventId of emptyAppends.keys()) {
      expect(deltasByEventId.get(eventId), eventId).toEqual([]);
    }
    expect([...new Set(emptyAppends.values())].sort()).toEqual(EMPTY_APPEND_REASONS);
    // 三种流式追加都被跳过过。
    const skippedKinds = new Set(
      log.events.filter((event) => skipped.has(event.id)).map(streamingKind),
    );
    expect([...skippedKinds].sort()).toEqual(STREAMING_APPEND_KINDS);
    // 语料确实让四种 actions 都出现过，比较不是在全空的 actions 上通过。
    expect([...seenActions]).toEqual(expect.arrayContaining(ACTION_KEYS));
  });

  it("流式追加附带 state.updated（清除 apiRetry）时照常物化", () => {
    const log = new EventLog();
    const turnId = "turn-retry";
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.push(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "触发模型请求", messageId: userMessageId("retry") },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false, assistantMessageId: "message-assistant-retry" },
      { turnId },
    );
    const beforeRetry = log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "部分", done: false },
      { turnId },
    );
    const scheduled = log.push(
      SessionEventType.ModelNetworkStatus,
      {
        timestamp: "2026-10-29T00:00:00.000Z",
        traceId: "trace-1",
        requestId: "request-retry",
        model: { providerId: "bigmodel", modelId: "glm-5.2" },
        transport: "sse",
        attempt: 1,
        maxAttempts: 11,
        type: "model_retry_scheduled",
        delayMs: 2_000,
        nextAttempt: 2,
        reason: "rate_limited",
        message: "rate limited",
        statusCode: 429,
      },
      { turnId },
    );
    const recovered = log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "恢复", done: false },
      { turnId },
    );

    const { deltasByEventId, snapshotByEventId } = replayAgainstReference(
      log.events,
      new Set([beforeRetry.id]),
      [userMessageId("retry")],
    );

    // 重试排期后 apiRetry 有值，这条追加把它清除：归约结果不只有 row.delta，所以必须物化
    // （由比较内的调用断言检查）。
    expect(snapshotByEventId.get(scheduled.id)?.control.apiRetry).toMatchObject({
      reasonCode: "fault.provider.rateLimited",
    });
    expect(snapshotByEventId.get(recovered.id)?.control.apiRetry).toBeNull();
    const recoveredOps = (deltasByEventId.get(recovered.id) ?? []).map((delta) => delta.op);
    expect(recoveredOps).toEqual(expect.arrayContaining(["row.delta", "state.updated"]));
  });
});
