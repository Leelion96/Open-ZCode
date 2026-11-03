import { useCallback, useState } from "react";
import type { SettingsScopeState } from "@/settings-scope/contract.js";
import { parseRemoteUserScopeKey } from "@/settings-scope/domain/scope.js";

/** 设置页表单状态：只把属于当前设备的表单交给渲染。 */
export interface SettingsScopeForm<T> {
  /** 当前设备打开的表单值；没有表单时为 null。 */
  form: T | null;
  /** 以当前设备为 owner 打开表单。 */
  openForm(value: T): void;
  closeForm(): void;
}

/**
 * 表单归属打开它的设备（docs/remote/data-sync.md「Scope 菜单按设备分组」实现约定），子智能体、钩子页共用。
 *
 * Bug 根因：子智能体页的 showForm / editingAgent、钩子页的 viewMode / editingHook 原是两份不带设备归属的状态。
 * 设备离线或连接中时表单只是隐藏（rpcReady=false），状态仍在；用户在列表页把 Scope 切到另一台设备后旧表单重现，
 * 保存把旧设备的路径和内容交给新设备的服务。钩子更危险：各设备的用户钩子 ID 都从 hook-zcode-user-0 编号，
 * 按旧 hook ID 保存会覆盖新设备上的另一个钩子。
 * 修法：合成一份带设备 owner 的表单状态；渲染时 owner 不是当前设备就不渲染并清掉（render-time 更新，不用 effect，
 * 首个提交帧就不会出现旧表单）。owner 取设备级：同一设备内切换「用户」/ 项目不清表单，同一设备离线恢复后仍写回原设备。
 */
export function useSettingsScopeForm<T>(
  scope: Pick<SettingsScopeState, "resolution" | "device">,
): SettingsScopeForm<T> {
  const [form, setForm] = useState<{ deviceKey: string; value: T } | null>(null);
  // 选中的项目关闭时 useSettingsScope 先给出一帧 missing（device 暂记为本机），随后回退到 fallbackKey；
  // 这一帧按回退目标所在设备判断，避免误清同设备的表单。
  const deviceKey =
    scope.resolution.status === "missing"
      ? (parseRemoteUserScopeKey(scope.resolution.fallbackKey) ?? "local")
      : scope.device.kind === "local"
        ? "local"
        : scope.device.id;
  if (form && form.deviceKey !== deviceKey) setForm(null);
  const openForm = useCallback((value: T) => setForm({ deviceKey, value }), [deviceKey]);
  const closeForm = useCallback(() => setForm(null), []);
  return { form: form?.deviceKey === deviceKey ? form.value : null, openForm, closeForm };
}
