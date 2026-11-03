// 输入预测 sidecar 纯函数与编排壳（docs/web-remote-control/mobile-input-prediction.md）。
import { describe, expect, it, vi } from "vitest";
import { v4ConversationInputPredictionResultSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  INPUT_PREDICTION_QUERY_SOURCE,
  buildInputPredictionContext,
  buildInputPredictionMessages,
  decideInputPrediction,
  generateInputPredictionCandidates,
  inputPredictionMinTurns,
  normalizeInputPredictionDraft,
  parseInputPredictionResponse,
  toInputPredictionSuffix,
  type InputPredictionModelCall,
  type InputPredictionTurnContext,
} from "../src/runtime/methods/input-prediction-sidecar.js";

const turns: InputPredictionTurnContext[] = [
  { userText: "帮我看下 lint 报错", assistantText: "已修复 3 处" },
  { userText: "再跑一遍单测", assistantText: "全部通过" },
];

describe("parseInputPredictionResponse", () => {
  it("解析纯 JSON", () => {
    expect(
      parseInputPredictionResponse('{"candidates":[{"text":"提交吧","confidence":0.9}]}'),
    ).toEqual([{ text: "提交吧", confidence: 0.9 }]);
  });

  it("容忍 think 段、code fence、尾逗号与前后说明", () => {
    const raw =
      '<think>想一想</think>\n```json\n{"candidates":[{"text":"提交吧","confidence":0.9},]}\n```';
    expect(parseInputPredictionResponse(raw)).toEqual([{ text: "提交吧", confidence: 0.9 }]);
    expect(
      parseInputPredictionResponse('结果如下：{"candidates":[{"text":"好","confidence":0.5}]} 完'),
    ).toEqual([{ text: "好", confidence: 0.5 }]);
  });

  it("结构不对或没有有效候选时返回 null", () => {
    expect(parseInputPredictionResponse("不是 JSON")).toBeNull();
    expect(parseInputPredictionResponse('{"candidates":[]}')).toBeNull();
    expect(parseInputPredictionResponse('{"candidates":[{"text":1,"confidence":0.9}]}')).toBeNull();
    expect(parseInputPredictionResponse("[]")).toBeNull();
  });
});

describe("toInputPredictionSuffix", () => {
  it("无草稿时单行化并两端 trim", () => {
    expect(toInputPredictionSuffix("  提交\n代码  ", "")).toBe("提交 代码");
  });

  it("有草稿时剥掉模型重复的草稿前缀，保留续写开头的空格", () => {
    expect(toInputPredictionSuffix("run the tests", "run the")).toBe(" tests");
    expect(toInputPredictionSuffix(" tests  ", "run the")).toBe(" tests");
  });

  it("草稿以空白结尾时续写不再以空白开头", () => {
    expect(toInputPredictionSuffix("run the tests", "run the ")).toBe("tests");
    expect(toInputPredictionSuffix("  tests", "run the ")).toBe("tests");
  });

  it("按 UTF-16 长度截断到 40，不劈开代理对", () => {
    const long = "好".repeat(50);
    expect(toInputPredictionSuffix(long, "")).toHaveLength(40);
    const emoji = "😀".repeat(30);
    const bounded = toInputPredictionSuffix(emoji, "");
    expect(bounded.length).toBeLessThanOrEqual(40);
    expect(bounded).toBe("😀".repeat(20));
  });
});

