import { describe, expect, it } from "vitest";
import {
  LOCAL_TOOL_SEARCH_NAME,
  ModelRequestSessionFeature,
  TOOL_SEARCH_NAME,
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import {
  sessionFeatureFromToolSearchExposure,
  sessionFeaturesFromPersistedMessages,
  sessionFeaturesFromToolResult,
} from "../../src/runtime/session-features/contract.js";

// 规格：docs/design/v2/model/session-features-header.md 的 ToolSearch 标签；主循环端到端见 tool-search-turn.test.ts。
const { ToolSearchCalled, ToolSearchLocal, ToolSearchNative } = ModelRequestSessionFeature;
const searchOutput = { query: "select:WebFetch", matches: ["WebFetch"], total_deferred_tools: 1 };

describe("sessionFeaturesFromToolResult：tool_search_called", () => {
  it("ToolSearch 执行成功就打，包括没有匹配结果", () => {
    for (const output of [searchOutput, { ...searchOutput, matches: [] }]) {
      expect(
        sessionFeaturesFromToolResult({ toolName: TOOL_SEARCH_NAME, success: true, output }),
      ).toEqual([ToolSearchCalled]);
    }
  });

  it("local 模式的原始名 LocalToolSearch 同样识别；执行失败不打", () => {
    expect(
      sessionFeaturesFromToolResult({
        toolName: LOCAL_TOOL_SEARCH_NAME,
        success: true,
        output: searchOutput,
      }),
    ).toEqual([ToolSearchCalled]);
    // 例如请求未启用 ToolSearch 时 handler 抛错。
    expect(
      sessionFeaturesFromToolResult({ toolName: TOOL_SEARCH_NAME, success: false, output: "" }),
    ).toEqual([]);
  });
});

describe("sessionFeaturesFromPersistedMessages：tool_search_called", () => {
  const sessionId = createSessionId("session-features-tool-search-history");

  it("completed 的工具 part 推出标签：规范名与 LocalToolSearch 都覆盖", () => {
    for (const tool of [TOOL_SEARCH_NAME, LOCAL_TOOL_SEARCH_NAME]) {
      expect(sessionFeaturesFromPersistedMessages([toolMessage(sessionId, tool)])).toEqual(
        new Set([ToolSearchCalled]),
      );
    }
  });

  it("未完成或失败的调用、其他工具不推出", () => {
    expect(
      sessionFeaturesFromPersistedMessages([
        // pending/running 阶段写的是原始名；中断后停在这里的调用不算。
        toolMessage(sessionId, LOCAL_TOOL_SEARCH_NAME, "pending"),
        toolMessage(sessionId, LOCAL_TOOL_SEARCH_NAME, "running"),
        toolMessage(sessionId, TOOL_SEARCH_NAME, "error"),
        toolMessage(sessionId, "Read"),
      ]),
    ).toEqual(new Set());
  });
});

describe("sessionFeatureFromToolSearchExposure", () => {
  it("按实际生效模式取标签；未生效不打", () => {
    expect(sessionFeatureFromToolSearchExposure({ enabled: true, mode: "native" })).toBe(
      ToolSearchNative,
    );
    expect(sessionFeatureFromToolSearchExposure({ enabled: true, mode: "local" })).toBe(
      ToolSearchLocal,
    );
    // 设置为 native/local，但没有 deferred 工具或缺少控制工具时 enabled 为假、mode 为 off。
    expect(sessionFeatureFromToolSearchExposure({ enabled: false, mode: "off" })).toBeUndefined();
  });
});

function toolMessage(
  sessionId: SessionId,
  tool: string,
  status: "pending" | "running" | "completed" | "error" = "completed",
): MessageWithParts {
  const messageId = createMessageId();
  const time = { start: 1, end: 2 };
  const state =
    status === "completed"
      ? { status, input: {}, output: "loaded", title: tool, metadata: {}, time }
      : status === "error"
        ? { status, input: {}, error: "failed", metadata: {}, time }
        : { status, input: {}, raw: "{}", time: { start: 1 } };
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      agent: "zcode-agent",
      time: { created: 2, completed: 3 },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: createPartId("t"),
        messageID: messageId,
        sessionID: sessionId,
        type: "tool",
        callID: "call_search",
        tool,
        state,
      },
    ],
  } as unknown as MessageWithParts;
}
