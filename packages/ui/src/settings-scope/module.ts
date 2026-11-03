/**
 * settings-scope 模块清单（architecture-governance managed 模块）。
 * 层：contract < domain（分组 / 默认选中 / 选中项解析纯函数）< app（useSettingsScope 状态 owner、useSettingsScopeForm 表单设备 owner）< ui（表单设备上下文、离线提示）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const settingsScopeModule = {
  id: "settings-scope",
  requires: [
    "services",
    "shared",
    "ui",
    "conversation-workspace-target",
    "workspace-config-catalog",
  ],
  provides: ["settings-scope"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
