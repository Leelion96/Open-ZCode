import { useEffect } from "react";
import type {
  IPlatformService,
  WebRemoteControlRendererActionRequest,
  WebRemoteControlRendererActionResult,
} from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { mutateProjectTask } from "@/project-sidebar/task-mutation.js";
import type {
  IProjectService,
  IWindowControllerService,
  IZCodeTaskService,
} from "@/project-sidebar/contract.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

export interface WebRemoteControlRendererActionPorts {
  services: {
    zcodeTaskService: IZCodeTaskService;
    windowControllerService?: IWindowControllerService;
    /** 只用桌面 scratch workspace 的目录创建能力（~/ZCodeProject/<name>）。 */
    fileService: { createScratchWorkspace(params: { name: string }): Promise<{ path: string }> };
    projectService?: IProjectService;
  };
  resolveRemoteSessionId: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => string | null;
  removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
}

async function createLocalProject(
  ports: WebRemoteControlRendererActionPorts,
  name: string,
): Promise<{ workspacePath: string; projectId?: string; hostId?: string }> {
  // 目录与校验复用桌面 scratch workspace：~/ZCodeProject/<name>，同名目录幂等复用。
  const { path: workspacePath } = await ports.services.fileService.createScratchWorkspace({ name });
  const projectService = ports.services.projectService;
  if (!projectService) return { workspacePath };
  // 同一目录已登记为项目时直接复用，避免手机重复点击生成多个同根项目。
  const existing = (await projectService.readProjects()).find(
    (project) =>
      !project.deleted &&
      !project.legacySingleRoot &&
      project.roots.some((root) => root.rootPath === workspacePath),
  );
  const project =
    existing ??
    (await projectService.saveProject({
      name,
      defaultName: name,
      roots: [workspacePath],
      primaryRoot: workspacePath,
    }));
  return { workspacePath, projectId: project.id, hostId: project.hostId };
}

/**
 * 执行手机动作。置顶/归档与侧栏 useProjectTaskActions 同一条 mutateProjectTask 路径，
 * 写入后由 Host 的 state:projects 广播驱动桌面侧栏与手机重读，不在这里额外推送快照。
 */
export async function executeWebRemoteControlRendererAction(
  request: WebRemoteControlRendererActionRequest,
  ports: WebRemoteControlRendererActionPorts,
): Promise<WebRemoteControlRendererActionResult> {
  if (request.kind === "workspace-create") {
    return {
      requestId: request.requestId,
      success: true,
      ...(await createLocalProject(ports, request.name)),
    };
  }
  const target = {
    taskId: request.taskId,
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
  };
  const taskPorts = {
    service: ports.services.zcodeTaskService,
    controller: ports.services.windowControllerService,
  };
  const remoteSessionId = ports.resolveRemoteSessionId(target);
  if (request.kind === "task-pin") {
    await mutateProjectTask(
      taskPorts,
      target,
      { kind: "pin", pinned: request.pinned },
      remoteSessionId,
    );
  } else {
    await mutateProjectTask(
      taskPorts,
      target,
      { kind: "archive", archived: request.archived },
      remoteSessionId,
    );
    // 与侧栏归档一致：归档后清掉本窗口会话状态，否则主区继续显示已归档任务；取消归档不清理。
    if (request.archived) {
      ports.removeTaskState(target.workspacePath, target.taskId, target.workspaceIdentity);
    }
  }
  return { requestId: request.requestId, success: true };
}

/** Root 级注册：只有桌面 platform 提供该 IPC，Web/手机壳层自然跳过。 */
export function useWebRemoteControlRendererActions(platform: IPlatformService): void {
  const services = useBaseWorkspaceServices();
  useEffect(() => {
    if (!platform.onWebRemoteControlRendererAction) return;
    return platform.onWebRemoteControlRendererAction(async (request) => {
      try {
        return await executeWebRemoteControlRendererAction(request, {
          services,
          resolveRemoteSessionId: (target) =>
            resolveRemoteWorkspaceSessionIdForTarget({
              workspacePath: target.workspacePath,
              workspaceIdentity: target.workspaceIdentity,
              state: useRemoteWorkspaceSessionStore.getState(),
            }),
          removeTaskState: (...args) => useZCodeSessionStore.getState().removeTaskState(...args),
        });
      } catch (error) {
        logger.warn("[web-remote-control] 手机动作执行失败", { kind: request.kind, error });
        return {
          requestId: request.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }, [platform, services]);
}
