import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { createMcpNodeFallbackProvider, type McpNodeFallbackProvider } from "@zcode/adapters/mcp";
import { bundleBaseDirs } from "./bundled-plugins.js";

/** 随包 npm 相对 zcode.cjs 的位置；与 desktop prepare:agent-bundle 的 staging 目录同一约定。 */
const BUNDLED_NPM_RELATIVE_SEGMENTS = ["node-runtime", "npm"] as const;

export interface McpNodeFallbackRuntime {
  /** 入口文件目录、bundle 自身目录（按优先级）。 */
  baseDirs: readonly string[];
  /** `process.versions.electron`；undefined 表示 agent 不在 Electron Node 上运行。 */
  electronVersion: string | undefined;
  execPath: string;
}

export interface ResolveMcpNodeFallbackProviderOptions {
  cliStorageRoot: string;
  logger?: Logger;
  /** 测试注入；缺省读取当前进程。 */
  runtime?: McpNodeFallbackRuntime;
}

/**
 * 只有 agent 自己跑在 Electron Node（桌面）上时才提供 fallback：纯 Node CLI、SEA 与远端
 * 不需要它，远端沿用 prependRunningNodeDirectory。规格见 docs/design/v2/mcp-node-fallback.md。
 */
export function resolveMcpNodeFallbackProvider(
  options: ResolveMcpNodeFallbackProviderOptions,
): McpNodeFallbackProvider | undefined {
  const runtime = options.runtime ?? currentRuntime();
  if (!runtime.electronVersion) return undefined;
  return createMcpNodeFallbackProvider({
    execPath: runtime.execPath,
    logger: options.logger,
    npmRootCandidates: bundledNpmRootCandidates(runtime.baseDirs),
    storageRoot: options.cliStorageRoot,
  });
}

export function bundledNpmRootCandidates(baseDirs: readonly string[]): string[] {
  return [...new Set(baseDirs.map((dir) => join(dir, ...BUNDLED_NPM_RELATIVE_SEGMENTS)))];
}

function currentRuntime(): McpNodeFallbackRuntime {
  return {
    baseDirs: bundleBaseDirs(),
    electronVersion: process.versions.electron,
    execPath: process.execPath,
  };
}
