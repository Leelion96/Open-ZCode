import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type {
  DataSyncImportItem,
  DataSyncImportResultItem,
  DataSyncListItem,
  DataSyncWorkspaceMapping,
  DeviceSyncResult,
  SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import type {
  DataSyncAfterPushContext,
  DataSyncCategoryAdapter,
} from "@/data-sync/app/categories.js";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import type { DataSyncPushControl } from "@/data-sync/app/marketplacePluginSync.js";
import {
  aggregateDeviceSyncResult,
  chunkDataSyncRows,
  compareDataSyncItems,
  selectDataSyncHashRequests,
  type DataSyncRow,
} from "@/data-sync/domain/compare.js";

/** 写权限预检超时，与旧同步弹窗一致。 */
export const DATA_SYNC_PREFLIGHT_TIMEOUT_MS = 15_000;

export type DataSyncPushState = "idle" | "pushing" | "done" | "failed";

export interface DataSyncItemError {
  status: "failed" | "conflict";
  message?: string;
}

export interface DataSyncCategoryView {
  id: DataSyncCategoryId;
  phase: "loading" | "ready" | "error";
  error?: string;
  rows: DataSyncRow[];
  localCount: number;
  remoteCount: number;
  /** 最近一次加载的两端条目 key（含各端独有项），供其他分类的依赖提示使用；只在 phase 为 ready 时有效。 */
  sourceKeys: ReadonlySet<string>;
  targetKeys: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  push: DataSyncPushState;
  /** 分类整体失败（预检、RPC、断线）的原因；`offline` 表示推送中设备断开。 */
  pushError?: string;
  itemErrors: Readonly<Record<string, DataSyncItemError>>;
  failedCount: number;
  /** 推送中当前可「停止」的项（marketplace 插件的远端 add / install 阶段）。 */
  stoppable: ReadonlySet<string>;
}

export type DataSyncPushAllState = "idle" | "pushing" | "done";

interface PushOutcome {
  succeeded: number;
  failed: number;
}

/** 一次推送（单个分类或推送全部）。断线时被作废，迟到结果按 session 身份丢弃。 */
interface PushSession {
  kind: "category" | "all";
  outcomes: PushOutcome[];
  activeCategory?: DataSyncCategoryId;
}

class StalePushError extends Error {}

export const DATA_SYNC_OFFLINE_ERROR = "offline";
export const DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR = "preflight-timeout";

function createInitialView(id: DataSyncCategoryId): DataSyncCategoryView {
  return {
    id,
    phase: "loading",
    rows: [],
    localCount: 0,
    remoteCount: 0,
    sourceKeys: new Set(),
    targetKeys: new Set(),
    selected: new Set(),
    push: "idle",
    itemErrors: {},
    failedCount: 0,
    stoppable: new Set(),
  };
}

function signatureOf(item: DataSyncListItem): string {
  return item.signature ? `${item.signature.fileCount}:${item.signature.totalBytes}` : "";
}

type HashCache = Map<string, { signature: string; hash: string }>;

/**
 * 弹窗内缓存（性能措施 5）：签名不变的项复用上次的哈希；推送涉及的目标项在推送后失效。
 * 没有签名的条目（JSON 类，例如 MCP）哈希很便宜，不进缓存：否则签名恒为空，本机编辑后仍会命中旧哈希。
 * 返回缓存命中的哈希和仍需向服务请求的 key。
 */
function readHashCache(
  cache: HashCache,
  items: readonly DataSyncListItem[],
  keys: readonly string[],
): { hashes: Record<string, string>; missing: string[] } {
  const signatureByKey = new Map(items.map((item) => [item.key, signatureOf(item)]));
  const hashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const signature = signatureByKey.get(key);
    const cached = signature ? cache.get(key) : undefined;
    if (cached && cached.signature === signature) hashes[key] = cached.hash;
    else missing.push(key);
  }
  return { hashes, missing };
}

function writeHashCache(
  cache: HashCache,
  items: readonly DataSyncListItem[],
  hashes: Readonly<Record<string, string>>,
): void {
  const signatureByKey = new Map(items.map((item) => [item.key, signatureOf(item)]));
  for (const [key, hash] of Object.entries(hashes)) {
    const signature = signatureByKey.get(key);
    if (signature) cache.set(key, { signature, hash });
  }
}

