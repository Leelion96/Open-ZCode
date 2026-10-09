import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IZCodeTaskService, ZCodeTaskListQuery, ZCodeTaskListResult } from "@zcode/services";
import { logger } from "@/logger.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { stabilizeTaskListItems } from "@/v4/taskListItemStabilization.js";
import {
  bumpTaskListMembershipVersionForWorkspaceEvent,
  useTaskListMembershipVersion,
} from "@/v4/taskListMembershipVersion.js";
import { shouldRefetchTaskListMembershipForWorkspaceEvent } from "@/lib/taskListRefreshPolicy.js";
import {
  projectStandaloneTaskListItems,
  readStandaloneTaskList,
} from "@/lib/standaloneTaskList.js";

const emptyResult: ZCodeTaskListResult = { items: [], total: 0, hasMore: false };
const emptyScopes: ZCodeTaskListQuery["workspaceScopes"] = [];

export function useStandaloneTaskList(
  service: IZCodeTaskService,
  query: ZCodeTaskListQuery | null,
  sourceVersion: string,
) {
  // Controller 存在时传入 null，不启动独立 Web 的查询和订阅。
  const scopes = query?.workspaceScopes ?? emptyScopes;
  const { items: sessionItems } = useWorkspaceSessionsIndexItems(scopes);
  const membershipVersion = useTaskListMembershipVersion();
  const [result, setResult] = useState(emptyResult);
  const [loading, setLoading] = useState(scopes.length > 0);
  const requestSerialRef = useRef(0);

  useEffect(() => {
    // 任务组织态事件驱动重查；实时摘要只重算展示，避免流式输出逐帧读取任务索引。
    const subscriptions = scopes.map((scope) =>
      service.onDynamicWorkspaceEvent(scope)((event) => {
        if (
          event.type === "workspace_task_list_changed" &&
          shouldRefetchTaskListMembershipForWorkspaceEvent(event)
        ) {
          bumpTaskListMembershipVersionForWorkspaceEvent(event);
        }
      }),
    );
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [service, scopes]);

  const refresh = useCallback(async () => {
    const requestSerial = ++requestSerialRef.current;
    if (!query || scopes.length === 0) {
      setResult(emptyResult);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await readStandaloneTaskList(service, query);
      if (requestSerialRef.current !== requestSerial) return;
      setResult((previous) => ({
        ...next,
        items: stabilizeTaskListItems(previous.items, next.items),
      }));
    } catch (error) {
      if (requestSerialRef.current === requestSerial) {
        // 失败保留最后可信列表，沿用上游只记录日志的处理。
        logger.error(`[useStandaloneTaskList] 加载 ${query.kind} 列表失败`, error);
      }
    } finally {
      if (requestSerialRef.current === requestSerial) setLoading(false);
    }
  }, [service, query, scopes]);

  useEffect(() => {
    void refresh();
    // 切换 scope、服务或版本后，迟到的读取不能覆盖新列表；卸载时同样失效。
    return () => {
      requestSerialRef.current += 1;
    };
  }, [refresh, membershipVersion, sourceVersion]);

  const displayedItemsRef = useRef(result.items);
  const items = useMemo(() => {
    const next = query
      ? projectStandaloneTaskListItems(result.items, sessionItems, query.sortBy, query.limit)
      : emptyResult.items;
    const stabilized = stabilizeTaskListItems(displayedItemsRef.current, next);
    displayedItemsRef.current = stabilized;
    return stabilized;
  }, [result.items, sessionItems, query]);

  return {
    items,
    total: result.total,
    hasMore: result.total > items.length,
    loading,
    syncingRemoteWorkspaces: loading && scopes.some((scope) => Boolean(scope.workspaceIdentity)),
    refresh,
  };
}
