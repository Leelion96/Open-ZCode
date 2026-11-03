import {
  normalizeWebRemoteControlWorkspaceName,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlTaskArchiveRequestPayload,
  type WebRemoteControlTaskPinRequestPayload,
  type WebRemoteControlWorkspaceCreateRequestPayload,
} from "@zcode/shared";
import type {
  WebRemoteControlRendererActionInput,
  WebRemoteControlRendererActionSuccess,
} from "#src/main/web-remote-relay/webRemoteControlRendererAction.js";

export type WebRemoteControlActionRequestPayload =
  | WebRemoteControlTaskPinRequestPayload
  | WebRemoteControlTaskArchiveRequestPayload
  | WebRemoteControlWorkspaceCreateRequestPayload;

export type RunWebRemoteControlRendererAction = (
  windowId: number,
  action: WebRemoteControlRendererActionInput,
) => Promise<WebRemoteControlRendererActionSuccess>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskTarget(
  request: WebRemoteControlTaskPinRequestPayload | WebRemoteControlTaskArchiveRequestPayload,
) {
  return {
    taskId: request.taskId,
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
  };
}

/**
 * 手机动作请求 → 应答 payload。只做协议翻译，执行交给 Renderer；
 * 任何失败都折成 success:false 应答，保证手机端不会因桌面异常干等超时。
 */
export async function respondToWebRemoteControlActionRequest(
  windowId: number,
  request: WebRemoteControlActionRequestPayload,
  runRendererAction: RunWebRemoteControlRendererAction | undefined,
): Promise<WebRemoteControlAppPayload> {
  switch (request.zcode_type) {
    case "task-pin-request":
      try {
        if (!runRendererAction) throw new Error("Task pin is unavailable on this desktop.");
        await runRendererAction(windowId, {
          kind: "task-pin",
          ...taskTarget(request),
          pinned: request.pinned,
        });
        return {
          zcode_type: "task-pin-response",
          requestId: request.requestId,
          taskId: request.taskId,
          success: true,
          pinned: request.pinned,
        };
      } catch (error) {
        return {
          zcode_type: "task-pin-response",
          requestId: request.requestId,
          taskId: request.taskId,
          success: false,
          error: errorMessage(error),
        };
      }
    case "task-archive-request": {
      const archived = request.archived ?? true;
      try {
        if (!runRendererAction) throw new Error("Task archive is unavailable on this desktop.");
        await runRendererAction(windowId, {
          kind: "task-archive",
          ...taskTarget(request),
          archived,
        });
        return {
          zcode_type: "task-archive-response",
          requestId: request.requestId,
          taskId: request.taskId,
          success: true,
          archived,
        };
      } catch (error) {
        return {
          zcode_type: "task-archive-response",
          requestId: request.requestId,
          taskId: request.taskId,
          success: false,
          error: errorMessage(error),
        };
      }
    }
    case "workspace-create-request":
      try {
        // 非法名称在 Main 直接拒绝，不让手机输入进入 Renderer 或文件系统。
        const name = normalizeWebRemoteControlWorkspaceName(request.name);
        if (!runRendererAction)
          throw new Error("Workspace creation is unavailable on this desktop.");
        const result = await runRendererAction(windowId, { kind: "workspace-create", name });
        if (!result.workspacePath) throw new Error("Workspace creation returned no path.");
        return {
          zcode_type: "workspace-create-response",
          requestId: request.requestId,
          success: true,
          workspacePath: result.workspacePath,
          workspaceKey: resolveWebRemoteControlWorkspaceKey({
            workspacePath: result.workspacePath,
          }),
          ...(result.projectId ? { projectId: result.projectId } : {}),
          ...(result.hostId ? { hostId: result.hostId } : {}),
        };
      } catch (error) {
        return {
          zcode_type: "workspace-create-response",
          requestId: request.requestId,
          success: false,
          error: errorMessage(error),
        };
      }
  }
}
