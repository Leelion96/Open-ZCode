import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  projectStandaloneTaskListItems,
  readStandaloneTaskList,
} from "../src/lib/standaloneTaskList.js";
import {
  attachTaskListRowActivity,
  getTaskListRowActivity,
} from "../src/v4/taskListRowActivity.js";

function task(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    traceId: taskId,
    title: taskId,
    workspacePath: "/workspace",
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    provider: "glm",
    ...overrides,
  };
}

test("active 包含置顶和普通任务，并保留正文搜索条件", async () => {
  const result = await readStandaloneTaskList(
    {
      async listTaskList(query) {
        assert.equal(query.search, "正文");
        assert.equal(query.limit, undefined);
        assert.deepEqual(query.workspaceScopes, [{ workspacePath: "/workspace" }]);
        assert.ok(query.kind === "timeline" || query.kind === "pinned");
        return { items: [task(query.kind)], total: 1, hasMore: false };
      },
    },
    {
      kind: "active",
      workspaceScopes: [{ workspacePath: "/workspace" }],
      sortBy: "updated",
      search: "正文",
      limit: 1,
    },
  );
  assert.deepEqual(
    result.items.map((item) => item.taskId),
    ["timeline", "pinned"],
  );
  assert.equal(result.total, 2);
});

test("单分区查询保持列表种类，读取失败向调用者返回错误", async () => {
  for (const kind of ["timeline", "pinned", "archived"] as const) {
    let calls = 0;
    await assert.rejects(
      readStandaloneTaskList(
        {
          async listTaskList(query) {
            calls += 1;
            assert.equal(query.kind, kind);
            throw new Error("read failed");
          },
        },
        { kind, workspaceScopes: [{ workspacePath: "/workspace" }], sortBy: "updated" },
      ),
      /read failed/,
    );
    assert.equal(calls, 1);
  }
});

test("置顶切换中两个分区返回同一记录时按 workspace identity 合并", async () => {
  const result = await readStandaloneTaskList(
    {
      async listTaskList() {
        return {
          items: [
            task("same-id", { workspaceIdentity: "first" }),
            task("same-id", { workspaceIdentity: "second" }),
          ],
          total: 2,
          hasMore: false,
        };
      },
    },
    { kind: "active", workspaceScopes: [{ workspacePath: "/workspace" }], sortBy: "updated" },
  );
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map((item) => item.workspaceIdentity),
    ["first", "second"],
  );
});

test("运行状态合并后再排序和分页，旧历史中的运行任务也能进入首屏", () => {
  const newer = task("newer", { createdAt: 2, updatedAt: 20 });
  const older = task("older");
  const live = attachTaskListRowActivity(older, {
    phase: "running",
    lastActivityAt: 3,
    hasBackgroundWork: false,
  });
  const result = projectStandaloneTaskListItems([newer, older], [live], "updated", 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].taskId, "older");
  assert.equal(result[0].updatedAt, 3);
  assert.equal(getTaskListRowActivity(result[0])?.phase, "running");
});
