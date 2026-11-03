import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ProjectTree,
  ProjectTaskRef,
  ProjectAvailability,
  RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";
import { readProjectSidebarTree } from "@/project-sidebar/project-tree-reader.js";
import { stabilizeProjectTree, applyProjectTaskActivities } from "@/project-sidebar/view.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import { buildRemoteHostWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { logger } from "@/logger.js";
import { useProjectUnreadSignals } from "@/project-sidebar/useProjectUnreadSignals.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";

const subscribeToNothing = () => () => {};
const sameReadErrors = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) =>
  left.size === right.size && [...left].every(([hostId, message]) => right.get(hostId) === message);
const sameAvailability = (
  left: ReadonlyMap<string, ProjectAvailability>,
  right: ReadonlyMap<string, ProjectAvailability>,
) =>
  left.size === right.size &&
  [...right].every(([key, value]) => areStabilizedValuesEquivalent(left.get(key), value));
const zeroRevision = () => 0;
const EMPTY: ProjectTree = { projects: [], tasks: [] };
export function useProjectTree(isDesktop = false) {
  const services = useBaseWorkspaceServices();
  // 远端 bridge 的 base 服务属于 Source；侧栏读写与失效流必须整组来自窗口目录。
  const directoryServices = services.windowProjectDirectory ?? services;
  const service = directoryServices.projectService;
  const remoteService = directoryServices.remoteProjectService;
  const projectChanges = services.windowProjectDirectory?.changesService;
  const controller = services.windowControllerService;
  const registry = useMemo(
    () => (controller ? getWindowControllerTaskListRegistry(controller) : null),
    [controller],
  );
  const revision = useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getRevision ?? zeroRevision,
    registry?.getRevision ?? zeroRevision,
  );
  const directoryRevision = registry?.getDirectoryRevision() ?? 0;
  const sourceRevision = registry?.getSourceRevision() ?? 0;
  const tabs = useTabStore((state) => state.tabs);
  const version = useZCodeSessionStore((state) =>
    Object.values(state.workspaces).reduce((n, workspace) => n + workspace.taskListVersion, 0),
  );
  const [tree, setTree] = useState<ProjectTree>(EMPTY);
  const [availability, setAvailability] = useState<ReadonlyMap<string, ProjectAvailability>>(
    new Map(),
  );
  const [directory, setDirectory] = useState<RemoteProjectDirectory>({ hosts: [], entries: [] });
  // 按 Host 的最近一次项目读取失败；只作展示投影，不落盘，下一次成功读取即清除。
  const [hostReadErrors, setHostReadErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const serial = useRef(0);
  const reads = useMemo(
    () => ({ flight: null as Promise<void> | null, dirty: false }),
    [service, remoteService],
  );
  const pendingCommits = useRef(
    new Set<{
      target: ProjectTaskRef;
      commit(): void;
      organize?(): Promise<void>;
      finish(error?: unknown): void;
    }>(),
  );
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const accepted = useRef<{
    service: typeof service;
    remote: typeof remoteService;
    tree: ProjectTree;
    errors: ReadonlyMap<string, string>;
  } | null>(null);
  const readOnce = useCallback(async () => {
    const request = serial.current;
    try {
      if (!service) throw new Error("project.service-unavailable");
      const result = await readProjectSidebarTree({
        projectService: service,
        remoteProjectService: remoteService,
      });
      if (request === serial.current) {
        const previous = accepted.current;
        if (previous?.service === service) {
          for (const project of result.tree.projects) {
            const before = previous.tree.projects.find(
              (item) => item.id === project.id && item.hostId === project.hostId,
            );
            if (before && before.primaryRootStatus !== project.primaryRootStatus) {
              logger.debug("[project-sidebar] 项目主目录状态变化", {
                projectId: project.id,
                hostId: project.hostId,
                previous: before.primaryRootStatus,
                current: project.primaryRootStatus,
              });
            }
          }
        }
        // 读取由事件触发，失败可能持续；只在错误变化时记录，避免同一故障反复刷日志。
        for (const [hostId, message] of result.errors)
          if (previous?.errors.get(hostId) !== message)
            logger.warn("[project-sidebar] 读取远端项目失败", { hostId, error: message });
        accepted.current = {
          service,
          remote: remoteService,
          tree: result.tree,
          errors: result.errors,
        };
        // Bugfix: 自动归档只改 Host archived，未执行手动归档的 UI 清理，导致列表消失而详情残留。
        // 只处理已接受快照中的明确状态转换；首次已归档、离线缺行与迟到响应都不是归档事件。
        if (previous?.service === service && previous.remote === remoteService) {
          const key = (task: ProjectTree["tasks"][number]) =>
            JSON.stringify([
              task.hostId,
              task.workspaceIdentity?.trim() || task.workspacePath,
              task.taskId,
            ]);
          const before = new Map(previous.tree.tasks.map((task) => [key(task), task]));
          for (const task of result.tree.tasks) {
            if (task.archived && before.get(key(task))?.archived === false) {
              logger.info("[project-sidebar] 归档后清理任务展示", {
                taskId: task.taskId,
                workspacePath: task.workspacePath,
                workspaceIdentity: task.workspaceIdentity,
              });
              removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
            }
          }
        }
        const ready = [...pendingCommits.current].filter(({ target }) =>
          result.tree.tasks.some(
            (task) =>
              task.taskId === target.taskId &&
              (task.workspaceIdentity?.trim() || task.workspacePath) ===
                (target.workspaceIdentity?.trim() || target.workspacePath),
          ),
        );
        // 根因：把组织 RPC 放进共享读取屏障后，一个无回包请求会卡住整棵目录和所有首发。
        // 真实行确认后独立提交组织动作；目录发布、详情提升和导航取消都不等待它。
        for (const pending of ready) {
          if (pending.organize)
            void Promise.resolve()
              .then(pending.organize)
              .catch((cause) => logger.error("[project-sidebar] 首发组织提交失败", cause));
        }
        const commit = () => {
          setTree((previous) => stabilizeProjectTree(previous, result.tree));
          // 树已复用等价引用，但连接/入口每次 RPC 都是新对象，仍会广播整棵目录。
          // 在接收边界比较完整内容；连接变化与入口移除仍发布，不在组件 memo 中忽略字段。
          setAvailability((previous) =>
            sameAvailability(previous, result.availability) ? previous : result.availability,
          );
          setDirectory((previous) =>
            areStabilizedValuesEquivalent(previous, result.directory) ? previous : result.directory,
          );
          setHostReadErrors((previous) =>
            sameReadErrors(previous, result.errors) ? previous : result.errors,
          );
          setError(null);
          for (const pending of ready) {
            try {
              pending.commit();
              logger.info("[project-sidebar] 首发目录与详情提交", pending.target);
              pending.finish();
            } catch (cause) {
              pending.finish(cause);
              throw cause;
            }
          }
        };
        // Bug 根因：目录是 React state，详情绑定是外部 store；首发只靠事件先后不能
        // 保证同一可见帧。真实行到达后在这里一起提交，沿用原首发回调。
        if (ready.length) flushSync(commit);
        else commit();
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        for (const pending of pendingCommits.current) pending.finish(cause);
        logger.error("[project-sidebar] 读取项目树失败", cause);
      }
      // Bug 原因：读取先等远端入口目录；它在冷启动时持续失败（如 Source Directory 初始化失败），
      // 侧栏没有任何快照，本地项目也一起为空。没有成功快照时只补读本地树；已有快照时
      // 保持上一次完整树，避免远程项目一轮消失后取消进行中的远程导航、编辑和首发提交。
      if (service && request === serial.current && accepted.current?.service !== service) {
        const local = await readProjectSidebarTree({ projectService: service }).catch(() => null);
        if (local && request === serial.current) {
          // Bug 原因：只读本地树每次返回新的 availability/directory 对象；目录持续失败时每次刷新
          // 都会重新广播整个侧栏。与成功路径用同一等价判断，内容不变就保留原引用。
          setTree((previous) => stabilizeProjectTree(previous, local.tree));
          setAvailability((previous) =>
            sameAvailability(previous, local.availability) ? previous : local.availability,
          );
          setDirectory((previous) =>
            areStabilizedValuesEquivalent(previous, local.directory) ? previous : local.directory,
          );
        }
      }
    } finally {
      if (request === serial.current) setLoading(false);
    }
  }, [service, remoteService, removeTaskState]);
  const refresh = useCallback(() => {
    reads.dirty = true;
    if (reads.flight) return reads.flight;
    const generation = serial.current;
    const flight = (async () => {
      // 事实变化只标记下一次读取，不能反复废弃当前结果，否则连续变化会饿死列表。
      while (reads.dirty && generation === serial.current) {
        reads.dirty = false;
        await readOnce();
      }
    })().finally(() => {
      if (reads.flight === flight) reads.flight = null;
    });
    reads.flight = flight;
    return flight;
  }, [readOnce, reads]);
  const commitCreatedTask = useCallback(
    (
      target: ProjectTaskRef,
      commit: () => void,
      signal?: AbortSignal,
      organize?: () => Promise<void>,
    ) => {
      if (signal?.aborted && !organize) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const complete = (error?: unknown) => {
          signal?.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => {
          // 导航取消立即结束 UI 等待；尚未确认的组织意图保留到真实行到达，不丢掉已 accepted 的 placement。
          if (!organize) pendingCommits.current.delete(pending);
          complete();
        };
        const pending = {
          target,
          organize,
          commit: () => {
            if (!signal?.aborted) commit();
          },
          finish(error?: unknown) {
            pendingCommits.current.delete(pending);
            complete(error);
          },
        };
        pendingCommits.current.add(pending);
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        void refresh();
      });
    },
    [refresh],
  );
  useEffect(
    () => () => {
      serial.current++;
      reads.flight = null;
      for (const pending of pendingCommits.current) pending.finish();
    },
    [reads],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, version, tabs, directoryRevision]);
  const scopes = useMemo(() => {
    const byKey = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
    for (const task of tree.tasks) byKey.set(task.workspaceIdentity || task.workspacePath, task);
    for (const project of tree.projects)
      for (const root of project.roots) {
        const identity =
          registry && project.hostId !== "local"
            ? buildRemoteHostWorkspaceIdentity(project.hostId, root.rootPath)
            : undefined;
        byKey.set(identity || root.rootPath, {
          workspacePath: root.rootPath,
          ...(identity ? { workspaceIdentity: identity } : {}),
        });
      }
    for (const tab of tabs)
      if (isWorkspaceTab(tab) && !tab.workspaceIdentity && !tab.remoteSessionId)
        byKey.set(tab.workspacePath, { workspacePath: tab.workspacePath });
    return [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { workspacePath, workspaceIdentity }]) => ({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      }));
  }, [tree, tabs, registry]);
  const scopeKey = JSON.stringify(scopes);
  useProjectUnreadSignals(scopes, refresh, isDesktop);
  const sourceVersion = JSON.stringify(
    directory.hosts.map((host) => [host.id, host.membershipId, host.connectionStatus]).sort(),
  );
  const observeSources = useCallback(async () => {
    if (!registry || !scopes.length) return;
    // 原来活动 revision 反复注册观察并重读目录；观察只随 scope/Source 换代。
    // 返回行不进入项目树，显式刷新仍能重试失败的注册。
    await registry
      .list(
        "project-sidebar-activity",
        {
          controllerRevision: sourceRevision,
          taskListVersionSignature: scopeKey,
          workspaceSourceGenerationSignature: `${sourceRevision}:${sourceVersion}`,
        },
        {
          kind: "timeline",
          workspaceScopes: JSON.parse(scopeKey),
          sortBy: "updated",
          limit: 0,
        },
      )
      .catch((cause) => logger.warn("[project-sidebar] Controller 活动订阅失败", cause));
  }, [registry, scopeKey, sourceRevision, sourceVersion]);
  useEffect(() => {
    void observeSources();
  }, [observeSources]);
  const refreshDirectory = useCallback(async () => {
    await Promise.all([refresh(), observeSources()]);
  }, [refresh, observeSources]);
  useEffect(() => {
    // Finder/终端移走或恢复目录不会产生项目写事件；回到窗口时重新检查并恢复观察。
    const onFocus = () => void refreshDirectory();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshDirectory]);
  useEffect(() => {
    const subscriptions = (registry ? [] : scopes).map((scope) =>
      services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type === "workspace_task_list_changed") void refresh();
      }),
    );
    const broadcast = projectChanges
      ? projectChanges.onDidChange(() => void refresh())
      : services.broadcastService.onMessage((event) => {
          if (event.channel === "state:projects") void refresh();
        });
    return () => {
      subscriptions.forEach((subscription) => subscription.dispose());
      broadcast.dispose();
    };
  }, [scopeKey, services, projectChanges, refresh, registry]);
  const activity = useWorkspaceSessionsIndexItems(registry ? [] : scopes);
  const lastDisplay = useRef<ProjectTree>(EMPTY);
  const displayedTree = useMemo(() => {
    const activities = registry
      ? registry.readActivities()
      : activity.items.flatMap((task) => {
          const live = getTaskListRowActivity(task);
          return live
            ? [
                {
                  address: {
                    taskId: task.taskId,
                    workspacePath: task.workspacePath,
                    workspaceIdentity: task.workspaceIdentity,
                  },
                  activity: live,
                },
              ]
            : [];
        });
    const next = applyProjectTaskActivities(tree, activities);
    lastDisplay.current = stabilizeProjectTree(lastDisplay.current, next);
    return lastDisplay.current;
  }, [tree, activity.items, registry, revision]);
  return useMemo(
    () => ({
      tree: displayedTree,
      factTree: tree,
      directory,
      availability,
      hostReadErrors,
      service,
      remoteService,
      refresh: refreshDirectory,
      commitCreatedTask,
      error,
      loading,
    }),
    [
      displayedTree,
      tree,
      directory,
      availability,
      hostReadErrors,
      service,
      remoteService,
      refreshDirectory,
      commitCreatedTask,
      error,
      loading,
    ],
  );
}
