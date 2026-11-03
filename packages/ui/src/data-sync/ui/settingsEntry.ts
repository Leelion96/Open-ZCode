import { useCallback, type ReactNode } from "react";
import type { RemoteTarget } from "@zcode/shared";
import { isDataSyncEntryRemoteTarget } from "@/data-sync/domain/entry.js";
import {
  useDataSyncDeviceOnline,
  useDataSyncEntry,
  type DataSyncEntryCategory,
} from "@/data-sync/ui/DataSyncEntry.js";

/**
 * 技能、MCP、插件设置页的「远端上下文」：当前目标是已连接的 SSH / WSL / Docker 远程 workspace 时，
 * 显示「当前远端工作区」提示。同步按钮的显示条件见 `useSettingsDataSyncEntry`。
 */
export function shouldShowRemoteSyncActions(params: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  isWebRemoteControl?: boolean;
}): boolean {
  if (params.isWebRemoteControl) return false;
  return Boolean(
    params.remoteSessionId?.trim() && isDataSyncEntryRemoteTarget(params.remoteTarget),
  );
}

/** 「当前远端工作区：{target}」中的目标描述。 */
export function formatRemoteSyncTargetLabel(
  remoteTarget: RemoteTarget,
  workspacePath: string,
): string {
  const target =
    remoteTarget.kind === "ssh"
      ? `${remoteTarget.username}@${remoteTarget.host}${remoteTarget.port ? `:${remoteTarget.port}` : ""}`
      : remoteTarget.kind === "wsl"
        ? ["WSL", remoteTarget.distro, remoteTarget.user?.trim()].filter(Boolean).join(" · ")
        : remoteTarget.kind === "docker"
          ? `Docker · ${remoteTarget.container}`
          : remoteTarget.kind;
  return workspacePath ? `${target} · ${workspacePath}` : target;
}

/**
 * 技能、MCP、插件设置页的同步按钮：打开数据同步弹窗并定位到该页分类。
 * 显示条件：Scope 菜单选中的是某台在线远端设备的「用户」（调用方此时传入它的 sourceServerId）。
 * 设置页入口不传 workspace 映射（MCP 只做 home 改写）。
 * `onPushFinished` 用于刷新本页列表（分类的 afterPush 只刷新该设备上已打开项目的运行态）。
 */
export function useSettingsDataSyncEntry(params: {
  category: DataSyncEntryCategory;
  sourceServerId: string | null | undefined;
  onPushFinished?(): void | Promise<void>;
}): { visible: boolean; disabled: boolean; open(): void; dialog: ReactNode } {
  const entry = useDataSyncEntry({ onPushFinished: params.onPushFinished });
  const sourceServerId = entry.available ? (params.sourceServerId ?? null) : null;
  const online = useDataSyncDeviceOnline(sourceServerId);
  const { category } = params;
  const { open: openEntry } = entry;
  const open = useCallback(() => {
    if (sourceServerId) openEntry({ sourceServerId, category });
  }, [category, openEntry, sourceServerId]);
  return { visible: Boolean(sourceServerId), disabled: !online, open, dialog: entry.dialog };
}
