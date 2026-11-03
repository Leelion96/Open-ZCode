/**
 * remote-input-prediction 模块清单（architecture-governance managed 模块）。
 * 范围：手机远控输入预测的 v4 线格式（本目录）、Host 侧开关与 CLI 侧只读查询实现。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const remoteInputPredictionModule = {
  id: "remote-input-prediction",
  requires: ["shared", "zcode-cli"],
  provides: ["remote-input-prediction"],
  publicEntrypoints: [
    "contract.ts",
    "../../../../services/src/zcode-agent/inputPredictionSwitch.ts",
    "../../../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/input-prediction-handler.ts",
    "../../../../../apps/zcode-cli/packages/core/src/runtime/methods/input-prediction-sidecar.ts",
  ],
} as const;