function toImportItem(row: DataSyncRow): DataSyncImportItem {
  return {
    key: row.key,
    mode: row.importMode ?? "createOnly",
    ...(row.expectedTargetHash ? { expectedTargetHash: row.expectedTargetHash } : {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function workspaceParam(workspace: DataSyncWorkspaceMapping | undefined): {
  workspace?: DataSyncWorkspaceMapping;
} {
  return workspace ? { workspace } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 数据同步弹窗状态 owner。
 *
 * generation：弹窗绑定设备的一次连接。`online && targetServices` 换代（断线、重连、attachment 换代）
 * 时递增 generation：断线则禁用操作并把进行中的推送标为失败；重连则清空目标端哈希缓存并重新加载。
 * 所有异步结果在落盘到状态前核对 generation / push session，旧连接的迟到结果一律丢弃。
 */
export function useDataSyncDialog(params: {
  categories: readonly DataSyncCategoryAdapter[];
  sourceServerId: string;
  sourceServices: IServiceAccessor | undefined;
  targetServices: IServiceAccessor | undefined;
  online: boolean;
  workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[];
  workspaceTabs?: DataSyncAfterPushContext["workspaceTabs"];
  /** 只传给来源端（哈希与导出）；弹窗打开期间不变。 */
  workspace?: DataSyncWorkspaceMapping;
  onPushFinished(result: DeviceSyncResult): void | Promise<void>;
  /** 逐插件 sync 终态上报；没有平台（例如测试）时不传。 */
  reportPluginSyncResult?: DataSyncPushControl["reportPluginSyncResult"];
}) {
  const { categories, sourceServices } = params;
  const connection = params.online ? params.targetServices : undefined;
  const [views, setViews] = useState<Record<string, DataSyncCategoryView>>(() =>
    Object.fromEntries(categories.map((category) => [category.id, createInitialView(category.id)])),
  );
  const [pushAllState, setPushAllState] = useState<DataSyncPushAllState>("idle");
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const generationRef = useRef(0);
  const connectionRef = useRef(connection);
  const sessionRef = useRef<PushSession | null>(null);
  /** 当前推送分类中可停止项的停止回调；推送结束或作废时清空。 */
  const stoppersRef = useRef<Map<string, () => void> | null>(null);
  /** 推送后刷新的串行队列：按推送顺序执行，不属于 push session，推送不等待它。 */
  const afterPushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sourceCacheRef = useRef(new Map<DataSyncCategoryId, HashCache>());
  const targetCacheRef = useRef(new Map<DataSyncCategoryId, HashCache>());
  const latestParamsRef = useRef(params);
  latestParamsRef.current = params;

  const updateView = useCallback(
    (id: DataSyncCategoryId, update: (view: DataSyncCategoryView) => DataSyncCategoryView) => {
      setViews((current) => {
        const view = current[id];
        return view ? { ...current, [id]: update(view) } : current;
      });
    },
    [],
  );

  const cacheFor = (store: Map<DataSyncCategoryId, HashCache>, id: DataSyncCategoryId) => {
    let cache = store.get(id);
    if (!cache) {
      cache = new Map();
      store.set(id, cache);
    }
    return cache;
  };

  const loadCategory = useCallback(
    async (category: DataSyncCategoryAdapter, mode: "initial" | "refresh") => {
      const generation = generationRef.current;
      const target = connectionRef.current;
      if (!sourceServices || !target) return;
      const sourceService = category.getService(sourceServices);
      const targetService = category.getService(target);
      if (mode === "initial") {
        updateView(category.id, (view) => ({ ...view, phase: "loading", error: undefined }));
      }
      try {
        // 两端并行（性能措施 4）；概览按分类逐行显示加载状态。
        const [sourceList, targetList] = await Promise.all([
          sourceService.listSyncItems(),
          targetService.listSyncItems(),
        ]);
        if (generation !== generationRef.current) return;
        const requests = selectDataSyncHashRequests(
          sourceList.items,
          targetList.items,
          targetList.importBlockedReason,
        );
        const sourceCache = cacheFor(sourceCacheRef.current, category.id);
        const targetCache = cacheFor(targetCacheRef.current, category.id);
        const sourceCached = readHashCache(sourceCache, sourceList.items, requests.sourceKeys);
        const targetCached = readHashCache(targetCache, targetList.items, requests.targetKeys);
        const [sourceHashes, targetHashes] = await Promise.all([
          sourceCached.missing.length > 0
            ? // 来源端带上目标端 home：需要路径改写的分类（MCP）按目标端路径计算后再比较。
              sourceService.getSyncContentHashes({
                keys: sourceCached.missing,
                targetHomeDir: targetList.homeDir,
                ...workspaceParam(latestParamsRef.current.workspace),
              })
            : Promise.resolve({ hashes: {} }),
          targetCached.missing.length > 0
            ? targetService.getSyncContentHashes({ keys: targetCached.missing })
            : Promise.resolve({ hashes: {} }),
        ]);
        if (generation !== generationRef.current) return;
        writeHashCache(sourceCache, sourceList.items, sourceHashes.hashes);
        writeHashCache(targetCache, targetList.items, targetHashes.hashes);
        const rows = compareDataSyncItems({
          sourceItems: sourceList.items,
          targetItems: targetList.items,
          sourceHashes: { ...sourceCached.hashes, ...sourceHashes.hashes },
          targetHashes: { ...targetCached.hashes, ...targetHashes.hashes },
          targetBlockedReason: targetList.importBlockedReason,
        });
        const selectable = new Set(rows.filter((row) => row.selectable).map((row) => row.key));
        updateView(category.id, (view) => ({
          ...view,
          phase: "ready",
          error: undefined,
          rows,
          localCount: sourceList.items.length,
          remoteCount: targetList.items.length,
          sourceKeys: new Set(sourceList.items.map((item) => item.key)),
          targetKeys: new Set(targetList.items.map((item) => item.key)),
          // 首次加载用默认勾选；推送后刷新保留用户仍可勾选的选择（失败项留着便于「再次同步」）。
          selected:
            mode === "initial"
              ? new Set(rows.filter((row) => row.defaultSelected).map((row) => row.key))
              : new Set([...view.selected].filter((key) => selectable.has(key))),
        }));
      } catch (error) {
        if (generation !== generationRef.current) return;
        logger.warn("[DataSync] 加载分类失败", {
          category: category.id,
          error: errorMessage(error),
        });
        updateView(category.id, (view) => ({
          ...view,
          phase: "error",
          error: errorMessage(error),
        }));
      }
    },
    [sourceServices, updateView],
  );

  /**
   * 断线或换代：作废进行中的推送，当前分类标为失败，并按一次推送结束写入设备同步状态。
   * 修复：原来把断线计为当前分类 1 项失败再按条目汇总，前序分类成功时写成 partial；
   * spec 规定推送中设备断开按失败写入，这里直接写 failed。
   */
  const abandonActiveSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    stoppersRef.current = null;
    if (session.activeCategory) {
      updateView(session.activeCategory, (view) =>
        view.push === "pushing"
          ? { ...view, push: "failed", pushError: DATA_SYNC_OFFLINE_ERROR, stoppable: new Set() }
          : view,
      );
    }
    setPushAllState("idle");
    logger.info("[DataSync] 推送中设备断开，结果作废", {
      sourceServerId: latestParamsRef.current.sourceServerId,
    });
    void latestParamsRef.current.onPushFinished("failed");
  }, [updateView]);

  useEffect(() => {
    generationRef.current += 1;
    connectionRef.current = connection;
    abandonActiveSession();
    if (!connection) return;
    targetCacheRef.current.clear();
    for (const category of categories) void loadCategory(category, "initial");
  }, [abandonActiveSession, categories, connection, loadCategory]);

  const runCategoryPush = useCallback(
    async (category: DataSyncCategoryAdapter, session: PushSession): Promise<PushOutcome> => {
      // 修复原因：断线作废 session 后，推送全部的旧循环仍会在旧 RPC 结束后进入下一分类，
      // 拿新连接把该分类标为「推送中」再被 assertAlive 打断，弹窗永远停在推送中。入口先核对 session。
      if (sessionRef.current !== session) throw new StalePushError();
      const view = viewsRef.current[category.id];
      const target = connectionRef.current;
      if (!view || !sourceServices || !target) return { succeeded: 0, failed: 0 };
      const rows = view.rows.filter((row) => row.selectable && view.selected.has(row.key));
      if (rows.length === 0) return { succeeded: 0, failed: 0 };
      const stoppers = new Map<string, () => void>();
      stoppersRef.current = stoppers;
      const control: DataSyncPushControl = {
        setStoppable(key, stop) {
          if (sessionRef.current !== session || stoppersRef.current !== stoppers) return;
          if (stop) stoppers.set(key, stop);
          else stoppers.delete(key);
          const keys = new Set(stoppers.keys());
          updateView(category.id, (current) => ({ ...current, stoppable: keys }));
        },
        reportPluginSyncResult(outcome) {
          latestParamsRef.current.reportPluginSyncResult?.(outcome);
        },
      };
      const sourceService = category.getService(sourceServices);
      const targetService = category.getService(target, control);
      const assertAlive = () => {
        if (sessionRef.current !== session) throw new StalePushError();
      };
      session.activeCategory = category.id;
      updateView(category.id, (current) => ({
        ...current,
        push: "pushing",
        pushError: undefined,
        itemErrors: {},
        failedCount: 0,
      }));
      try {
        const access = await withTimeout(
          targetService.checkSyncWriteAccess(),
          DATA_SYNC_PREFLIGHT_TIMEOUT_MS,
        );
        assertAlive();
        if (!access.ok)
          throw new Error(access.error ? `${access.path}: ${access.error}` : access.path);
        const results: DataSyncImportResultItem[] = [];
        // 同一分类按批次串行导出、导入；目标端每批一次导入。父子技能同时选中时同批、上级在前。
        // 修复原因：原来所有批次共用分类外层的 catch，后一批抛错时前面批次已写入的结果被丢弃，
        // 整个分类记为全部失败，也跳过了哈希失效和推送后刷新。修法：批内异常只把该批各项记为失败，
        // 继续下一批，最后统一汇总；旧 session 的异常仍按过期外抛。
        for (const batch of chunkDataSyncRows(rows, category.maxBatchBytes, view.rows)) {
          try {
            const payload = await sourceService.exportSyncItems({
              keys: batch.map((row) => row.key),
              ...workspaceParam(latestParamsRef.current.workspace),
            });
            assertAlive();
            const imported = await targetService.importSyncItems({
              payload,
              items: batch.map(toImportItem),
            });
            assertAlive();
            results.push(...imported.results);
          } catch (error) {
            if (error instanceof StalePushError || sessionRef.current !== session) {
              throw new StalePushError();
            }
            const message = errorMessage(error);
            logger.warn("[DataSync] 批次推送失败", {
              category: category.id,
              keys: batch.map((row) => row.key),
              error: message,
            });
            for (const row of batch)
              results.push({ key: row.key, status: "failed", error: message });
          }
        }
        const resultByKey = new Map(results.map((result) => [result.key, result]));
        const itemErrors: Record<string, DataSyncItemError> = {};
        let succeeded = 0;
        for (const row of rows) {
          const result = resultByKey.get(row.key);
          if (result && result.status !== "failed" && result.status !== "conflict") {
            succeeded += 1;
          } else {
            itemErrors[row.key] = {
              status: result?.status === "conflict" ? "conflict" : "failed",
              ...(result?.error ? { message: result.error } : {}),
            };
          }
        }
        const failed = rows.length - succeeded;
        // 推送后只重算受影响的项：目标端这些 key 的哈希缓存作废（冲突项同样作废，避免反复冲突）。
        const targetCache = cacheFor(targetCacheRef.current, category.id);
        for (const row of rows) targetCache.delete(row.key);
        updateView(category.id, (current) => ({
          ...current,
          push: failed > 0 ? "failed" : "done",
          itemErrors,
          failedCount: failed,
        }));
        logger.info("[DataSync] 分类推送完成", {
          sourceServerId: latestParamsRef.current.sourceServerId,
          category: category.id,
          succeeded,
          failed,
        });
        // 修复原因：这里原来 await afterPush 后才返回，刷新一直不结束时 push session 不能收口：
        // onPushFinished 不调用（设备同步状态不写入），sessionRef 一直占用，之后的推送被入口静默忽略。
        // afterPush 只刷新运行态，不是导入成功的条件。修法：放进弹窗内的串行队列，不阻塞推送；
        // 串行是为了保持各分类刷新的先后，避免先发的刷新晚到、覆盖后一次刷新的结果。
        const context: DataSyncAfterPushContext = {
          sourceServerId: latestParamsRef.current.sourceServerId,
          targetServices: target,
          workspaceHistory: latestParamsRef.current.workspaceHistory,
          workspaceTabs: latestParamsRef.current.workspaceTabs,
        };
        afterPushQueueRef.current = afterPushQueueRef.current
          .then(() => category.afterPush?.(context))
          .catch((error: unknown) =>
            logger.warn("[DataSync] 推送后刷新失败", {
              category: category.id,
              error: errorMessage(error),
            }),
          );
        void loadCategory(category, "refresh");
        return { succeeded, failed };
      } catch (error) {
        // 修复原因：旧 session 的 RPC 在重连后才 reject 时，原来按普通失败处理，会覆盖新 session
        // 的「推送中」并放开关闭。迟到的结果一律丢弃，旧 session 的异常同样按过期处理。
        if (error instanceof StalePushError || sessionRef.current !== session) {
          throw new StalePushError();
        }
        logger.warn("[DataSync] 分类推送失败", {
          category: category.id,
          error: errorMessage(error),
        });
        updateView(category.id, (current) => ({
          ...current,
          push: "failed",
          pushError: errorMessage(error),
          failedCount: rows.length,
        }));
        return { succeeded: 0, failed: rows.length };
      } finally {
        if (stoppersRef.current === stoppers) {
          stoppersRef.current = null;
          updateView(category.id, (current) => ({ ...current, stoppable: new Set() }));
        }
      }
    },
    [loadCategory, sourceServices, updateView],
  );

  const runSession = useCallback(
    async (kind: PushSession["kind"], targets: readonly DataSyncCategoryAdapter[]) => {
      if (sessionRef.current || !connectionRef.current) return;
      const session: PushSession = { kind, outcomes: [] };
      sessionRef.current = session;
      if (kind === "all") setPushAllState("pushing");
      try {
        for (const category of targets) {
          session.outcomes.push(await runCategoryPush(category, session));
        }
      } catch (error) {
        if (error instanceof StalePushError) return;
        throw error;
      }
      if (sessionRef.current !== session) return;
      sessionRef.current = null;
      const result = aggregateDeviceSyncResult(session.outcomes);
      if (kind === "all") setPushAllState(result === "success" ? "done" : "idle");
      await latestParamsRef.current.onPushFinished(result);
    },
    [runCategoryPush],
  );

  const pushCategory = useCallback(
    (id: DataSyncCategoryId) => {
      const category = categories.find((candidate) => candidate.id === id);
      if (category) void runSession("category", [category]);
    },
    [categories, runSession],
  );

  /** 推送全部：只执行有勾选项的分类，按分类串行。 */
  const pushAll = useCallback(() => {
    const targets = categories.filter(
      (category) => (viewsRef.current[category.id]?.selected.size ?? 0) > 0,
    );
    if (targets.length > 0) void runSession("all", targets);
  }, [categories, runSession]);

  /** 按行「停止」：只作用于当前推送分类中处于远端 add / install 阶段的该项。 */
  const stopItem = useCallback((id: DataSyncCategoryId, key: string) => {
    if (sessionRef.current?.activeCategory !== id) return;
    stoppersRef.current?.get(key)?.();
  }, []);

  const setSelection = useCallback(
    (id: DataSyncCategoryId, keys: Iterable<string>) => {
      setPushAllState((state) => (state === "done" ? "idle" : state));
      updateView(id, (view) => {
        const selectable = new Set(view.rows.filter((row) => row.selectable).map((row) => row.key));
        return { ...view, selected: new Set([...keys].filter((key) => selectable.has(key))) };
      });
    },
    [updateView],
  );

  const pushing = useMemo(
    () =>
      Object.values(views).some((view) => view.push === "pushing") || pushAllState === "pushing",
    [pushAllState, views],
  );

  return {
    views,
    /** online 且 attachment 已就绪；否则禁用操作（离线提示由调用方按 online 显示）。 */
    connected: Boolean(connection),
    pushing,
    pushAllState,
    setSelection,
    pushCategory,
    pushAll,
    stopItem,
  };
}
