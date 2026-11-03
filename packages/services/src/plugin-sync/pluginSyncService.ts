import { PRODUCT_USER_DIRECTORY } from "@zcode/shared/product";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { PluginSyncMarketplaceMirrorInspection } from "@zcode/shared";
import { PLUGIN_DATA_SYNC_MAX_ITEM_BYTES } from "@zcode/shared";
import type { IPluginSyncService } from "./pluginSync.js";
import {
  createPluginSyncArchive,
  extractPluginSyncArchive,
  PLUGIN_SYNC_METADATA_ARCHIVE_PATH,
} from "./pluginSyncArchive.js";
import { normalizePluginSyncRelativePath, resolvePluginSyncPathWithin } from "./pluginSyncPath.js";
import { createInlinePluginDataSyncMethods } from "../data-sync/node.js";

export interface PluginManifestInfo {
  name: string;
  pluginId: string;
  description?: string;
  version?: string;
  /** manifest 的 userConfig（options schema），原样保留。 */
  userConfig: Record<string, unknown>;
}

interface UserPluginConfigState {
  dirs: string[];
  enabledOverrides: Map<string, boolean>;
  /** plugins.options，按 pluginId 原样保留大小写。 */
  options: Record<string, unknown>;
}

interface MarketplaceManifestInfo {
  name: string;
  description?: string;
  pluginRoot?: string;
  plugins: MarketplacePluginEntryInfo[];
  raw: Record<string, unknown>;
}

interface MarketplacePluginEntryInfo {
  name: string;
  dependencies: string[];
  raw: Record<string, unknown>;
  source?: unknown;
}

interface MarketplaceSourceLoadResult {
  manifest: MarketplaceManifestInfo;
  sourceRoot?: string;
}

interface MarketplaceSourceMirrorEntry {
  entry: MarketplacePluginEntryInfo;
  mirroredSourcePath?: string;
  mirroredSourceRelativePath?: string;
}

const INLINE_PLUGIN_MARKETPLACE = "inline";
const DEFAULT_MAX_ARCHIVE_BYTES = PLUGIN_DATA_SYNC_MAX_ITEM_BYTES;
const MARKETPLACE_SOURCE_ROOT_DIRECTORY = "marketplace-sources";
const MIRRORED_MARKETPLACE_PLUGIN_ROOT = "plugins";
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  [".zcode-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  [".codex-plugin", "plugin.json"],
] as const;

export function createPluginSyncService(options?: {
  maxArchiveBytes?: number;
}): IPluginSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  return {
    // 数据同步：单个 inline 插件目录上限 50MB；marketplace 来源镜像归档也用同一上限。
    ...createInlinePluginDataSyncMethods({ maxItemBytes: maxArchiveBytes }),
    async exportMarketplaceSourceArchive(params) {
      const result = await exportMarketplaceSourceArchiveInternal(params, maxArchiveBytes);
      if (result.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${result.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return result;
    },
    async inspectMarketplaceSourceMirror(params) {
      const marketplaceId = normalizeMarketplaceId(params.marketplaceId);
      const loaded = await loadMarketplaceSource(params.source);
      const blocked: PluginSyncMarketplaceMirrorInspection["blocked"] = {};
      for (const pluginName of new Set(params.pluginNames)) {
        try {
          resolveMarketplacePluginClosure(loaded.manifest, marketplaceId, [pluginName]);
        } catch (error) {
          if (error instanceof CrossMarketplaceDependencyError) {
            blocked[pluginName] = "cross-marketplace-dependency";
          }
          // 其他错误（插件不在清单中等）留到推送时由镜像导出报告，不在列表阶段猜测。
        }
      }
      return { blocked };
    },
    async importMarketplaceSourceArchive(params) {
      if (params.overwrite) {
        throw new Error("plugin marketplace source overwrite is not supported");
      }
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(
          `plugin marketplace source archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`,
        );
      }
      return await importMarketplaceSourceArchiveInternal(params.archive, maxArchiveBytes);
    },
  };
}

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function getUserZcodeConfigPath(): string {
  return join(resolveUserHomeDir(), PRODUCT_USER_DIRECTORY, "cli", "config.json");
}

