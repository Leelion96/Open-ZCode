/**
 * local-ttft-contract 模块清单（architecture-governance managed 模块）。
 * 层：contract。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const localTtftContractModule = {
  id: "local-ttft-contract",
  requires: [],
  provides: ["local-ttft-contract"],
  publicEntrypoints: ["contract.ts"],
} as const;
