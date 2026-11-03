import { describe, expect, it, vi } from "vitest";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { createSubagentMessageSink } from "../src/subagent/message-steering.js";
import { persistSubagentMessageCommand } from "../src/runtime/methods/subagent-messages.js";
import { persistBackgroundTaskNotificationBatch } from "../src/runtime/methods/background-notifications.js";
import { formatTaskNotification } from "../src/runtime-task/notification.js";

function runtime() {
  return {
    sessionId: "parent",
    ensureContextInitialized: vi.fn(),
    messageHistory: new MessageHistoryImpl(),
    persistSyntheticUserNoticeForSession: vi.fn(),
    sessionStore: undefined,
  };
}

describe("incoming message trusted producers", () => {
  it.each([undefined, " summary "])(
    "marks coordinator messages independently of summary=%s",
    async (summary) => {
      const steerTurn = vi.fn(async () => ({
        kind: "queued" as const,
        pendingInputId: "pending",
        queueLength: 1,
        turnId: "turn" as never,
      }));
      const sink = createSubagentMessageSink({ steerTurn }, { traceContext: {} as never });
      await sink.send({ id: "message", message: "raw body", summary } as never);
      expect(steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          inputPresentation: "coordinator_steer",
          // summary 只用于 UI 预览，子 agent 只收到 message。
          input: "raw body",
        }),
      );
    },
  );
  it.each([false, true])("persists peer consumption timing midTurn=%s", async (midTurn) => {
    const target = runtime();
    await persistSubagentMessageCommand.call(
      target as never,
      {
        text: "<subagent-message>raw</subagent-message>",
        traceContext: {},
        id: "command",
        agentId: "child",
      } as never,
      midTurn,
    );
    const marker = midTurn ? "subagent_reply_steer" : "subagent_reply";
    expect(target.messageHistory.toRuntimeEntries()[0]?.metadata).toEqual({
      source: "legacy_synthetic",
      inputPresentation: marker,
    });
    expect(target.persistSyntheticUserNoticeForSession).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "<subagent-message>raw</subagent-message>",
        metadata: expect.objectContaining({ inputPresentation: marker }),
      }),
    );
  });
  // 空闲整批的每条通知存为同一条消息的一个文本块，边界不靠正文猜测；这一轮的输入文本仍以 "\n\n" 相连。
  // 轮中通知每条单独一个 entry，生产中不会成批，保持原来的连接字符串。
  it.each([false, true])(
    "keeps a background batch raw with one marker midTurn=%s",
    async (midTurn) => {
      const target = runtime();
      const persisted = await persistBackgroundTaskNotificationBatch.call(
        target as never,
        [
          { id: "1", text: "one", traceContext: {} },
          { id: "2", text: "two", traceContext: {} },
        ] as never,
        midTurn,
      );
      const content = midTurn
        ? "one\n\ntwo"
        : [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ];
      expect(target.messageHistory.toRuntimeEntries()).toEqual([
        {
          message: { role: "user", content },
          metadata: {
            source: "legacy_synthetic",
            inputPresentation: midTurn ? "task_notification_steer" : "task_notification",
          },
        },
      ]);
      expect(target.persistSyntheticUserNoticeForSession).toHaveBeenCalledOnce();
      expect(target.persistSyntheticUserNoticeForSession).toHaveBeenCalledWith(
        expect.objectContaining({ text: midTurn ? "one\n\ntwo" : ["one", "two"] }),
      );
      expect(persisted.text).toBe("one\n\ntwo");
    },
  );
  it.each(["local_agent", "local_bash", "local_workflow", "monitor_mcp"] as const)(
    "stores only raw notification payload for %s",
    (taskType) => {
      const text = formatTaskNotification({
        taskId: "task",
        taskType,
        status: "completed",
        summary: "done",
      });
      expect(text).toMatch(/^<task-notification>/);
      expect(text).not.toContain("[SYSTEM NOTIFICATION");
    },
  );
});