export function getUserZcodePluginRoot(): string {
  return join(resolveUserHomeDir(), PRODUCT_USER_DIRECTORY, "plugins");
}

async function exportMarketplaceSourceArchiveInternal(
  params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  },
  maxArchiveBytes: number,
) {
  const marketplaceId = normalizeMarketplaceId(params.marketplaceId);
  const pluginNames = Array.from(
    new Set(params.pluginNames.map((name) => readRequiredString(name, "plugin name"))),
  );
  if (pluginNames.length === 0) {
    throw new Error("missing marketplace plugin names");
  }
  const loaded = await loadMarketplaceSource(params.source);
  if (loaded.manifest.name !== marketplaceId) {
    throw new Error(`marketplace id mismatch: ${loaded.manifest.name} !== ${marketplaceId}`);
  }
  const closure = resolveMarketplacePluginClosure(loaded.manifest, marketplaceId, pluginNames);
  const mirrorEntries = await Promise.all(
    closure.map((entry) => buildMarketplaceSourceMirrorEntry(loaded, entry)),
  );
  const manifest = buildMirroredMarketplaceManifest(loaded.manifest, mirrorEntries);
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const selectedBytes =
    Buffer.byteLength(manifestContent, "utf-8") +
    (
      await Promise.all(
        mirrorEntries.map((entry) =>
          entry.mirroredSourcePath ? computeRecursiveSize(entry.mirroredSourcePath) : 0,
        ),
      )
    ).reduce((total, bytes) => total + bytes, 0);
  if (selectedBytes > maxArchiveBytes) {
    throw new Error(
      `plugin marketplace source archive exceeds limit: ${selectedBytes}/${maxArchiveBytes}`,
    );
  }
  const sourceFingerprints = await Promise.all(
    mirrorEntries.map((entry) =>
      entry.mirroredSourcePath
        ? computeRecursiveContentFingerprint(entry.mirroredSourcePath)
        : null,
    ),
  );
  const directoryName = createMarketplaceSourceDirectoryName(
    marketplaceId,
    manifestContent,
    sourceFingerprints,
  );
  const entries = [
    {
      archivePath: `${directoryName}/marketplace.json`,
      content: manifestContent,
    },
    ...mirrorEntries
      .filter(
        (
          entry,
        ): entry is MarketplaceSourceMirrorEntry & {
          mirroredSourcePath: string;
          mirroredSourceRelativePath: string;
        } => Boolean(entry.mirroredSourcePath && entry.mirroredSourceRelativePath),
      )
      .map((entry) => ({
        archivePath: `${directoryName}/${entry.mirroredSourceRelativePath}`,
        sourcePath: entry.mirroredSourcePath,
      })),
  ];
  const archive = await createPluginSyncArchive({
    entries,
    metadata: {
      plugins: [],
      marketplaceSources: [
        {
          marketplaceId,
          directoryName,
        },
      ],
    },
  });
  return {
    archive,
    archiveBytes: archive.byteLength,
    marketplaceId,
    pluginNames: closure.map((entry) => entry.name),
  };
}

