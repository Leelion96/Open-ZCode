/**
 * provider-provisioning-status 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const providerProvisioningStatusModule = {
  id: "provider-provisioning-status",
  requires: ["services", "shared"],
  provides: ["provider-provisioning-status-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
