import { describe, expect, it } from "vitest";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

const TODO = "TODO_AFTER_ERROR";

describe("folded reminders in a failed tool result", () => {
  it("joins the reminder to string error content with a blank line and keeps the error flag", () => {
    const entries = [
      { message: { role: "user", content: "run it" }, metadata: { source: "real_user" } },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-failed", name: "Bash", input: { command: "false" } }],
        },
      },
      {
        message: {
          role: "tool",
          toolCallId: "call-failed",
          toolName: "Bash",
          content: "command failed",
          isError: true,
        },
      },
      { kind: "attachment", content: TODO, metadata: { source: "todo_reminder" } },
    ] satisfies RuntimeMessageEntry[];

    const messages = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
      foldRemindersIntoToolResults: true,
    }).messages;

    // 失败结果是字符串时，提醒以空行接在错误文本之后；仍是一条失败的 tool result，后面没有单独的提醒消息。
    const tool = messages.find((message) => message.role === "tool");
    expect(tool?.isError).toBe(true);
    expect(typeof tool?.content).toBe("string");
    expect(tool?.content).toMatch(/^command failed\n\n<system-reminder>\n[\s\S]*TODO_AFTER_ERROR/);
    expect(messages.at(-1)).toBe(tool);
  });
});
