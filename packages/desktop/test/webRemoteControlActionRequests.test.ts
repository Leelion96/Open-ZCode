import { describe, expect, it, vi } from "vitest";
import { respondToWebRemoteControlActionRequest } from "#src/main/web-remote-relay/index.js";

describe("respondToWebRemoteControlActionRequest", () => {
  const pin = {
    zcode_type: "task-pin-request" as const,
    requestId: "pin-1",
    taskId: "t1",
    workspacePath: "/w",
    pinned: false,
  };

  it("Renderer 失败折成 success:false 应答", async () => {
    const run = vi.fn(async () => {
      throw new Error("Web remote control action timed out.");
    });
    await expect(respondToWebRemoteControlActionRequest(1, pin, run)).resolves.toEqual({
      zcode_type: "task-pin-response",
      requestId: "pin-1",
      taskId: "t1",
      success: false,
      error: "Web remote control action timed out.",
    });
  });

  it("未接 Renderer 时三类请求都回失败而不是抛错", async () => {
    await expect(
      respondToWebRemoteControlActionRequest(
        1,
        { zcode_type: "task-archive-request", requestId: "a", taskId: "t1", workspacePath: "/w" },
        undefined,
      ),
    ).resolves.toMatchObject({ zcode_type: "task-archive-response", success: false });
    await expect(
      respondToWebRemoteControlActionRequest(
        1,
        { zcode_type: "workspace-create-request", requestId: "c", name: "demo" },
        undefined,
      ),
    ).resolves.toMatchObject({ zcode_type: "workspace-create-response", success: false });
  });

  it("取消归档：archived:false 透传给 Renderer 并回显", async () => {
    const run = vi.fn(async () => ({ requestId: "ipc", success: true as const }));
    await expect(
      respondToWebRemoteControlActionRequest(
        1,
        {
          zcode_type: "task-archive-request",
          requestId: "u",
          taskId: "t1",
          workspacePath: "/w",
          archived: false,
        },
        run,
      ),
    ).resolves.toEqual({
      zcode_type: "task-archive-response",
      requestId: "u",
      taskId: "t1",
      success: true,
      archived: false,
    });
    expect(run).toHaveBeenCalledWith(1, {
      kind: "task-archive",
      taskId: "t1",
      workspacePath: "/w",
      archived: false,
    });
  });

  it("新建项目缺路径视为失败", async () => {
    const run = vi.fn(async () => ({ requestId: "ipc", success: true as const }));
    await expect(
      respondToWebRemoteControlActionRequest(
        1,
        { zcode_type: "workspace-create-request", requestId: "c", name: "demo" },
        run,
      ),
    ).resolves.toEqual({
      zcode_type: "workspace-create-response",
      requestId: "c",
      success: false,
      error: "Workspace creation returned no path.",
    });
  });
});
