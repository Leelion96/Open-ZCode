import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";

/** 旧同步入口（连接向导、Header、侧栏项目菜单、设置页）只在这三种 Source 远端上显示。 */
const DATA_SYNC_ENTRY_TARGET_KINDS: ReadonlySet<string> = new Set(["ssh", "wsl", "docker"]);

export function isDataSyncEntryRemoteTarget(target: { kind: string } | null | undefined): boolean {
  return Boolean(target && DATA_SYNC_ENTRY_TARGET_KINDS.has(target.kind));
}

/**
 * 旧入口从 tab 的 workspace identity 解析数据同步弹窗的设备。
 * 旧格式（非 server identity）的远程 tab 解析不出 sourceServerId，返回 null，入口不显示。
 */
export function resolveDataSyncEntrySourceServerId(tab: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteTarget?: { kind: string } | null;
}): string | null {
  if (!isDataSyncEntryRemoteTarget(tab.remoteTarget)) return null;
  return getWorkspaceSourceServerId({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity?.trim() || undefined,
  });
}