async function importMarketplaceSourceArchiveInternal(
  archive: Uint8Array,
  maxArchiveBytes: number,
) {
  const tempRoot = join(tmpdir(), `zcode-plugin-marketplace-source-${randomUUID()}`);
  try {
    await extractPluginSyncArchive(archive, tempRoot, {
      maxExtractedBytes: maxArchiveBytes,
    });
    const metadata = await readMarketplaceSourceArchiveMetadata(tempRoot);
    const directoryName = normalizePluginSyncRelativePath(metadata.directoryName);
    const extractedPath = resolvePluginSyncPathWithin(tempRoot, directoryName);
    const manifest = await readMarketplaceManifest(join(extractedPath, "marketplace.json"));
    if (manifest.name !== metadata.marketplaceId) {
      throw new Error(
        `marketplace source archive id mismatch: ${manifest.name} !== ${metadata.marketplaceId}`,
      );
    }
    const targetRoot = join(getUserZcodePluginRoot(), MARKETPLACE_SOURCE_ROOT_DIRECTORY);
    const targetPath = resolvePluginSyncPathWithin(targetRoot, directoryName);
    if (existsSync(targetPath)) {
      return {
        marketplaceId: metadata.marketplaceId,
        path: targetPath,
        status: "skipped" as const,
      };
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(extractedPath, targetPath, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return {
      marketplaceId: metadata.marketplaceId,
      path: targetPath,
      status: "synced" as const,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function readUserPluginConfigState(): Promise<UserPluginConfigState> {
  const parsed = await readJsonFileOrEmpty(getUserZcodeConfigPath());
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const enabledOverrides = new Map<string, boolean>();
  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (typeof enabled === "boolean") {
      enabledOverrides.set(normalizePluginIdKey(pluginId), enabled);
    }
  }
  return {
    dirs: readStringArray(plugins.dirs),
    enabledOverrides,
    options: isRecord(plugins.options) ? plugins.options : {},
  };
}

async function readMarketplaceSourceArchiveMetadata(tempRoot: string): Promise<{
  directoryName: string;
  marketplaceId: string;
}> {
  const raw = await readFile(join(tempRoot, PLUGIN_SYNC_METADATA_ARCHIVE_PATH), "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.marketplaceSources)) {
    throw new Error("invalid plugin marketplace source archive metadata");
  }
  if (parsed.marketplaceSources.length !== 1) {
    throw new Error("plugin marketplace source archive must contain one marketplace");
  }
  const item = parsed.marketplaceSources[0];
  if (!isRecord(item)) {
    throw new Error("invalid plugin marketplace source metadata");
  }
  return {
    marketplaceId: normalizeMarketplaceId(
      readRequiredString(item.marketplaceId, "marketplace source id"),
    ),
    directoryName: normalizePluginSyncRelativePath(
      readRequiredString(item.directoryName, "marketplace source directory"),
    ),
  };
}

async function loadMarketplaceSource(
  source: Record<string, unknown>,
): Promise<MarketplaceSourceLoadResult> {
  const sourceKind = typeof source.source === "string" ? source.source : "";
  if (sourceKind === "file") {
    const filePath = readRequiredString(source.path, "marketplace source file path");
    return {
      manifest: await readMarketplaceManifest(filePath),
      sourceRoot: dirname(filePath),
    };
  }
  if (sourceKind === "directory") {
    const sourceRoot = readRequiredString(source.path, "marketplace source directory path");
    const manifestPath = findMarketplaceManifestPath(sourceRoot);
    if (!manifestPath) {
      throw new Error(`marketplace manifest not found in directory: ${sourceRoot}`);
    }
    return {
      manifest: await readMarketplaceManifest(manifestPath),
      sourceRoot,
    };
  }
  if (sourceKind === "settings") {
    if (!isRecord(source.marketplace)) {
      throw new Error("settings marketplace source is missing marketplace manifest");
    }
    return {
      manifest: parseMarketplaceManifest(source.marketplace),
    };
  }
  throw new Error(`unsupported marketplace source for SSH sync: ${sourceKind || "unknown"}`);
}

async function readMarketplaceManifest(filePath: string): Promise<MarketplaceManifestInfo> {
  const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  return parseMarketplaceManifest(parsed);
}

function parseMarketplaceManifest(value: unknown): MarketplaceManifestInfo {
  if (!isRecord(value)) {
    throw new Error("marketplace manifest is invalid");
  }
  const name = readRequiredString(value.name, "marketplace name");
  const rawPlugins = value.plugins;
  const pluginValues = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName },
        )
      : [];
  const plugins = pluginValues.filter(isRecord).map((plugin): MarketplacePluginEntryInfo => {
    const pluginName = readRequiredString(plugin.name, "marketplace plugin name");
    const dependencies = Array.isArray(plugin.dependencies)
      ? plugin.dependencies.filter(
          (dependency): dependency is string =>
            typeof dependency === "string" && dependency.trim().length > 0,
        )
      : [];
    return {
      name: pluginName,
      dependencies,
      raw: plugin,
      ...(plugin.source !== undefined ? { source: plugin.source } : {}),
    };
  });
  return {
    name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...readMarketplacePluginRoot(value),
    plugins,
    raw: value,
  };
}

function readMarketplacePluginRoot(value: Record<string, unknown>): { pluginRoot?: string } {
  if (typeof value.pluginRoot === "string" && value.pluginRoot.trim()) {
    return { pluginRoot: value.pluginRoot.trim() };
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  if (typeof metadata.pluginRoot === "string" && metadata.pluginRoot.trim()) {
    return { pluginRoot: metadata.pluginRoot.trim() };
  }
  return {};
}

function findMarketplaceManifestPath(sourceRoot: string): string | null {
  const candidates = [
    join(sourceRoot, "marketplace.json"),
    join(sourceRoot, ".claude-plugin", "marketplace.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveMarketplacePluginClosure(
  manifest: MarketplaceManifestInfo,
  marketplaceId: string,
  pluginNames: readonly string[],
): MarketplacePluginEntryInfo[] {
  const byName = new Map(manifest.plugins.map((entry) => [entry.name, entry]));
  const visited = new Set<string>();
  const result: MarketplacePluginEntryInfo[] = [];
  const visit = (pluginName: string, requiredBy: string) => {
    const normalizedName = readRequiredString(pluginName, "marketplace plugin name");
    if (visited.has(normalizedName)) {
      return;
    }
    const entry = byName.get(normalizedName);
    if (!entry) {
      throw new Error(`marketplace plugin not found: ${normalizedName}`);
    }
    visited.add(normalizedName);
    result.push(entry);
    for (const dependency of entry.dependencies) {
      visit(normalizeMarketplaceDependency(dependency, marketplaceId, requiredBy), entry.name);
    }
  };
  for (const pluginName of pluginNames) {
    visit(pluginName, pluginName);
  }
  return result;
}

function normalizeMarketplaceDependency(
  dependency: string,
  marketplaceId: string,
  requiredBy: string,
): string {
  const trimmed = dependency.trim();
  const separatorIndex = trimmed.lastIndexOf("@");
  if (separatorIndex < 0) {
    return trimmed;
  }
  const name = trimmed.slice(0, separatorIndex);
  const marketplace = trimmed.slice(separatorIndex + 1);
  if (marketplace === marketplaceId) {
    return name;
  }
  throw new CrossMarketplaceDependencyError(dependency, requiredBy);
}

class CrossMarketplaceDependencyError extends Error {
  constructor(dependency: string, requiredBy: string) {
    super(
      `cross-marketplace dependency is not supported for SSH source mirror: ${dependency} required by ${requiredBy}`,
    );
    this.name = "CrossMarketplaceDependencyError";
  }
}

async function buildMarketplaceSourceMirrorEntry(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<MarketplaceSourceMirrorEntry> {
  if (isRemoteMarketplacePluginSource(entry.source)) {
    return { entry };
  }
  const sourcePath = await resolveLocalMarketplacePluginSource(loaded, entry);
  const sourceDirectoryName = toSafeDirectoryName(entry.name);
  return {
    entry,
    mirroredSourcePath: sourcePath,
    mirroredSourceRelativePath: `${MIRRORED_MARKETPLACE_PLUGIN_ROOT}/${sourceDirectoryName}`,
  };
}

function isRemoteMarketplacePluginSource(source: unknown): boolean {
  if (!isRecord(source)) {
    return false;
  }
  const sourceKind = typeof source.source === "string" ? source.source : "";
  return ["github", "git", "url", "git-subdir", "npm", "pip"].includes(sourceKind);
}

async function resolveLocalMarketplacePluginSource(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<string> {
  if (typeof entry.source === "string") {
    return await resolveLocalMarketplacePluginSourcePath(
      loaded,
      entry.source,
      `${entry.name} source`,
    );
  }
  if (isRecord(entry.source)) {
    const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
    if (sourceKind === "directory" && typeof entry.source.path === "string") {
      return await resolveLocalMarketplacePluginSourcePath(
        loaded,
        entry.source.path,
        `${entry.name} directory source`,
        { allowSettingsAbsoluteDirectorySource: !loaded.sourceRoot },
      );
    }
    return await resolveLocalMarketplacePluginFallback(loaded, entry);
  }
  return await resolveLocalMarketplacePluginFallback(loaded, entry);
}

async function resolveLocalMarketplacePluginFallback(
  loaded: MarketplaceSourceLoadResult,
  entry: MarketplacePluginEntryInfo,
): Promise<string> {
  if (!loaded.sourceRoot) {
    throw new Error(
      `cannot mirror local marketplace plugin source without source root: ${entry.name}`,
    );
  }
  const pluginBaseDir = resolveMarketplacePluginBaseDir(loaded);
  const fallbackPath = resolvePluginSyncPathWithin(pluginBaseDir, entry.name, {
    unsafePathLabel: "unsafe marketplace plugin source path",
  });
  if (await directoryExists(fallbackPath)) {
    return await assertLocalMarketplacePluginSourceRoot(fallbackPath);
  }
  throw new Error(`local marketplace plugin source does not exist: ${fallbackPath}`);
}

async function resolveLocalMarketplacePluginSourcePath(
  loaded: MarketplaceSourceLoadResult,
  sourcePath: string,
  label: string,
  options: { allowSettingsAbsoluteDirectorySource?: boolean } = {},
): Promise<string> {
  const requestedPath = readRequiredString(sourcePath, label);
  const relativeSourcePath = requestedPath.replace(/^\.\//u, "");
  if (!loaded.sourceRoot && options.allowSettingsAbsoluteDirectorySource) {
    if (!isAbsolute(requestedPath)) {
      throw new Error(
        `cannot mirror local marketplace plugin source without source root: ${sourcePath}`,
      );
    }
    const absolutePath = resolve(requestedPath);
    if (await directoryExists(absolutePath)) {
      return await assertLocalMarketplacePluginSourceRoot(absolutePath);
    }
    throw new Error(`local marketplace plugin source does not exist: ${sourcePath}`);
  }
  if (!loaded.sourceRoot) {
    throw new Error(
      `cannot mirror local marketplace plugin source without source root: ${sourcePath}`,
    );
  }
  const pluginBaseDir = resolveMarketplacePluginBaseDir(loaded);
  const relativePath = resolvePluginSyncPathWithin(pluginBaseDir, relativeSourcePath, {
    unsafePathLabel: "unsafe marketplace plugin source path",
  });
  if (await directoryExists(relativePath)) {
    return await assertLocalMarketplacePluginSourceRoot(relativePath);
  }
  throw new Error(`local marketplace plugin source does not exist: ${sourcePath}`);
}

async function assertLocalMarketplacePluginSourceRoot(pluginRoot: string): Promise<string> {
  const manifest = await readPluginManifestInfo(pluginRoot);
  if (!manifest) {
    // marketplace source mirror 只能复制选中插件目录。先验证 plugin manifest，避免被篡改的 marketplace entry
    // 指向普通目录后，把本机敏感文件作为“插件源码”打包发送到 SSH 远端。
    throw new Error(`local marketplace plugin source is missing plugin manifest: ${pluginRoot}`);
  }
  return pluginRoot;
}

function resolveMarketplacePluginBaseDir(loaded: MarketplaceSourceLoadResult): string {
  const sourceRoot = loaded.sourceRoot;
  if (!sourceRoot) {
    throw new Error("cannot resolve marketplace plugin source root");
  }
  if (!loaded.manifest.pluginRoot) {
    return sourceRoot;
  }
  const pluginRoot = resolvePluginSyncPathWithin(sourceRoot, loaded.manifest.pluginRoot, {
    unsafePathLabel: "unsafe marketplace pluginRoot",
  });
  return existsSync(pluginRoot) ? pluginRoot : sourceRoot;
}

function buildMirroredMarketplaceManifest(
  manifest: MarketplaceManifestInfo,
  entries: readonly MarketplaceSourceMirrorEntry[],
): Record<string, unknown> {
  const hasMirroredLocalSource = entries.some((entry) => entry.mirroredSourceRelativePath);
  const rawMetadata = isRecord(manifest.raw.metadata) ? manifest.raw.metadata : {};
  const rawManifest = { ...manifest.raw };
  delete rawManifest.pluginRoot;
  return {
    ...rawManifest,
    name: manifest.name,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(hasMirroredLocalSource
      ? {
          // agent marketplace 解析只读取 metadata.pluginRoot。
          // 远端镜像 manifest 如果写顶层 pluginRoot，会把 ./hello-world 误解析到市场根目录。
          metadata: {
            ...rawMetadata,
            pluginRoot: MIRRORED_MARKETPLACE_PLUGIN_ROOT,
          },
        }
      : {}),
    plugins: entries.map((entry) => {
      const raw: Record<string, unknown> = { ...entry.entry.raw, name: entry.entry.name };
      if (entry.mirroredSourceRelativePath) {
        raw.source = `./${entry.mirroredSourceRelativePath.split("/").slice(1).join("/")}`;
      }
      return raw;
    }),
  };
}

function createMarketplaceSourceDirectoryName(
  marketplaceId: string,
  manifestContent: string,
  sourceFingerprints: readonly (string | null)[],
): string {
  const hashInput = JSON.stringify({
    manifestContent,
    sourceFingerprints,
  });
  return `${toSafeDirectoryName(marketplaceId)}-${createShortHash(hashInput).slice(0, 12)}`;
}

export async function readPluginManifestInfo(
  pluginRoot: string,
): Promise<PluginManifestInfo | null> {
  for (const segments of PLUGIN_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = join(pluginRoot, ...segments);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) {
      return null;
    }
    return {
      name,
      pluginId: `${name}@${INLINE_PLUGIN_MARKETPLACE}`,
      ...(typeof parsed.description === "string" && parsed.description.trim()
        ? { description: parsed.description.trim() }
        : {}),
      ...(typeof parsed.version === "string" && parsed.version.trim()
        ? { version: parsed.version.trim() }
        : {}),
      userConfig: isRecord(parsed.userConfig) ? parsed.userConfig : {},
    };
  }
  return null;
}

async function computeRecursiveSize(path: string): Promise<number> {
  const pathStat = await lstat(path);
  if (pathStat.isFile()) {
    return pathStat.size;
  }
  if (!pathStat.isDirectory()) {
    return 0;
  }
  let total = 0;
  for (const entry of await readdir(path)) {
    total += await computeRecursiveSize(join(path, entry));
  }
  return total;
}

async function computeRecursiveContentFingerprint(path: string): Promise<string> {
  const pathStat = await lstat(path);
  const hash = createHash("sha256");
  if (pathStat.isFile()) {
    hash.update("file\0");
    hash.update(await readFile(path));
    return hash.digest("hex");
  }
  if (!pathStat.isDirectory()) {
    throw new Error(`unsupported plugin archive source: ${path}`);
  }
  hash.update("dir\0");
  const children = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const child of children) {
    hash.update(child.name);
    hash.update("\0");
    hash.update(await computeRecursiveContentFingerprint(join(path, child.name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function toSafeDirectoryName(value: string): string {
  const sanitized = value.trim().replace(/[\\/:]/gu, "-") || "plugin";
  try {
    return normalizePluginSyncRelativePath(sanitized);
  } catch {
    return `plugin-${createShortHash(value).slice(0, 8)}`;
  }
}

export function createShortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`invalid plugin id: ${pluginId}`);
  }
  return normalized;
}

function normalizeMarketplaceId(marketplaceId: string): string {
  return normalizePluginId(marketplaceId);
}

export function normalizePluginIdKey(pluginId: string): string {
  return normalizePluginId(pluginId).toLowerCase();
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing ${label}`);
  }
  return value.trim();
}

async function readJsonFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`invalid json object: ${filePath}`);
  }
  return parsed;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
