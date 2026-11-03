// 手机远控输入预测 Host 开关（docs/web-remote-control/mobile-input-prediction.md「开关」）。
import { describe, expect, it } from "vitest";
import {
  REMOTE_INPUT_PREDICTION_DEFAULT_ENABLED,
  REMOTE_INPUT_PREDICTION_ENV,
  isRemoteInputPredictionEnabled,
} from "../src/zcode-agent/inputPredictionSwitch.js";

describe("isRemoteInputPredictionEnabled", () => {
  it('缺省开启，"1" 开启，"0" 或其它值关闭', () => {
    expect(REMOTE_INPUT_PREDICTION_ENV).toBe("ZCODE_REMOTE_INPUT_PREDICTION");
    expect(REMOTE_INPUT_PREDICTION_DEFAULT_ENABLED).toBe(true);
    expect(isRemoteInputPredictionEnabled({})).toBe(true);
    expect(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "" })).toBe(true);
    expect(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "  " })).toBe(true);
    expect(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "0" })).toBe(false);
    expect(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: " 0 " })).toBe(false);
    expect(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "true" })).toBe(false);
    expect(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: "1" })).toBe(true);
    expect(isRemoteInputPredictionEnabled({ [REMOTE_INPUT_PREDICTION_ENV]: " 1 " })).toBe(true);
  });
});
