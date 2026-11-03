import { useMemo } from "react";
import {
  remoteHostIdFromWorkspaceIdentity,
  type ProjectSidebarProps,
  type RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";

const NO_READ_ERRORS: ReadonlyMap<string, string> = new Map();

/**
 * 只合并 Host 投影与旧 workspace 的连接错误；连接进度由详情直接读连接管理服务的操作日志。
 * 修复原因：原先这里订阅 requestId 文本日志，但该通道 Host 未注入、Main 未登记，侧栏始终拿到空日志。
 * readErrors 是侧栏最近一次按 Host 读取项目树的失败，只在设备在线时作为项目错误。
 */
export function useProjectConnectionDiagnostics(
  directory: RemoteProjectDirectory,
  props: ProjectSidebarProps,
  readErrors: ReadonlyMap<string, string> = NO_READ_ERRORS,
) {
  return useMemo(
    () =>
      new Map(
        directory.hosts.map((host) => {
          const keys = new Set<string>(
            Object.keys(props.remoteWorkspaceErrorByWorkspaceKey ?? {})
              .concat(props.reconnectingRemoteWorkspaceKeys ?? [])
              .filter((key) => remoteHostIdFromWorkspaceIdentity(key) === host.id),
          );
          for (const entry of directory.entries)
            if (entry.hostId === host.id && entry.legacyWorkspace?.workspaceIdentity)
              keys.add(entry.legacyWorkspace.workspaceIdentity);
          return [
            host.id,
            {
              // Bug 原因：在线设备的项目读取失败（如远端 SQLite 打不开）曾被丢弃，
              // 项目行只能推导成“连接中”且无错误。在线时改用本次读取错误，展示为“连接失败”。
              error:
                host.connectionStatus === "online"
                  ? readErrors.get(host.id)
                  : host.lastConnectionError ||
                    [...keys]
                      .map((key) => props.remoteWorkspaceErrorByWorkspaceKey?.[key])
                      .find(Boolean),
            },
          ];
        }),
      ),
    [
      directory,
      props.remoteWorkspaceErrorByWorkspaceKey,
      props.reconnectingRemoteWorkspaceKeys,
      readErrors,
    ],
  );
}
