import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
  PluginDiagnostic,
  PluginManifest,
} from "@zcode/contracts";
import { directoryExists, isRecord, resolveInside } from "./helpers.js";
import { listPluginHookEventNames } from "./hook-sources.js";
import { readMarkdownFrontmatter } from "./markdown-frontmatter.js";
import { loadPluginMcpServerDefinitions } from "./mcp.js";
import { scanSkillFilesUnderRootSync } from "../skills/scan.js";
import type { LoadedPlugin } from "./types.js";

// 组件分组类型定义已上移到 @zcode/contracts（PluginMetadata 需要引用），这里再导出保持对外契约稳定。
export type { PluginComponentGroup, PluginComponentItem, PluginComponentKind };

/**
 * 在已解析的插件根目录上枚举各类组件的名称与描述。纯文件读取，跨平台只用 node:path/fs。
 * manifest 由调用方读取后传入（可为 null）；缺失目录或无 frontmatter 时跳过或省略描述，
 * 不因单个组件异常阻断整体枚举。
 */
export function enumeratePluginComponents(
  rootPath: string,
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin } = {},
): PluginComponentGroup[] {
  const groups: PluginComponentGroup[] = [];
  const agentItems = collectMarkdownComponents(rootPath, manifest?.agents, "agents");
  if (agentItems.length > 0) groups.push({ kind: "agent", items: agentItems });

  const commandItems = collectMarkdownComponents(rootPath, manifest?.commands, "commands");
  if (commandItems.length > 0) groups.push({ kind: "command", items: commandItems });

  // 信任边界：组件枚举的 rootPath 就是插件根，扫描无条件不跟随符号链接——
  // 不依赖 loaded 是否凑齐（manifest 解析失败的 marketplace describe 链路同样生效）。
  const skillItems = collectSkillComponents(rootPath, manifest?.skills);
  if (skillItems.length > 0) groups.push({ kind: "skill", items: skillItems });

  const hookItems = collectHookComponents(manifest, options);
  if (hookItems.length > 0) groups.push({ kind: "hook", items: hookItems });

  const mcpItems = collectMcpComponents(manifest, options);
  if (mcpItems.length > 0) groups.push({ kind: "mcp", items: mcpItems });

  return groups;
}

/** command/agent：默认目录 + manifest 声明的额外路径下的 .md 文件，读 frontmatter name/description。 */
function collectMarkdownComponents(
  rootPath: string,
  manifestField: unknown,
  defaultDir: "commands" | "agents",
): PluginComponentItem[] {
  const items: PluginComponentItem[] = [];
  const seen = new Set<string>();

  // object 形式声明（{ name: { source|content, description } }）直接取声明的描述。
  if (isRecord(manifestField)) {
    for (const [rawName, rawMeta] of Object.entries(manifestField)) {
      const name = rawName.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const description =
        isRecord(rawMeta) && typeof rawMeta.description === "string"
          ? rawMeta.description.trim()
          : undefined;
      items.push(description ? { name, description } : { name });
    }
  }

  const dirs = collectComponentDirs(rootPath, manifestField, defaultDir);
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".md"))
        .map((dirent) => dirent.name);
    } catch {
      continue;
    }
    for (const fileName of entries) {
      const baseName = fileName.slice(0, -".md".length);
      const path = join(dir, fileName);
      const fm = readMarkdownFrontmatter(path);
      const name = fm.name ?? baseName;
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({
        name,
        ...(fm.description ? { description: fm.description } : {}),
        ...(defaultDir === "agents" ? { path } : {}),
      });
    }
  }
  return items;
}

/**
 * skill：默认 skills 目录与 manifest 声明路径下枚举技能，读取 SKILL.md frontmatter。
 * 根自身含 SKILL.md 时根自身是一个技能；按文件路径和最终 name 去重，避免声明根与默认根
 * 重复计数，也避免不同路径下同名技能造成展示结果漂移。
 */
function collectSkillComponents(rootPath: string, manifestField: unknown): PluginComponentItem[] {
  const items: PluginComponentItem[] = [];
  const seenFiles = new Set<string>();
  const seenNames = new Set<string>();
  const dirs = collectComponentDirs(rootPath, manifestField, "skills");
  for (const dir of dirs) {
    let skillFiles: string[];
    try {
      skillFiles = scanSkillFilesUnderRootSync(dir, { followSymbolicLinks: false });
    } catch {
      continue;
    }
    for (const skillFile of skillFiles) {
      if (seenFiles.has(skillFile)) continue;
      seenFiles.add(skillFile);
      const fallbackName = basename(dirname(skillFile));
      const fm = readMarkdownFrontmatter(skillFile);
      const name = fm.name ?? fallbackName;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      items.push(fm.description ? { name, description: fm.description } : { name });
    }
  }
  return items;
}

/** hook：复用 loader 的来源发现规则，但只取事件名用于详情展示，不构造可执行 hook。 */
function collectHookComponents(
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin },
): PluginComponentItem[] {
  if (options.loaded) {
    return listPluginHookEventNames({
      diagnostics: options.diagnostics ?? [],
      loaded: options.loaded,
    }).map((name) => ({ name }));
  }
  if (!manifest) return [];
  return collectInlineHookEvents(manifest.hooks).map((name) => ({ name }));
}

/** mcp：复用 loader 读取 `.mcp.json` + `manifest.mcpServers` 的纯读解析，只展示原始 server 名。 */
function collectMcpComponents(
  manifest: PluginManifest | null,
  options: { diagnostics?: PluginDiagnostic[]; loaded?: LoadedPlugin },
): PluginComponentItem[] {
  if (options.loaded) {
    return Object.keys(
      loadPluginMcpServerDefinitions({
        diagnostics: options.diagnostics ?? [],
        loaded: options.loaded,
      }),
    )
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({ name }));
  }
  if (!manifest || !isRecord(manifest.mcpServers)) return [];
  return Object.keys(manifest.mcpServers)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name }));
}

function collectInlineHookEvents(value: unknown): string[] {
  const hooksField =
    isRecord(value) && isRecord((value as Record<string, unknown>).hooks)
      ? ((value as Record<string, unknown>).hooks as Record<string, unknown>)
      : value;
  if (!isRecord(hooksField)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const event of Object.keys(hooksField)) {
    const name = event.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 默认目录约定 + manifest 字符串/数组路径声明，合并成去重的待扫描目录列表。 */
function collectComponentDirs(
  rootPath: string,
  manifestField: unknown,
  defaultDir: string,
): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const resolvedPath = resolveInside(rootPath, raw.replace(/^\.\//, ""));
    if (!resolvedPath || seen.has(resolvedPath)) return;
    seen.add(resolvedPath);
    dirs.push(resolvedPath);
  };
  const defaultPath = join(rootPath, defaultDir);
  if (directoryExists(defaultPath)) add(defaultDir);
  if (typeof manifestField === "string") add(manifestField);
  else if (Array.isArray(manifestField)) {
    for (const value of manifestField) if (typeof value === "string") add(value);
  }
  return dirs;
}
