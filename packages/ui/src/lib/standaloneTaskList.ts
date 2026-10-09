import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  IZCodeTaskService,
  ZCodeTaskListItem,
  ZCodeTaskListQuery,
  ZCodeTaskListSortBy,
} from "@zcode/services";
import { mergeTaskIndexRowsWithSessions } from "@/v4/buildTaskListResultFromSessions.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { buildTaskListItemIdentityKey } from "@/v4/taskListItemStabilization.js";

export async function readStandaloneTaskList(
  service: Pick<IZCodeTaskService, "listTaskList">,
  query: ZCodeTaskListQuery,
) {
  // Controller 的 active 包含置顶任务，而现有任务接口的 active 只读未置顶分区。
  // Web 复用两个已有分区保持相同口径，服务端的查询逻辑保持原样。
  if (query.kind === "active") {
    const results = await Promise.all(
      (["timeline", "pinned"] as const).map((kind) =>
        service.listTaskList({ ...query, kind, limit: undefined }),
      ),
    );
    // 两个分区读取之间发生 pin 时，同一行可能同时返回；按现有 identity 键合并。
    const items = [
      ...new Map(
        results.flatMap((result) =>
          result.items.map((item) => [buildTaskListItemIdentityKey(item), item] as const),
        ),
      ).values(),
    ];
    return { items, total: items.length, hasMore: false };
  }
  return service.listTaskList({ ...query, limit: undefined });
}

export function projectStandaloneTaskListItems(
  items: ZCodeTaskListItem[],
  sessions: ZCodeTaskMeta[],
  sortBy: ZCodeTaskListSortBy,
  limit?: number,
): ZCodeTaskListItem[] {
  // HTTP Server 没有窗口 Controller，复用项目行的持久行 + 实时摘要合并。
  // 必须合并、排序后再截取，避免旧历史中的运行任务被持久时间分页挡在首屏外。
  const merged = mergeTaskIndexRowsWithSessions({ taskIndexItems: items, sessions });
  merged.sort((left, right) => compareZCodeTaskListItems(left, right, sortBy));
  return limit === undefined ? merged : merged.slice(0, limit);
}
