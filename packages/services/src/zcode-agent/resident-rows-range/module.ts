/**
 * remote-resident-rows-range 模块清单（architecture-governance managed 模块）。
 * 范围：rowsRange 只读热会话（residency="resident-only"）的 Host 侧执行端能力确认。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const remoteResidentRowsRangeModule = {
  id: "remote-resident-rows-range",
  requires: ["shared", "services"],
  provides: ["remote-resident-rows-range"],
  publicEntrypoints: ["contract.ts"],
} as const;
