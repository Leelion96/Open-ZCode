// 手机远控输入预测线格式（docs/web-remote-control/mobile-input-prediction.md）。
import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  emptyInputPredictionResult,
  helloMessageSchema,
  v4ConversationInputPredictionParamsSchema,
  v4ConversationInputPredictionResultSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("v4/conversation/inputPrediction 线格式", () => {
  it("方法名固定", () => {
    expect(V4_METHODS.conversationInputPrediction).toBe("v4/conversation/inputPrediction");
  });

  it("params 严格校验", () => {
    const parse = (value: unknown) => v4ConversationInputPredictionParamsSchema.safeParse(value);
    expect(parse({ sessionId: "s", revision: 0 }).success).toBe(true);
    expect(parse({ sessionId: "s", revision: 3, draft: "帮我", requestId: "r1" }).success).toBe(
      true,
    );
    expect(parse({ sessionId: "", revision: 0 }).success).toBe(false);
    expect(parse({ sessionId: "s", revision: -1 }).success).toBe(false);
    expect(parse({ sessionId: "s", revision: 1.5 }).success).toBe(false);
    expect(parse({ sessionId: "s", revision: 0, draft: "x".repeat(4001) }).success).toBe(false);
    expect(parse({ sessionId: "s", revision: 0, requestId: "" }).success).toBe(false);
    expect(parse({ sessionId: "s", revision: 0, unknown: true }).success).toBe(false);
  });

  it("result：候选不 trim 但不能纯空白 / 换行 / 超长，最多 3 个", () => {
    const parse = (candidates: unknown[]) =>
      v4ConversationInputPredictionResultSchema.safeParse({
        decision: "show",
        candidates,
        topConfidence: 0.9,
      });
    expect(parse([{ text: " tests", confidence: 0.9 }]).success).toBe(true);
    expect(parse([{ text: "  ", confidence: 0.9 }]).success).toBe(false);
    expect(parse([{ text: "a\nb", confidence: 0.9 }]).success).toBe(false);
    expect(parse([{ text: "x".repeat(41), confidence: 0.9 }]).success).toBe(false);
    expect(parse([{ text: "a", confidence: 1.1 }]).success).toBe(false);
    expect(parse(Array.from({ length: 4 }, () => ({ text: "a", confidence: 0.5 }))).success).toBe(
      false,
    );
  });

  it("空结果构造器只回显给定 requestId", () => {
    expect(emptyInputPredictionResult("unavailable")).toEqual({
      decision: "unavailable",
      candidates: [],
      topConfidence: 0,
    });
    expect(
      v4ConversationInputPredictionResultSchema.parse(emptyInputPredictionResult("cancelled", "r")),
    ).toEqual({ decision: "cancelled", candidates: [], topConfidence: 0, requestId: "r" });
  });

  it("hello.capabilities.inputPrediction 可选：老 Host 缺席仍能解析", () => {
    const hello = {
      kind: "hello",
      protocolVersion: 3,
      connectionId: "c",
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    };
    expect(helloMessageSchema.parse(hello).capabilities.inputPrediction).toBeUndefined();
    expect(
      helloMessageSchema.parse({
        ...hello,
        capabilities: { ...hello.capabilities, inputPrediction: true },
      }).capabilities.inputPrediction,
    ).toBe(true);
  });
});
