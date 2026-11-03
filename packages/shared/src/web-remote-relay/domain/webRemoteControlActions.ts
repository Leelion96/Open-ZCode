/**
 * 手机远控的任务置顶/归档与新建本地项目契约。
 *
 * 3.16 起任务列表由手机经 RPC `project.readTree` 读取，L2 只承载「动作请求 + 应答」；
 * 动作在桌面 Renderer 内按侧栏同一条 controller 路径执行，变更由既有 `state:projects`
 * 广播驱动手机重读，避免在 L2 再复制一份任务快照。
 */

/** Main 等待 Renderer 执行手机动作的上限；新建项目含目录创建与项目登记，按 30s 兜底。 */
export const WEB_REMOTE_CONTROL_RENDERER_ACTION_TIMEOUT_MS = 30_000;

/** 手机新建本地项目的固定根目录（相对用户主目录），与桌面 scratch workspace 一致。 */
export const WEB_REMOTE_CONTROL_LOCAL_PROJECT_ROOT_DIR = "ZCodeProject";

export interface WebRemoteControlWorkspaceCreateRequestPayload {
  zcode_type: "workspace-create-request";
  requestId: string;
  /** 项目目录名：去首尾空白后非空，且不含 `/` 或 `\`。同名目录直接复用。 */
  name: string;
}

export type WebRemoteControlWorkspaceCreateResponsePayload =
  | {
      zcode_type: "workspace-create-response";
      requestId: string;
      success: true;
      workspacePath: string;
      workspaceKey: string;
      /** 新建或复用的项目；手机可直接用 workspace-bridge-open.project 打开。 */
      projectId?: string;
      hostId?: string;
    }
  | {
      zcode_type: "workspace-create-response";
      requestId: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlTaskPinRequestPayload {
  zcode_type: "task-pin-request";
  requestId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  pinned: boolean;
}

export type WebRemoteControlTaskPinResponsePayload =
  | {
      zcode_type: "task-pin-response";
      requestId: string;
      taskId: string;
      success: true;
      pinned: boolean;
    }
  | {
      zcode_type: "task-pin-response";
      requestId: string;
      taskId: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlTaskArchiveRequestPayload {
  zcode_type: "task-archive-request";
  requestId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** true=归档，false=取消归档；缺省按归档处理（兼容只发归档的旧手机）。 */
  archived?: boolean;
}

export type WebRemoteControlTaskArchiveResponsePayload =
  | {
      zcode_type: "task-archive-response";
      requestId: string;
      taskId: string;
      success: true;
      /** 回显本次生效的归档状态。 */
      archived: boolean;
    }
  | {
      zcode_type: "task-archive-response";
      requestId: string;
      taskId: string;
      success: false;
      error: string;
    };

export type WebRemoteControlActionPayload =
  | WebRemoteControlWorkspaceCreateRequestPayload
  | WebRemoteControlWorkspaceCreateResponsePayload
  | WebRemoteControlTaskPinRequestPayload
  | WebRemoteControlTaskPinResponsePayload
  | WebRemoteControlTaskArchiveRequestPayload
  | WebRemoteControlTaskArchiveResponsePayload;

/** Main → Renderer：手机动作统一走一条 IPC，按 kind 区分，避免每个动作各铺一条通道。 */
export type WebRemoteControlRendererActionRequest =
  | {
      requestId: string;
      kind: "task-pin";
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      pinned: boolean;
    }
  | {
      requestId: string;
      kind: "task-archive";
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      archived: boolean;
    }
  | {
      requestId: string;
      kind: "workspace-create";
      name: string;
    };

export type WebRemoteControlRendererActionResult =
  | {
      requestId: string;
      success: true;
      /** 仅 workspace-create 返回。 */
      workspacePath?: string;
      projectId?: string;
      hostId?: string;
    }
  | {
      requestId: string;
      success: false;
      error: string;
    };

/** 与桌面 scratch workspace 同一规则；手机请求在 Main 先校验，非法名称不进入 Renderer。 */
export function normalizeWebRemoteControlWorkspaceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Workspace name is required.");
  if (/[\\/]/.test(trimmed)) throw new Error("Workspace name cannot contain path separators.");
  if (trimmed === "." || trimmed === "..") throw new Error("Workspace name is invalid.");
  return trimmed;
}

/**
 * 不认识的请求型 payload 需要回 app-error，旧/新版本才能互相降级。
 * 只认「字符串 zcode_type + 非空 requestId + 以 -request 结尾」，response/推送/垃圾数据仍静默丢弃，
 * 避免两端对未知应答互相回错形成循环。
 */
export function resolveUnrecognizedWebRemoteControlRequest(
  value: unknown,
): { requestId: string; zcodeType: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const zcodeType = record.zcode_type;
  const requestId = record.requestId;
  if (typeof zcodeType !== "string" || !zcodeType.endsWith("-request")) return null;
  if (typeof requestId !== "string" || !requestId.trim()) return null;
  return { requestId, zcodeType };
}
