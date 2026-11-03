import {
  pickPortablePluginOptions,
  type DataSyncImportItem,
  type DataSyncImportResult,
  type DataSyncImportResultItem,
  type DataSyncListResult,
  type PluginDataSyncPayload,
  type PluginOptionSyncValue,
  type IPlatformService,
  type RemoteTarget,
  type ZCodePluginsInstallResult,
} from "@zcode/shared";
import {
  withPluginTelemetry,
  type IDataSyncCategoryService,
  type IPluginManagementService,
  type IServiceAccessor,
} from "@zcode/services";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { logger } from "@/logger.js";
import {
  buildMarketplacePluginSyncItems,
  groupMirrorMarketplacePlugins,
  marketplacePluginKey,
  resolveMarketplaceSourcePlan,
  selectUserMarketplacePlugins,
  type UserMarketplacePlugin,
} from "@/data-sync/domain/marketplacePlugins.js";

/**
 * marketplace 插件分类（docs/remote/data-sync.md「插件 · marketplace 插件」）。
 *
 * 插件安装依赖 Agent 的 add / install RPC，不放进文件型服务；这里把它们编排成
 * IDataSyncCategoryService 的形状：export 在来源端执行（读 overview、导出镜像），
 * import 在目标端执行（准备来源 → install → 启用状态 / options）。两端都由各自的 services 构造，
 * 方向只取决于调用方把哪一端当 source、哪一端当 target。
 */

/** 一个插件在目标端导入结束后的终态，用于逐插件 sync 埋点。 */
export interface PluginSyncOutcome {
  pluginId: string;
  marketplace: string;
  result: DataSyncImportResultItem;
  durationMs: number;
}

/** 推送中由弹窗注入：某项进入 / 离开可「停止」的阶段（远端 add / install），以及逐插件结果上报。 */
export interface DataSyncPushControl {
  setStoppable(key: string, stop: (() => void) | null): void;
  reportPluginSyncResult?(outcome: PluginSyncOutcome): void;
}

/** 按行停止后该项的错误标记，弹窗显示为「已停止」。 */
export const DATA_SYNC_STOPPED_ERROR = "stopped";

function toPluginSyncTelemetryResult(item: DataSyncImportResultItem): string {
  if (item.status === "created" || item.status === "updated") return "success";
  if (item.status === "skipped") return "noop";
  if (item.error === DATA_SYNC_STOPPED_ERROR) return "cancelled";
  return "failure";
}

/**
 * 逐插件 sync 终态埋点（docs/monitoring/plugin-lifecycle-telemetry.md）。
 * 修复原因：旧插件同步弹窗删除后，逐插件「同步最终结果」的上报一起被删除，没有替代；
 * 底层 install / enable 的 trigger=sync 事件表达不了安装后版本核验、options 失败这类终态。
 * 只上报白名单字段，不带原始错误或路径；上报失败不影响同步结果。
 */
export function createPluginSyncResultReporter(
  platform: Pick<IPlatformService, "reportTelemetryEvent">,
  remoteKind: RemoteTarget["kind"] | undefined,
): (outcome: PluginSyncOutcome) => void {
  return ({ pluginId, marketplace, result, durationMs }) => {
    void reportAppTelemetryEvent(
      platform,
      {
        elementName: "plugin_lifecycle",
        eventRegion: "app",
        eventType: "result",
        eventExtraDetail: {
          schema_version: "1",
          action: "sync",
          trigger: "sync",
          scope: USER_SCOPE,
          plugin_id: pluginId,
          marketplace,
          client_kind: "desktop",
          workspace_kind: "remote",
          ...(remoteKind ? { remote_kind: remoteKind } : {}),
          result: toPluginSyncTelemetryResult(result),
          duration_ms: String(Math.max(0, Math.round(durationMs))),
        },
      },
      "DataSync",
    );
  };
}

type MarketplaceSourcePayload =
  | { kind: "official" }
  | { kind: "network"; input: string }
  | { kind: "mirror"; archive: Uint8Array }
  /** 来源端无法准备（来源类型不支持、镜像导出失败）；只影响需要准备来源的项。 */
  | { kind: "unavailable"; error: string };

