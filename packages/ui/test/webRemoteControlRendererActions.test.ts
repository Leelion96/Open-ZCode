import { describe, expect, it, vi } from "vitest";
import {
  executeWebRemoteControlRendererAction,
  type WebRemoteControlRendererActionPorts,
} from "@/project-sidebar/useWebRemoteControlRendererActions.js";

function createPorts(projects: unknown[] = []) {
  const mutateTask = vi.fn(async () => null);
  const createScratchWorkspace = vi.fn(async ({ name }: { name: string }) => ({
    path: `/Users/u/ZCodeProject/${name}`,
  }));
  const saveProject = vi.fn(async () => ({ id: "project-new", hostId: "local" }));
  const removeTaskState = vi.fn();
  const ports = {
    services: {
      zcodeTaskService: {},
      windowControllerService: { mutateTask },
      fileService: { createScratchWorkspace },
      projectService: { readProjects: vi.fn(async () => projects), saveProject },
    },
    resolveRemoteSessionId: () => "remote-session-1",
    removeTaskState,
  } as unknown as WebRemoteControlRendererActionPorts;
  return { ports, mutateTask, createScratchWorkspace, saveProject, removeTaskState };
}

describe("executeWebRemoteControlRendererAction", () => {
  it("置顶走 controller.mutateTask，带远程会话 id", async () => {
    const { ports, mutateTask, removeTaskState } = createPorts();
    await expect(
      executeWebRemoteControlRendererAction(
        {
          requestId: "r1",
          kind: "task-pin",
          taskId: "t1",
          workspacePath: "/w",
          workspaceIdentity: "remote:ssh:h:/w",
          pinned: true,
        },
        ports,
      ),
    ).resolves.toEqual({ requestId: "r1", success: true });
    expect(mutateTask).toHaveBeenCalledWith({
      address: expect.objectContaining({
        taskId: "t1",
        workspacePath: "/w",
        workspaceIdentity: "remote:ssh:h:/w",
        remoteSessionId: "remote-session-1",
      }),
      mutation: { kind: "pin", pinned: true },
    });
    expect(removeTaskState).not.toHaveBeenCalled();
  });

  it("归档后清理本窗口会话状态", async () => {
    const { ports, mutateTask, removeTaskState } = createPorts();
    await executeWebRemoteControlRendererAction(
      { requestId: "r2", kind: "task-archive", taskId: "t1", workspacePath: "/w", archived: true },
      ports,
    );
    expect(mutateTask).toHaveBeenCalledWith(
      expect.objectContaining({ mutation: { kind: "archive", archived: true } }),
    );
    expect(removeTaskState).toHaveBeenCalledWith("/w", "t1", undefined);
  });

  it("归档失败时不清理会话状态", async () => {
    const { ports, mutateTask, removeTaskState } = createPorts();
    mutateTask.mockRejectedValueOnce(new Error("boom"));
    await expect(
      executeWebRemoteControlRendererAction(
        {
          requestId: "r3",
          kind: "task-archive",
          taskId: "t1",
          workspacePath: "/w",
          archived: true,
        },
        ports,
      ),
    ).rejects.toThrow("boom");
    expect(removeTaskState).not.toHaveBeenCalled();
  });

  it("取消归档不清理会话状态", async () => {
    const { ports, mutateTask, removeTaskState } = createPorts();
    await executeWebRemoteControlRendererAction(
      { requestId: "r6", kind: "task-archive", taskId: "t1", workspacePath: "/w", archived: false },
      ports,
    );
    expect(mutateTask).toHaveBeenCalledWith(
      expect.objectContaining({ mutation: { kind: "archive", archived: false } }),
    );
    expect(removeTaskState).not.toHaveBeenCalled();
  });

  it("新建项目：目录在 ~/ZCodeProject 下，并登记为项目", async () => {
    const { ports, createScratchWorkspace, saveProject } = createPorts();
    await expect(
      executeWebRemoteControlRendererAction(
        { requestId: "r4", kind: "workspace-create", name: "demo" },
        ports,
      ),
    ).resolves.toEqual({
      requestId: "r4",
      success: true,
      workspacePath: "/Users/u/ZCodeProject/demo",
      projectId: "project-new",
      hostId: "local",
    });
    expect(createScratchWorkspace).toHaveBeenCalledWith({ name: "demo" });
    expect(saveProject).toHaveBeenCalledWith({
      name: "demo",
      defaultName: "demo",
      roots: ["/Users/u/ZCodeProject/demo"],
      primaryRoot: "/Users/u/ZCodeProject/demo",
    });
  });

  it("同名项目已登记时复用，不重复创建", async () => {
    const { ports, saveProject } = createPorts([
      {
        id: "deleted",
        hostId: "local",
        deleted: true,
        roots: [{ rootPath: "/Users/u/ZCodeProject/demo" }],
      },
      { id: "existing", hostId: "local", roots: [{ rootPath: "/Users/u/ZCodeProject/demo" }] },
    ]);
    const result = await executeWebRemoteControlRendererAction(
      { requestId: "r5", kind: "workspace-create", name: "demo" },
      ports,
    );
    expect(result).toMatchObject({ success: true, projectId: "existing" });
    expect(saveProject).not.toHaveBeenCalled();
  });
});