describe("decideInputPrediction", () => {
  it("轮数不够时 suppress_no_context", () => {
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "好", confidence: 1 }],
        draft: "",
        recentUserInputs: ["a"],
        turnCount: 1,
      }),
    ).toEqual({ decision: "suppress_no_context", candidates: [], topConfidence: 0 });
    // 草稿模式只要 1 轮。
    expect(inputPredictionMinTurns("草稿")).toBe(1);
    expect(inputPredictionMinTurns("")).toBe(2);
  });

  it("去掉与最近用户输入重复的、候选间重复的，按置信度降序取前 3", () => {
    const outcome = decideInputPrediction({
      rawCandidates: [
        { text: "再跑一遍 单测", confidence: 0.99 },
        { text: "提交代码", confidence: 0.7 },
        { text: "提交 代码", confidence: 0.85 },
        { text: "推送", confidence: 0.6 },
        { text: "看下覆盖率", confidence: 0.5 },
        { text: "合并", confidence: 0.4 },
        { text: "   ", confidence: 0.95 },
      ],
      draft: "",
      recentUserInputs: turns.map((turn) => turn.userText),
      turnCount: 2,
    });
    expect(outcome).toEqual({
      decision: "show",
      candidates: [
        { text: "提交 代码", confidence: 0.85 },
        { text: "推送", confidence: 0.6 },
        { text: "看下覆盖率", confidence: 0.5 },
      ],
      topConfidence: 0.85,
    });
    expect(
      v4ConversationInputPredictionResultSchema.safeParse({ ...outcome, requestId: "r" }).success,
    ).toBe(true);
  });

  it("top 置信度不到门槛时 suppress_below_threshold；置信度被夹到 0..1", () => {
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "提交", confidence: 0.79 }],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }).decision,
    ).toBe("suppress_below_threshold");
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "提交", confidence: 3 }],
        draft: "",
        recentUserInputs: [],
        turnCount: 3,
      }),
    ).toMatchObject({ decision: "show", topConfidence: 1 });
  });

  it("草稿模式按「草稿 + 续写」与最近输入去重", () => {
    expect(
      decideInputPrediction({
        rawCandidates: [{ text: "单测", confidence: 0.9 }],
        draft: "再跑一遍",
        recentUserInputs: ["再跑一遍单测"],
        turnCount: 1,
      }).candidates,
    ).toEqual([]);
  });
});

describe("上下文与提示词", () => {
  it("只取最近 6 轮，助手回复截断，总预算从最旧处截断", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      userText: `问题${index}`,
      assistantText: index === 7 ? "长".repeat(900) : null,
    }));
    const context = buildInputPredictionContext(many);
    expect(context).not.toContain("问题1");
    expect(context).toContain("问题2");
    expect(context).toContain("（无回复）");
    expect(context).toContain(`${"长".repeat(800)}…`);
    expect(buildInputPredictionContext(many, { totalMaxChars: 20 })).toHaveLength(20);
  });

  it("草稿模式换提示词并附草稿；纯空白草稿视为无草稿", () => {
    expect(normalizeInputPredictionDraft("   ")).toBe("");
    expect(normalizeInputPredictionDraft(undefined)).toBe("");
    const [system, user] = buildInputPredictionMessages(turns, "帮我");
    expect(system!.content).toContain("输入补全器");
    expect(user!.content).toContain("【用户正在输入的草稿】\n帮我");
    expect(buildInputPredictionMessages(turns, "")[0]!.content).toContain("输入预测器");
  });
});

describe("generateInputPredictionCandidates", () => {
  it("用 input_prediction querySource 调模型并解析", async () => {
    const callModel = vi.fn<InputPredictionModelCall>(async () => ({
      text: '{"candidates":[{"text":"提交","confidence":0.9}]}',
    }));
    await expect(generateInputPredictionCandidates({ turns, draft: "", callModel })).resolves.toEqual(
      [{ text: "提交", confidence: 0.9 }],
    );
    expect(callModel.mock.calls[0]![1].querySource).toBe(INPUT_PREDICTION_QUERY_SOURCE);
  });

  it("外部取消时立即放弃等待，即使模型执行面不响应 signal", async () => {
    const controller = new AbortController();
    const pending = generateInputPredictionCandidates({
      turns,
      draft: "",
      callModel: () => new Promise(() => undefined),
      abortSignal: controller.signal,
    });
    controller.abort(new Error("superseded"));
    await expect(pending).rejects.toThrow("superseded");
  });

  it("超时后拒绝，并把合并后的 signal 交给模型执行面", async () => {
    let seen: AbortSignal | undefined;
    const pending = generateInputPredictionCandidates({
      turns,
      draft: "",
      timeoutMs: 10,
      callModel: (_messages, options) => {
        seen = options.abortSignal;
        return new Promise(() => undefined);
      },
    });
    await expect(pending).rejects.toBeDefined();
    expect(seen?.aborted).toBe(true);
  });
});