export interface MarketplacePluginSyncPayload {
  items: Array<{
    key: string;
    pluginId: string;
    pluginName: string;
    marketplace: string;
    version?: string;
    enabled: boolean;
    /** 来源端按自己的 schema 筛过的安全 options；目标端按自己的 schema 再筛一次。 */
    options: Record<string, PluginOptionSyncValue>;
  }>;
  sources: Record<string, MarketplaceSourcePayload>;
}

/** 插件分类的组合 payload：inline 插件走 pluginSyncService，marketplace 插件走 Agent 编排。 */
export interface PluginCategorySyncPayload {
  inline?: PluginDataSyncPayload;
  marketplace?: MarketplacePluginSyncPayload;
}

class DataSyncStoppedError extends Error {}

const USER_SCOPE = "user" as const;
let operationCounter = 0;

function createOperationId(key: string): string {
  operationCounter += 1;
  return `data-sync-plugin-${operationCounter}-${key.replace(/[^a-z0-9._-]+/giu, "-")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatInstallError(result: ZCodePluginsInstallResult, pluginId: string): string | null {
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
  if (errors.length === 0) return null;
  return errors
    .map((diagnostic) => `${diagnostic.pluginId ?? pluginId}: ${diagnostic.message}`)
    .join("; ");
}

function sameOptions(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(([key, value]) => right[key] === value)
  );
}

/**
 * 该端 User scope 的插件视图。数据同步从设置页打开时没有项目：两端都以该端 Host 的 home
 * （systemService.info）作为 workspacePath、不带 workspace identity，与设置页远端 User scope 的口径一致。
 */
async function readUserPlugins(services: IServiceAccessor) {
  const { homedir } = await services.systemService.info();
  const view = { workspacePath: homedir, configScope: USER_SCOPE };
  const [overview, list] = await Promise.all([
    services.pluginManagementService.getPluginsOverview(view),
    services.pluginManagementService.listPlugins(view),
  ]);
  return {
    homeDir: homedir,
    overview,
    plugins: selectUserMarketplacePlugins(overview, list.plugins),
  };
}

/** 本地目录类来源的镜像预检：跨 marketplace 依赖的插件不能同步。预检失败时不阻塞列表，推送时由镜像导出报告。 */
async function inspectMirrorBlocked(
  services: IServiceAccessor,
  plugins: readonly UserMarketplacePlugin[],
): Promise<Set<string>> {
  const blocked = new Set<string>();
  await Promise.all(
    [...groupMirrorMarketplacePlugins(plugins)].map(async ([marketplaceId, group]) => {
      try {
        const inspection = await services.pluginSyncService.inspectMarketplaceSourceMirror({
          marketplaceId,
          pluginNames: group.plugins.map((plugin) => plugin.installed.name),
          source: group.source,
        });
        for (const name of Object.keys(inspection.blocked)) blocked.add(`${name}@${marketplaceId}`);
      } catch (error) {
        logger.warn("[DataSync] marketplace 镜像预检失败", {
          marketplace: marketplaceId,
          error: errorMessage(error),
        });
      }
    }),
  );
  return blocked;
}

export function createMarketplacePluginDataSyncService(
  services: IServiceAccessor,
  control?: DataSyncPushControl,
): IDataSyncCategoryService<MarketplacePluginSyncPayload> {
  async function exportSources(
    selected: readonly UserMarketplacePlugin[],
    all: readonly UserMarketplacePlugin[],
    mirrorBlocked: ReadonlySet<string>,
  ): Promise<Record<string, MarketplaceSourcePayload>> {
    const sources: Record<string, MarketplaceSourcePayload> = {};
    const mirrorGroups = groupMirrorMarketplacePlugins(all);
    for (const plugin of selected) {
      const marketplace = plugin.marketplace;
      if (!marketplace || sources[marketplace.id]) continue;
      const plan = resolveMarketplaceSourcePlan(marketplace);
      if (plan.kind === "official" || plan.kind === "network") {
        sources[marketplace.id] = plan;
        continue;
      }
      if (plan.kind === "unsupported") {
        sources[marketplace.id] = { kind: "unavailable", error: "unsupported marketplace source" };
        continue;
      }
      // 镜像本机已安装的该 marketplace 全部可镜像插件：重新 add 会替换远端的 catalog，
      // 只镜像本次选中的插件会让远端此前镜像过的插件从 catalog 中消失。
      const pluginNames = (mirrorGroups.get(marketplace.id)?.plugins ?? [])
        .filter((candidate) => !mirrorBlocked.has(candidate.installed.id))
        .map((candidate) => candidate.installed.name);
      try {
        const exported = await services.pluginSyncService.exportMarketplaceSourceArchive({
          marketplaceId: marketplace.id,
          pluginNames,
          source: plan.source,
        });
        sources[marketplace.id] = { kind: "mirror", archive: exported.archive };
      } catch (error) {
        sources[marketplace.id] = { kind: "unavailable", error: errorMessage(error) };
      }
    }
    return sources;
  }

  return {
    async listSyncItems(): Promise<DataSyncListResult> {
      const side = await readUserPlugins(services);
      const mirrorBlocked = await inspectMirrorBlocked(services, side.plugins);
      return {
        items: buildMarketplacePluginSyncItems({
          overview: side.overview,
          plugins: side.plugins,
          mirrorBlocked,
        }),
        homeDir: side.homeDir,
      };
    },

    // 只按版本比较，不计算哈希。
    async getSyncContentHashes() {
      return { hashes: {} };
    },

    // marketplace 镜像写入 ~/.zcode/plugins，安装与配置写入 ~/.zcode/cli，与 inline 插件的预检目录相同。
    checkSyncWriteAccess: () => services.pluginSyncService.checkSyncWriteAccess(),

    async exportSyncItems({ keys }) {
      const side = await readUserPlugins(services);
      const byKey = new Map(
        side.plugins.map((plugin) => [marketplacePluginKey(plugin.installed.id), plugin]),
      );
      const selected = keys.flatMap((key) => {
        const plugin = byKey.get(key);
        return plugin ? [plugin] : [];
      });
      const mirrorBlocked = await inspectMirrorBlocked(services, side.plugins);
      return {
        items: selected.map(({ installed, info }) => ({
          key: marketplacePluginKey(installed.id),
          pluginId: installed.id,
          pluginName: installed.name,
          marketplace: installed.marketplace,
          ...(installed.version ? { version: installed.version } : {}),
          enabled: installed.enabled,
          options: pickPortablePluginOptions(info?.configuredOptions ?? {}, info?.userConfig ?? {}),
        })),
        sources: await exportSources(selected, side.plugins, mirrorBlocked),
      };
    },

    async importSyncItems({ payload, items }): Promise<DataSyncImportResult> {
      const management: IPluginManagementService = withPluginTelemetry(
        services.pluginManagementService,
        { trigger: "sync", client_kind: "desktop" },
      );
      const { homedir } = await services.systemService.info();
      const workspace = { workspacePath: homedir };
      const overview = await management.getPluginsOverview({
        ...workspace,
        configScope: USER_SCOPE,
      });
      const catalog = new Set(overview.availablePlugins.map((plugin) => plugin.id));
      const installedBefore = new Map(
        overview.installedPlugins.map((plugin) => [plugin.id, plugin]),
      );
      const payloadByKey = new Map(payload.items.map((item) => [item.key, item]));
      const preparedMarketplaces = new Set<string>();

      /** 远端 add / install 期间该行可「停止」：发出 cancelPluginOperation，该项立即结束。 */
      async function runStoppable<T>(key: string, run: (operationId: string) => Promise<T>) {
        const operationId = createOperationId(key);
        if (!control) return await run(operationId);
        let stop: () => void = () => undefined;
        const stopped = new Promise<never>((_, reject) => {
          stop = () => reject(new DataSyncStoppedError());
        });
        control.setStoppable(key, () => {
          logger.info("[DataSync] 停止 marketplace 插件推送", { key, operationId });
          void management.cancelPluginOperation({ operationId }).catch((error: unknown) =>
            logger.warn("[DataSync] 取消插件操作失败", {
              operationId,
              error: errorMessage(error),
            }),
          );
          stop();
        });
        try {
          return await Promise.race([run(operationId), stopped]);
        } finally {
          control.setStoppable(key, null);
        }
      }

      async function prepareSource(item: MarketplacePluginSyncPayload["items"][number]) {
        const source = payload.sources[item.marketplace];
        if (!source) throw new Error(`marketplace source is not available: ${item.marketplace}`);
        if (source.kind === "unavailable") throw new Error(source.error);
        if (source.kind === "official") return;
        let input = source.kind === "network" ? source.input : "";
        if (source.kind === "mirror") {
          input = (
            await services.pluginSyncService.importMarketplaceSourceArchive({
              archive: source.archive,
            })
          ).path;
        }
        await runStoppable(item.key, (operationId) =>
          management.addPluginMarketplace({ ...workspace, source: input, operationId }),
        );
      }

      async function syncOptions(item: MarketplacePluginSyncPayload["items"][number]) {
        if (Object.keys(item.options).length === 0) return;
        const list = await management.listPlugins({ ...workspace, configScope: USER_SCOPE });
        const plugin = list.plugins.find((candidate) => candidate.id === item.pluginId);
        if (!plugin) return;
        const portable = pickPortablePluginOptions(item.options, plugin.userConfig ?? {});
        if (Object.keys(portable).length === 0) return;
        const current = plugin.configuredOptions ?? {};
        const merged = { ...current, ...portable };
        if (sameOptions(current, merged)) return;
        await management.configurePlugin({
          ...workspace,
          pluginId: item.pluginId,
          options: merged,
          scope: USER_SCOPE,
        });
      }

      async function importItem(importItem: DataSyncImportItem): Promise<DataSyncImportResultItem> {
        const item = payloadByKey.get(importItem.key);
        if (!item)
          return { key: importItem.key, status: "failed", error: "missing export payload" };
        const update = importItem.mode === "overwrite";
        // 目标端 catalog 没有该插件时先准备来源（远端没有这个 marketplace，或 catalog 尚未包含它）。
        if (!update && !catalog.has(item.pluginId) && !preparedMarketplaces.has(item.marketplace)) {
          await prepareSource(item);
          preparedMarketplaces.add(item.marketplace);
        }
        const result = await runStoppable(item.key, (operationId) =>
          management.installPlugin({
            ...workspace,
            marketplace: item.marketplace,
            pluginName: item.pluginName,
            operationId,
            scope: USER_SCOPE,
          }),
        );
        const installError = formatInstallError(result, item.pluginId);
        if (installError) throw new Error(installError);
        const installed = result.installedPlugins.find((plugin) => plugin.id === item.pluginId);
        if (!installed) throw new Error(`remote install did not return ${item.pluginId}`);
        if (update) {
          // 更新保留远端的启用状态：没有显式启用配置的插件重装后会被默认启用，这里改回原值。
          // 修复原因：原来先核对版本再恢复，版本不符时直接抛错，插件被默认启用后不再改回。
          // 重新安装已经发生，无论版本是否相符都要先恢复启用状态。
          const before = installedBefore.get(item.pluginId);
          if (before && before.enabled !== installed.enabled) {
            await management.setPluginEnabled({
              ...workspace,
              pluginId: item.pluginId,
              enabled: before.enabled,
              scope: USER_SCOPE,
            });
          }
          // 更新只能装上远端来源的最新版本；装完核对版本，与本机不一致即失败。
          if (installed.version !== item.version) {
            throw new Error(
              `remote version after update is ${installed.version ?? "unknown"}, expected ${item.version ?? "unknown"}`,
            );
          }
          return { key: item.key, status: "updated" };
        }
        if (installed.enabled !== item.enabled) {
          await management.setPluginEnabled({
            ...workspace,
            pluginId: item.pluginId,
            enabled: item.enabled,
            scope: USER_SCOPE,
          });
        }
        await syncOptions(item);
        return { key: item.key, status: "created" };
      }

      const results: DataSyncImportResultItem[] = [];
      // 逐项串行，每项单独成功或失败。
      for (const item of items) {
        const startedAt = Date.now();
        let result: DataSyncImportResultItem;
        try {
          result = await importItem(item);
        } catch (error) {
          result = {
            key: item.key,
            status: "failed",
            error:
              error instanceof DataSyncStoppedError ? DATA_SYNC_STOPPED_ERROR : errorMessage(error),
          };
        }
        results.push(result);
        const exported = payloadByKey.get(item.key);
        control?.reportPluginSyncResult?.({
          pluginId: exported?.pluginId ?? item.key,
          marketplace: exported?.marketplace ?? item.key.slice(item.key.lastIndexOf("@") + 1),
          result,
          durationMs: Date.now() - startedAt,
        });
      }
      return { results };
    },
  };
}

const INLINE_KEY_SUFFIX = "@inline";

function isInlineKey(key: string): boolean {
  return key.endsWith(INLINE_KEY_SUFFIX);
}

/** 插件分类 = inline 插件（pluginSyncService）+ marketplace 插件（Agent 编排），按 key 后缀分派。 */
export function createPluginCategoryDataSyncService(
  services: IServiceAccessor,
  control?: DataSyncPushControl,
): IDataSyncCategoryService<PluginCategorySyncPayload> {
  const inline = services.pluginSyncService;
  const marketplace = createMarketplacePluginDataSyncService(services, control);
  return {
    async listSyncItems() {
      const [inlineList, marketplaceList] = await Promise.all([
        inline.listSyncItems(),
        marketplace.listSyncItems(),
      ]);
      return {
        items: [...inlineList.items, ...marketplaceList.items],
        homeDir: inlineList.homeDir,
      };
    },
    // marketplace 条目只按版本比较，不会被请求哈希。
    getSyncContentHashes: (params) => inline.getSyncContentHashes(params),
    checkSyncWriteAccess: () => inline.checkSyncWriteAccess(),
    async exportSyncItems({ keys }) {
      const inlineKeys = keys.filter(isInlineKey);
      const marketplaceKeys = keys.filter((key) => !isInlineKey(key));
      const [inlinePayload, marketplacePayload] = await Promise.all([
        inlineKeys.length > 0 ? inline.exportSyncItems({ keys: inlineKeys }) : undefined,
        marketplaceKeys.length > 0
          ? marketplace.exportSyncItems({ keys: marketplaceKeys })
          : undefined,
      ]);
      return {
        ...(inlinePayload ? { inline: inlinePayload } : {}),
        ...(marketplacePayload ? { marketplace: marketplacePayload } : {}),
      };
    },
    async importSyncItems({ payload, items }) {
      const results: DataSyncImportResultItem[] = [];
      const inlineItems = items.filter((item) => isInlineKey(item.key));
      const marketplaceItems = items.filter((item) => !isInlineKey(item.key));
      if (payload.inline && inlineItems.length > 0) {
        // inline 插件按批导入，耗时为该批的耗时；整批失败时逐项上报失败后照常抛出。
        const pluginIdByKey = new Map(
          payload.inline.items.map((item) => [item.key, item.pluginId]),
        );
        const startedAt = Date.now();
        const report = (result: DataSyncImportResultItem) =>
          control?.reportPluginSyncResult?.({
            pluginId: pluginIdByKey.get(result.key) ?? result.key,
            marketplace: "inline",
            result,
            durationMs: Date.now() - startedAt,
          });
        let inlineResults: DataSyncImportResultItem[];
        try {
          inlineResults = (
            await inline.importSyncItems({ payload: payload.inline, items: inlineItems })
          ).results;
        } catch (error) {
          for (const item of inlineItems) report({ key: item.key, status: "failed" });
          throw error;
        }
        for (const result of inlineResults) report(result);
        results.push(...inlineResults);
      }
      if (payload.marketplace && marketplaceItems.length > 0) {
        results.push(
          ...(
            await marketplace.importSyncItems({
              payload: payload.marketplace,
              items: marketplaceItems,
            })
          ).results,
        );
      }
      return { results };
    },
  };
}
