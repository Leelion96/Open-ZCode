// 手机远控输入预测（ghost hint）的 Host 侧总开关。
// 规格：docs/web-remote-control/mobile-input-prediction.md「开关」。
//
// 同一个判定同时决定两件事，二者必须一致：
// - v4 hello.capabilities.inputPrediction（手机据此决定是否发起预测）；
// - conversationInputPredictionV4 是否真的转发给 CLI（关闭时直接回 unavailable）。

/** 环境变量名：未设置或为空时取缺省（开启）；"1" 开启；"0" 或其它任何值关闭。 */
export const REMOTE_INPUT_PREDICTION_ENV = "ZCODE_REMOTE_INPUT_PREDICTION";

/**
 * 未设置环境变量时的缺省：开启。
 * 用户决定（2026-10-23）：输入预测所有渠道默认打开；每次请求会调用一次模型，需关闭时设为 "0"。
 */
export const REMOTE_INPUT_PREDICTION_DEFAULT_ENABLED = true;

export function isRemoteInputPredictionEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[REMOTE_INPUT_PREDICTION_ENV]?.trim();
  if (raw === undefined || raw === "") return REMOTE_INPUT_PREDICTION_DEFAULT_ENABLED;
  return raw === "1";
}
