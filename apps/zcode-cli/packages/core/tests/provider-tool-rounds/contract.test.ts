import { describe, expect, it } from "vitest";
import type { ModelToolCall } from "@zcode/contracts";
import {
  createProviderToolRoundEntries,
  hasProviderToolRoundContent,
  isProviderExecutedToolPartMetadata,
  providerToolOutputText,
  providerToolRoundsCompactGroupKey,
  withCompactGroupKey,
  type ProviderToolRound,
} from "../../src/runtime/provider-tool-rounds/contract.js";

const toolCall: ModelToolCall = {
  id: "call_image",
  name: "analyze_image",
  input: { imageSource: "https://cdn.example.test/shot.png" },
  providerExecuted: true,
};

// 端到端行为（流切轮、落盘、卡片事件、冷恢复）见 adapters/tests/provider-builtin-tool-rounds.test.ts。
describe("provider-tool-rounds contract", () => {
  it("replays a completed round as assistant tool_use followed by its tool result", () => {
    const round: ProviderToolRound = {
      messageId: "msg_provider_round",
      reasoning: [],
      text: "先看图",
      toolCall,
      result: { output: "Order Console", isError: false },
    };
    const entries = createProviderToolRoundEntries([round]);
    expect(entries.map((entry) => "message" in entry && entry.message.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(entries[0]).toMatchObject({
      message: { content: "先看图", toolCalls: [{ id: "call_image", name: "analyze_image" }] },
    });
    expect(entries[1]).toMatchObject({
      message: { toolCallId: "call_image", content: "Order Console", isError: false },
    });
  });

  it("replays an interrupted round without a dangling tool_use", () => {
    const entries = createProviderToolRoundEntries([
      { messageId: "msg_provider_round", reasoning: [], text: "先看图", toolCall },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ message: { role: "assistant", content: "先看图" } });
    expect("message" in entries[0]! && entries[0].message.toolCalls).toBeUndefined();
  });

  it("normalizes provider tool output and recognizes the persisted marker", () => {
    expect(
      providerToolOutputText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
    expect(isProviderExecutedToolPartMetadata({ providerExecuted: true })).toBe(true);
    expect(isProviderExecutedToolPartMetadata({})).toBe(false);
    expect(hasProviderToolRoundContent([])).toBe(false);
  });

  it("tags every assistant entry of one stored response with the same compact group key", () => {
    const round: ProviderToolRound = {
      messageId: "msg_provider_round",
      reasoning: [],
      text: "先看图",
      toolCall,
      result: { output: "Order Console", isError: false },
    };
    const key = providerToolRoundsCompactGroupKey([round]);
    // 键是持久化消息 id，而不是只在单次响应内唯一的工具调用 id。
    expect(key).toBe("msg_provider_round");
    expect(providerToolRoundsCompactGroupKey([])).toBeUndefined();
    const entries = withCompactGroupKey(createProviderToolRoundEntries([round]), key);
    expect(entries.map((entry) => "compactGroupKey" in entry && entry.compactGroupKey)).toEqual([
      key,
      false,
    ]);
    // 没有轮次时不打键，保持原来每条 assistant 各自成组。
    expect(withCompactGroupKey(entries, undefined)).toEqual(entries);
  });
});
