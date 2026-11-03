// user 角色记录的工具名单（docs/design/v2/session-persistence.md `MessageInfo.User.tools`）：
// 只有用户输入记录写 tools；隐藏提醒、合成通知和 compact 摘要不写。
import { describe, expect, it } from "vitest";
import type { MessageInfo, TraceContext } from "@zcode/contracts";
import { createMessageId, createTraceId, createTurnId } from "@zcode/contracts";
import { systemReminderAttachmentEntry } from "../src/agent/message-history.js";
import { persistCompactSummary } from "../src/runtime/methods/compact-persistence.js";
import {
  persistSyntheticUserNoticeForSession,
  persistUserPrompt,
} from "../src/runtime/methods/message-persistence.js";
import { buildRuntimeReminderMessage } from "../src/runtime/methods/runtime-reminder-persistence.js";

const SESSION_ID = "session-user-record-tools";

function createHarness() {
  const saved: MessageInfo[] = [];
  const runtime = {
    latestConversationMessageId: null as string | null,
    latestAssistantMessageId: null as string | null,
    latestAssistantTurnId: null as string | null,
    sessionId: SESSION_ID,
    sessionStore: {},
    workingDirectory: "/tmp/w",
    workspaceRoot: "/tmp/w",
    config: { agentName: "test-agent", systemPrompt: "sys", envInfo: undefined },
    getSessionModelSelection: () => ({ providerId: "prov", modelId: "model" }),
    getTools: () => [{ name: "Bash" }, { name: "Read" }],
    getPlanEnabled: () => false,
    async persistMessage(input: MessageInfo) {
      saved.push(input);
    },
    async persistPart() {},
    logger: undefined,
  };
  return { saved, runtime };
}

function trace(): TraceContext {
  return { traceId: createTraceId(), turnId: createTurnId() };
}

describe("user 记录的工具名单", () => {
  it("用户输入记录写当次工具名单", async () => {
    const { saved, runtime } = createHarness();
    await persistUserPrompt.call(runtime as never, createMessageId(), "hello", undefined, trace());
    expect(saved[0]).toMatchObject({ role: "user", tools: { Bash: true, Read: true } });
  });

  it("合成通知不写工具名单", async () => {
    const { saved, runtime } = createHarness();
    await persistSyntheticUserNoticeForSession.call(runtime as never, {
      messageID: createMessageId(),
      sessionId: SESSION_ID as never,
      source: "todo_reminder",
      text: "todo",
      traceContext: trace(),
    });
    expect(saved[0]?.role).toBe("user");
    expect(saved[0]).not.toHaveProperty("tools");
  });

  it("隐藏提醒不写工具名单", () => {
    const { runtime } = createHarness();
    const record = buildRuntimeReminderMessage(
      runtime as never,
      systemReminderAttachmentEntry("todo_reminder", "<system-reminder>x</system-reminder>"),
    );
    expect(record?.info.role).toBe("user");
    expect(record?.info).not.toHaveProperty("tools");
    // 每条隐藏提醒都存一份自定义 system prompt 会让记录成倍膨胀。
    expect(record?.info).not.toHaveProperty("system");
  });

  it("compact 摘要和随附提醒都不写工具名单", async () => {
    const { saved, runtime } = createHarness();
    await persistCompactSummary.call(
      runtime as never,
      createMessageId(),
      "compact content",
      "compact summary",
      { trigger: "manual", phase: "post_response", compactReason: "manual" } as never,
      trace(),
      {
        postCompactReminderEntries: [
          systemReminderAttachmentEntry("todo_reminder", "<system-reminder>y</system-reminder>"),
        ],
      },
    );
    expect(saved.map((message) => message.role)).toEqual(["user", "user"]);
    for (const message of saved) expect(message).not.toHaveProperty("tools");
  });
});
