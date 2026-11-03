import type { AcknowledgedWebRemoteControlRelayProtocolAdapter } from "@zcode/client";
import {
  isWebRemoteControlBridgeableWorkspaceTarget,
  remoteHostIdFromWorkspaceIdentity,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlWindowBootstrapResult,
} from "@zcode/shared";

const WEB_REMOTE_CONTROL_BRIDGE_RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;

/** 失效通知可随心跳重送；只有 raw adapter 的首次状态转换能启动恢复。 */
export function acceptWebRemoteControlBridgeInvalidation(
  protocol: AcknowledgedWebRemoteControlRelayProtocolAdapter | undefined,
  bridgeSessionId: string | undefined,
  reason: string,
): void {
  if (!protocol || protocol.getBridgeSessionId() !== bridgeSessionId || protocol.isDegraded())
    return;
  protocol.markDegraded(reason);
}

export function resolveWebRemoteControlRecoveryTarget(
  snapshot: WebRemoteControlWindowBootstrapResult,
  preferred?: { preferredWorkspaceKey?: string; preferredTaskId?: string },
):
  | (NonNullable<ReturnType<typeof resolveWebRemoteControlInitialWorkspaceSelection>> & {
      taskHostId?: string;
    })
  | null {
  // 冷启动曾误用硬恢复规则，导致过期导航阻止可用 workspace 加载。
  // 只有明确恢复当前页面时才保留原目标；首次加载和整页刷新复用初始选择规则。
  if (!preferred?.preferredWorkspaceKey)
    return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
  const view = {
    activeWorkspaceKey: preferred.preferredWorkspaceKey,
    activeTaskId: preferred.preferredTaskId,
  };
  const workspace = snapshot.workspaces.find(
    (target) => resolveWebRemoteControlWorkspaceKey(target) === view.activeWorkspaceKey,
  );
  if (workspace) {
    return {
      workspaceKey: view.activeWorkspaceKey,
      ...(view.activeTaskId ? { taskId: view.activeTaskId } : {}),
      canBridge: isWebRemoteControlBridgeableWorkspaceTarget(workspace),
    };
  }
  if (view.activeTaskId) {
    // 手机独立打开的项目只由旧 bridge 补入候选；attachment 释放不代表任务消失。
    // 沿既有 Host 任务导航重新验证目录与 session，不缓存旧 remoteSessionId，也不跳 default。
    return {
      workspaceKey: view.activeWorkspaceKey,
      taskId: view.activeTaskId,
      taskHostId: remoteHostIdFromWorkspaceIdentity(view.activeWorkspaceKey) ?? "local",
      canBridge: true,
    };
  }
  return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
}

export function getWebRemoteControlBridgeRecoveryRetryDelay(attempt: number): number | null {
  return WEB_REMOTE_CONTROL_BRIDGE_RECOVERY_RETRY_DELAYS_MS[attempt] ?? null;
}

/** 同一恢复 owner 串行重建 bridge；重连成功必须等旧离线快照收口后再核对目标并恢复。 */
export function createWebRemoteControlBridgeRecoveryRunner(
  recover: (reason: string) => Promise<void>,
) {
  let flight: Promise<void> | undefined;
  return async (reason: string, shouldRecoverAfterCurrent?: () => boolean): Promise<void> => {
    if (flight) {
      await flight;
      if (!shouldRecoverAfterCurrent) return;
    }
    if (shouldRecoverAfterCurrent && !shouldRecoverAfterCurrent()) return;
    if (!flight) {
      // 先登记 flight 再调用 recover，避免 markDegraded 同步回调再次进入恢复。
      const next = Promise.resolve()
        .then(() => recover(reason))
        .finally(() => {
          if (flight === next) flight = undefined;
        });
      flight = next;
    }
    await flight;
  };
}
