/**
 * local-ttft-desktop 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const localTtftDesktopModule = {
  id: "local-ttft-desktop",
  requires: ["shared", "ui"],
  provides: ["local-ttft-desktop"],
  publicEntrypoints: ["contract.ts"],
} as const;
