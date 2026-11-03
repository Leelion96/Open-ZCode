import { describe, expect, it } from "vitest";
import {
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createSessionId,
  type MessagePart,
  type MessageWithParts,
} from "@zcode/contracts";
import { MessageHistoryImpl } from "../../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../src/agent/session-history-hydrator.js";

// 冷恢复边界：一条持久化 assistant 里服务端内置工具轮次与本地工具、正文、作废标记、异常结果的组合。
// 实时流切轮的端到端对照见 adapters/tests/provider-builtin-tool-rounds.test.ts。
const sessionID = createSessionId("provider-round-hydration");
const userID = createMessageId("provider-round-user");
const assistantID = createMessageId("provider-round-assistant");
const modelID = createModelId("glm-test");
const providerID = createModelProviderId("zai");
const tokens = {
  input: 36_999,
  output: 277,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total: 37_276,
};

function user(): MessageWithParts {
  return {
    info: {
      id: userID,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "zcode-agent",
      model: { providerID, modelID },
    },
    parts: [{ id: createPartId("u"), messageID: userID, sessionID, type: "text", text: "看图" }],
  };
}

function assistant(parts: MessagePart[], extra: Record<string, unknown> = {}): MessageWithParts {
  return {
    info: {
      id: assistantID,
      sessionID,
      role: "assistant",
      time: { created: 2, completed: 3 },
      parentID: userID,
      modelID,
      providerID,
      mode: "build",
      agent: "zcode-agent",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0,
      tokens,
      ...extra,
    } as MessageWithParts["info"],
    parts,
  };
}

let partSeq = 0;
const text = (value: string): MessagePart => ({
  id: createPartId(`text-${++partSeq}`),
  messageID: assistantID,
  sessionID,
  type: "text",
  text: value,
});
const providerTool = (state: "completed" | "error"): MessagePart => ({
  id: createPartId(`provider-${++partSeq}`),
  messageID: assistantID,
  sessionID,
  type: "tool",
  callID: "call_image",
  tool: "analyze_image",
  metadata: { providerExecuted: true },
  state:
    state === "completed"
      ? {
          status: "completed",
          input: { imageSource: "https://cdn.example.test/shot.png" },
          output: "Order Console",
          title: "analyze_image",
          metadata: {},
          time: { start: 1, end: 2 },
        }
      : {
          status: "error",
          input: { imageSource: "https://cdn.example.test/shot.png" },
          error: "[Server-side tool execution was interrupted before its result arrived]",
          metadata: {},
          time: { start: 1, end: 2 },
        },
});
const localRead = (): MessagePart => ({
  id: createPartId(`read-${++partSeq}`),
  messageID: assistantID,
  sessionID,
  type: "tool",
  callID: "call_read",
  tool: "Read",
  state: {
    status: "completed",
    input: { file_path: "README.md" },
    output: "# Demo",
    title: "Read",
    metadata: {},
    time: { start: 2, end: 3 },
  },
});

async function hydrate(message: MessageWithParts) {
  const history = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({ history, messages: [user(), message] });
  return history
    .toRuntimeEntries()
    .filter((entry) => "message" in entry && entry.message.role !== "user");
}

describe("provider tool round hydration", () => {
  it.each([
    [
      "local tool before the trailing text",
      () => [text("先看图"), providerTool("completed"), localRead(), text("再读文件")],
    ],
    [
      "local tool after the trailing text",
      () => [text("先看图"), providerTool("completed"), text("再读文件"), localRead()],
    ],
  ])("splits a round followed by a local tool call (%s)", async (_name, parts) => {
    const entries = await hydrate(assistant(parts()));
    expect(entries.map((entry) => "message" in entry && entry.message)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "先看图",
        toolCalls: [expect.objectContaining({ id: "call_image", name: "analyze_image" })],
      }),
      expect.objectContaining({ role: "tool", toolCallId: "call_image", content: "Order Console" }),
      expect.objectContaining({
        role: "assistant",
        content: "再读文件",
        toolCalls: [expect.objectContaining({ id: "call_read", name: "Read" })],
      }),
      expect.objectContaining({ role: "tool", toolCallId: "call_read" }),
    ]);
    // 两条 assistant 属于同一条持久化消息：同一个 compact 分组键，且不挂合计 usage。
    const assistants = entries.filter(
      (entry) => "message" in entry && entry.message.role === "assistant",
    );
    expect(
      new Set(assistants.map((entry) => "compactGroupKey" in entry && entry.compactGroupKey)),
    ).toEqual(new Set([assistantID]));
    expect(entries.some((entry) => "tokens" in entry && entry.tokens)).toBe(false);
  });

  it("replays an interrupted server tool as an error result", async () => {
    const entries = await hydrate(
      assistant([text("先看图"), providerTool("error"), text("没拿到结果")]),
    );
    expect(entries[1]).toMatchObject({
      message: {
        role: "tool",
        toolCallId: "call_image",
        isError: true,
        content: "[Server-side tool execution was interrupted before its result arrived]",
      },
    });
  });

  it("keeps no empty usage anchor when a round has no trailing text", async () => {
    const entries = await hydrate(assistant([text("先看图"), providerTool("completed")]));
    expect(entries.map((entry) => "message" in entry && entry.message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(entries.some((entry) => "tokens" in entry && entry.tokens)).toBe(false);
  });

  it("drops rounds and text of a discarded attempt but keeps its settled local tool", async () => {
    const entries = await hydrate(
      assistant([text("先看图"), providerTool("completed"), text("再读文件"), localRead()], {
        error: { name: STREAM_RECOVERY_DISCARDED_ERROR_NAME, data: { message: "discarded" } },
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("call_image");
    expect(JSON.stringify(entries)).not.toContain("先看图");
    expect(entries.map((entry) => "message" in entry && entry.message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(entries[0]).toMatchObject({
      message: { toolCalls: [expect.objectContaining({ id: "call_read" })] },
    });
  });
});
