/**
 * remote-input-prediction 标准调用示例：手机发请求前校验参数，桌面回包后校验结果。
 */
import {
  emptyInputPredictionResult,
  v4ConversationInputPredictionParamsSchema,
  v4ConversationInputPredictionResultSchema,
  type V4ConversationInputPredictionResult,
} from "./contract.js";

export function exampleRemoteInputPrediction(raw: unknown): V4ConversationInputPredictionResult {
  const params = v4ConversationInputPredictionParamsSchema.safeParse(raw);
  // 参数不合法时不打模型，直接回 unavailable（requestId 尽量回显，便于手机丢弃过期响应）。
  if (!params.success) return emptyInputPredictionResult("unavailable");
  return v4ConversationInputPredictionResultSchema.parse(
    emptyInputPredictionResult("suppress_no_context", params.data.requestId),
  );
}
