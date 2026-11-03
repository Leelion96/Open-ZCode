import type {
  DataSyncBlockedReason,
  DataSyncListItem,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginsOverviewResult,
} from "@zcode/shared";

/**
 * marketplace 插件分类的纯映射（docs/remote/data-sync.md「插件 · marketplace 插件」）。
 * 两端用同一套规则把插件管理 overview 投影成数据同步条目，比较交给 compare.ts。
 */

/** marketplace 来源在目标端的准备方式。 */
export type MarketplaceSourcePlan =
  /** 官方 marketplace：两端默认存在，不 add（官方 id 也不允许用户添加）。 */
  | { kind: "official" }
  /** 网络来源（github / git / url）：在目标端直接 add。 */
  | { kind: "network"; input: string }
  /** Personal Source 的本地目录类来源（file / directory / settings）：先镜像到目标端再 add。 */
  | { kind: "mirror"; source: Record<string, unknown> }
  | { kind: "unsupported" };

const MIRROR_SOURCE_KINDS = new Set(["file", "directory", "settings"]);

function readTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 与旧插件同步弹窗相同的来源序列化：github 取 `repo[#ref]`，git 取 `url[#ref]`，url 取 `url`。 */
export function resolveMarketplaceSourcePlan(
  marketplace: ZCodePluginMarketplaceSummary,
): MarketplaceSourcePlan {
  if (marketplace.isOfficial) return { kind: "official" };
  const source = marketplace.source;
  const kind = readTrimmed(source.source) ?? "";
  const ref = readTrimmed(source.ref);
  const refSuffix = ref ? `#${ref}` : "";
  const repo = readTrimmed(source.repo);
  const url = readTrimmed(source.url);
  if (kind === "github" && repo) return { kind: "network", input: `${repo}${refSuffix}` };
  if (kind === "git" && url) return { kind: "network", input: `${url}${refSuffix}` };
  if (kind === "url" && url) return { kind: "network", input: url };
  if (MIRROR_SOURCE_KINDS.has(kind)) return { kind: "mirror", source };
  return { kind: "unsupported" };
}

export function marketplacePluginKey(pluginId: string): string {
  return pluginId.trim().toLowerCase();
}

export interface UserMarketplacePlugin {
  installed: ZCodeInstalledPluginSummary;
  info?: ZCodePluginInfo;
  /** undefined 表示该端没有这个 marketplace（Orphaned Installed Plugin）。 */
  marketplace?: ZCodePluginMarketplaceSummary;
}

/**
 * 该端 User scope 下的 marketplace 插件：只取 scope 为 user 的安装记录；
 * listPlugins 中 source 为 official 的（Builtin Plugin、官方资源包自带的插件）不列出。
 */
export function selectUserMarketplacePlugins(
  overview: ZCodePluginsOverviewResult,
  plugins: readonly ZCodePluginInfo[],
): UserMarketplacePlugin[] {
  const infoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const marketplaceById = new Map(overview.marketplaces.map((item) => [item.id, item]));
  return overview.installedPlugins.flatMap((installed) => {
    if (installed.scope !== "user") return [];
    const info = infoById.get(installed.id);
    if (info?.source === "official") return [];
    const marketplace = marketplaceById.get(installed.marketplace);
    return [{ installed, ...(info ? { info } : {}), ...(marketplace ? { marketplace } : {}) }];
  });
}

function resolveExportBlockedReason(
  plugin: UserMarketplacePlugin,
  mirrorBlocked: ReadonlySet<string>,
): DataSyncBlockedReason | undefined {
  if (!plugin.marketplace) return "source-removed";
  const plan = resolveMarketplaceSourcePlan(plugin.marketplace);
  if (plan.kind === "unsupported") return "unsupported-source";
  if (mirrorBlocked.has(plugin.installed.id)) return "cross-marketplace-dependency";
  return undefined;
}

/**
 * 投影成数据同步条目：只按版本比较；`latestVersion` 取该端 catalog 中该插件的版本，
 * 作为目标端时决定能否「更新」（不能指定版本，只能装上来源当前的最新版本）。
 */
export function buildMarketplacePluginSyncItems(params: {
  overview: ZCodePluginsOverviewResult;
  plugins: readonly UserMarketplacePlugin[];
  /** 镜像预检判定不能镜像的插件 id。 */
  mirrorBlocked: ReadonlySet<string>;
}): DataSyncListItem[] {
  const catalogVersionById = new Map(
    params.overview.availablePlugins.map((plugin) => [plugin.id, plugin.version]),
  );
  return params.plugins.map((plugin) => {
    const { installed } = plugin;
    const description = [installed.marketplace, installed.description ?? plugin.info?.description]
      .filter(Boolean)
      .join(" · ");
    const latestVersion = catalogVersionById.get(installed.id);
    const exportBlockedReason = resolveExportBlockedReason(plugin, params.mirrorBlocked);
    return {
      key: marketplacePluginKey(installed.id),
      name: installed.name,
      pluginId: installed.id,
      description,
      ...(installed.version ? { version: installed.version } : {}),
      versionOnly: true,
      ...(latestVersion ? { latestVersion } : {}),
      enabled: installed.enabled,
      ...(exportBlockedReason ? { exportBlockedReason } : {}),
    };
  });
}

/** 本地目录类来源的插件按 marketplace 分组，供镜像预检与镜像导出使用。 */
export function groupMirrorMarketplacePlugins(
  plugins: readonly UserMarketplacePlugin[],
): Map<string, { source: Record<string, unknown>; plugins: UserMarketplacePlugin[] }> {
  const groups = new Map<
    string,
    { source: Record<string, unknown>; plugins: UserMarketplacePlugin[] }
  >();
  for (const plugin of plugins) {
    if (!plugin.marketplace) continue;
    const plan = resolveMarketplaceSourcePlan(plugin.marketplace);
    if (plan.kind !== "mirror") continue;
    const group = groups.get(plugin.marketplace.id) ?? { source: plan.source, plugins: [] };
    group.plugins.push(plugin);
    groups.set(plugin.marketplace.id, group);
  }
  return groups;
}
