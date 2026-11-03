import { describe, expect, it, vi } from "vitest";
import type { IProjectService, ProjectTree } from "../src/project/contract.js";
import type { WindowHostControllerTaskRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildPendingInteractionSignature,
  createWebRemoteProjectTreeActivityBridge,
  overlayProjectTreeTaskActivity,
} from "../src/window-project-directory/webRemoteProjectTreeActivity.js";

function row(
  taskId: string,
  counts?: { permissionCount: number; userInputCount: number },
  workspaceIdentity?: string,
): WindowHostControllerTaskRow {
  return {
    address: { taskId, workspacePath: "/w", ...(workspaceIdentity ? { workspaceIdentity } : {}) },
    activity: counts
      ? { phase: "idle", lastActivityAt: 1, hasBackgroundWork: false, pendingInteractions: counts }
      : undefined,
  } as unknown as WindowHostControllerTaskRow;
}

function tree(...taskIds: string[]): ProjectTree {
  return {
    tasks: taskIds.map((taskId) => ({ taskId, workspacePath: "/w" })),
  } as unknown as ProjectTree;
}

describe("overlayProjectTreeTaskActivity", () => {
  it("给有待处理交互的任务补计数和标记，权限优先", () => {
    const result = overlayProjectTreeTaskActivity(tree("a", "b", "c"), [
      row("a", { permissionCount: 1, userInputCount: 2 }),
      row("b", { permissionCount: 0, userInputCount: 1 }),
      row("c", { permissionCount: 0, userInputCount: 0 }),
    ]);
    expect(result.tasks[0]).toMatchObject({
      pendingInteractions: { permissionCount: 1, userInputCount: 2 },
      pendingInteraction: { kind: "permission" },
    });
    expect(result.tasks[1]).toMatchObject({ pendingInteraction: { kind: "userInput" } });
    expect(result.tasks[2]).not.toHaveProperty("pendingInteractions");
  });

  it("远程任务按 workspaceIdentity 匹配，不串到同路径本地任务", () => {
    const result = overlayProjectTreeTaskActivity(tree("a"), [
      row("a", { permissionCount: 1, userInputCount: 0 }, "remote:ssh:h:/w"),
    ]);
    expect(result.tasks[0]).not.toHaveProperty("pendingInteractions");
  });
});

describe("buildPendingInteractionSignature", () => {
  it("与行顺序无关，忽略无交互行", () => {
    const a = row("a", { permissionCount: 1, userInputCount: 0 });
    const b = row("b", { permissionCount: 0, userInputCount: 1 });
    expect(buildPendingInteractionSignature([a, b, row("c")])).toBe(
      buildPendingInteractionSignature([b, a]),
    );
  });
});

describe("createWebRemoteProjectTreeActivityBridge", () => {
  it("引用计数订阅；签名变化才广播", () => {
    let rows: WindowHostControllerTaskRow[] = [];
    let onChange: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribeRows = vi.fn((listener: () => void) => {
      onChange = listener;
      listener(); // 与投影订阅一致：订阅即回放一次快照。
      return { dispose: unsubscribe };
    });
    const notifyProjectChange = vi.fn();
    const bridge = createWebRemoteProjectTreeActivityBridge({
      readRows: () => rows,
      subscribeRows,
      notifyProjectChange,
    });

    const first = bridge.retain();
    const second = bridge.retain();
    expect(subscribeRows).toHaveBeenCalledTimes(1);
    expect(notifyProjectChange).not.toHaveBeenCalled();

    rows = [row("a", { permissionCount: 1, userInputCount: 0 })];
    onChange?.();
    onChange?.();
    expect(notifyProjectChange).toHaveBeenCalledTimes(1);

    first.dispose();
    first.dispose();
    expect(unsubscribe).not.toHaveBeenCalled();
    second.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("decorate 只改写 readTree，其余方法透传", async () => {
    const base = {
      readTree: vi.fn(async () => tree("a")),
      readProjects: vi.fn(async () => []),
    } as unknown as IProjectService;
    const bridge = createWebRemoteProjectTreeActivityBridge({
      readRows: () => [row("a", { permissionCount: 0, userInputCount: 3 })],
      subscribeRows: () => ({ dispose() {} }),
      notifyProjectChange: () => {},
    });
    const decorated = bridge.decorate(base);
    expect((await decorated.readTree()).tasks[0]).toMatchObject({
      pendingInteractions: { permissionCount: 0, userInputCount: 3 },
    });
    await decorated.readProjects();
    expect(base.readProjects).toHaveBeenCalledTimes(1);
  });
});
