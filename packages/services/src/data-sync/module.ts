/**
 * data-sync-service 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const dataSyncServiceModule = {
  id: "data-sync-service",
  requires: ["services", "shared"],
  provides: ["data-sync-category-service", "device-sync-state-service", "user-config-sync-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
