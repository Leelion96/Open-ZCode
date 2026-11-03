// 手机远控输入预测（ghost hint）的 v4 只读查询线格式。
// 规格：docs/web-remote-control/mobile-input-prediction.md。
//
// 两种模式共用一个方法：
// - 草稿为空：预测用户下一条完整输入（多轮之后才有意义）；
// - 草稿非空：预测草稿之后要接上的续写。
// 候选 text 统一是「接在草稿后面的文本」：草稿为空时它就是整条输入。
// 本包纪律：只放 schema 与纯函数，不做 IO。
import { z } from "zod";

export const INPUT_PREDICTION_MAX_CANDIDATES = 3;
/** 单个候选（续写部分）的最大字符数。 */
export const INPUT_PREDICTION_MAX_TEXT_CHARS = 40;
/** 草稿上限：超出由手机截断再发，服务端整包拒绝。 */
export const INPUT_PREDICTION_MAX_DRAFT_CHARS = 4_000;
export const INPUT_PREDICTION_MAX_REQUEST_ID_CHARS = 128;

export const INPUT_PREDICTION_DECISIONS = [
  // top 候选达到置信度门槛，手机可展示 candidates[0]。
  "show",
  // 有候选但置信度不够，本次不展示。
  "suppress_below_threshold",
  // 上下文不足（轮数不够 / 会话不在内存），不调用模型。
  "suppress_no_context",
  // 开关关闭、无模型、模型超时或失败：静默无 hint。
  "unavailable",
  // 同会话来了更新的请求，本请求被中止。
  "cancelled",
] as const;
export type InputPredictionDecisionKind = (typeof INPUT_PREDICTION_DECISIONS)[number];

const inputPredictionCandidateSchema = z
  .object({
    // 续写文本：不 trim（英文续写可能以空格开头），但不能是纯空白、不能换行。
    text: z
      .string()
      .min(1)
      .max(INPUT_PREDICTION_MAX_TEXT_CHARS)
      .refine((text) => text.trim().length > 0, { message: "blank candidate" })
      .refine((text) => !/[\r\n]/.test(text), { message: "single line" }),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type V4InputPredictionCandidate = z.infer<typeof inputPredictionCandidateSchema>;

export const v4ConversationInputPredictionParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    // 手机当前看到的快照 revision：缓存键的一部分；迟到响应由手机按它丢弃。
    revision: z.number().int().nonnegative(),
    // 输入框当前草稿；缺席或纯空白 = 预测下一条完整输入。
    draft: z.string().max(INPUT_PREDICTION_MAX_DRAFT_CHARS).optional(),
    // 手机生成的请求号，原样回显，供手机丢弃过期响应。
    requestId: z.string().min(1).max(INPUT_PREDICTION_MAX_REQUEST_ID_CHARS).optional(),
  })
  .strict();
export type V4ConversationInputPredictionParams = z.infer<
  typeof v4ConversationInputPredictionParamsSchema
>;

export const v4ConversationInputPredictionResultSchema = z
  .object({
    decision: z.enum(INPUT_PREDICTION_DECISIONS),
    // 按置信度降序；非 show 时可以为空。
    candidates: z.array(inputPredictionCandidateSchema).max(INPUT_PREDICTION_MAX_CANDIDATES),
    topConfidence: z.number().min(0).max(1),
    requestId: z.string().min(1).max(INPUT_PREDICTION_MAX_REQUEST_ID_CHARS).optional(),
  })
  .strict();
export type V4ConversationInputPredictionResult = z.infer<
  typeof v4ConversationInputPredictionResultSchema
>;

/** 无候选的结果（非 show 决策统一用它构造）。 */
export function emptyInputPredictionResult(
  decision: Exclude<InputPredictionDecisionKind, "show">,
  requestId?: string,
): V4ConversationInputPredictionResult {
  return {
    decision,
    candidates: [],
    topConfidence: 0,
    ...(requestId !== undefined ? { requestId } : {}),
  };
}
