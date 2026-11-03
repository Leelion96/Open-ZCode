import { LOCAL_TOOL_SEARCH_DESCRIPTION, renderToolSearchAnnouncement } from "./description.js";
import {
  TOOL_SEARCH_NAME,
  LOCAL_TOOL_SEARCH_NAME,
  DEFERRED_TOOL_CALL_NAME,
  type ToolSearchMode,
  type ResolvedToolSearchMode,
  type Model,
  type ModelToolContract,
  type ToolSearchCandidate,
  type ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { ToolRegistry } from "../registry.js";
import type { ToolMetadata } from "../types.js";
import type { RuntimeAttachmentEntry, RuntimeMessageEntry } from "../../agent/message-history.js";
import { collectToolSearchHistory, projectToolReferences } from "./history.js";

export function resolveToolSearchMode(
  model: Model,
  mode: ToolSearchMode = "off",
): ResolvedToolSearchMode {
  const capability = model.requestCapabilities?.toolSearch;
  if (mode === "off") return "off";
  if (mode === "native") {
    if (!capability?.protocolSupported)
      throw new Error("--toolsearch-mode native requires an Anthropic Messages provider.");
    return "native";
  }
  if (mode === "auto" && capability?.protocolSupported && capability.defaultEnabled)
    return "native";
  if (model.properties.supportsToolCall) return "local";
  if (mode === "local")
    throw new Error("--toolsearch-mode local requires a provider that supports tool calls.");
  return "off";
}

export function isDeferredTool(tool: ModelToolContract, metadata?: ToolMetadata): boolean {
  return (
    tool.name !== TOOL_SEARCH_NAME &&
    tool.name !== DEFERRED_TOOL_CALL_NAME &&
    !tool.providerNative &&
    metadata?.alwaysLoad !== true &&
    (metadata?.shouldDefer === true || metadata?.mcpPresentation !== undefined)
  );
}

interface ToolExposureInput {
  model: Model;
  mode?: ToolSearchMode;
  tools: readonly ModelToolContract[];
  registry?: Pick<ToolRegistry, "get">;
  entries: readonly RuntimeMessageEntry[];
}

function resolveToolSearchCatalog(
  input: ToolExposureInput,
  preCompactDiscoveredTools: ReadonlySet<string>,
) {
  const requestedMode = resolveToolSearchMode(input.model, input.mode);
  let hasConfiguredDeferred = false;
  const catalog: ToolSearchCandidate[] = input.tools
    .filter((tool) => requestedMode === "local" || tool.name !== DEFERRED_TOOL_CALL_NAME)
    .map((tool) => {
      const entry = input.registry?.get(tool.name);
      const metadata = entry?.metadata;
      const configuredDeferred = isDeferredTool(tool, metadata);
      hasConfiguredDeferred ||= configuredDeferred;
      return {
        name: tool.name,
        aliases: entry?.aliases,
        description: tool.description,
        searchHint: metadata?.searchHint,
        mcp: metadata?.mcpPresentation,
        deferred:
          configuredDeferred &&
          !(requestedMode === "local" && preCompactDiscoveredTools.has(tool.name)),
      };
    });
  const deferred = new Set(catalog.filter((tool) => tool.deferred).map((tool) => tool.name));
  const controlsAvailable =
    catalog.some((tool) => tool.name === TOOL_SEARCH_NAME) &&
    (requestedMode !== "local" || catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME));
  // 全部提升后仍需要控制入口处理后续目录变化，不能用剩余 deferred 数量关闭 Local。
  const enabled = requestedMode !== "off" && hasConfiguredDeferred && controlsAvailable;
  const mode: ResolvedToolSearchMode = enabled ? requestedMode : "off";
  return {
    catalog,
    deferred,
    enabled,
    mode,
    reason: enabled
      ? mode
      : requestedMode === "off"
        ? "provider_disabled"
        : !hasConfiguredDeferred
          ? "no_deferred_tools"
          : "tool_unavailable",
  };
}

export function buildToolExposure(input: ToolExposureInput) {
  const { discovered, preCompactDiscoveredTools } = collectToolSearchHistory(input.entries);
  const { catalog, deferred, enabled, mode, reason } = resolveToolSearchCatalog(
    input,
    preCompactDiscoveredTools,
  );
  const tools = input.tools
    .filter((tool) => {
      if (tool.name === TOOL_SEARCH_NAME) return enabled;
      if (tool.name === DEFERRED_TOOL_CALL_NAME) return mode === "local";
      return (
        mode === "off" ||
        !deferred.has(tool.name) ||
        (mode === "native" && discovered.has(tool.name))
      );
    })
    .map((tool) => {
      const { deferLoading: _previous, ...contract } = tool;
      if (mode === "local" && tool.name === TOOL_SEARCH_NAME)
        return {
          ...contract,
          name: LOCAL_TOOL_SEARCH_NAME,
          description: LOCAL_TOOL_SEARCH_DESCRIPTION,
        };
      return mode === "native" && deferred.has(tool.name)
        ? { ...contract, deferLoading: true }
        : contract;
    });
  // Local 使用完整目录，且常驻控制工具以实际发送的定义覆盖原文案。
  const projection = projectToolReferences(
    input.entries,
    mode,
    mode === "local" ? [...input.tools, ...tools] : tools,
    deferred,
  );
  const context: ToolSearchExecutionContext = { enabled, mode, catalog, discovered };
  return { tools, ...projection, enabled, context, reason };
}

// Bug 根因：请求投影中生成的公告晚于续写快照，恢复快照后会反复生成并累积到主历史。
// 公告只由正常提醒收集和 compact 重建调用，提交历史后才生成请求快照。
export function buildToolSearchAnnouncement(
  input: ToolExposureInput,
  compactDiscoveredTools?: ReadonlySet<string>,
): RuntimeAttachmentEntry | undefined {
  // Off 不需要公告或提升信息，保持关闭路径不扫描公告历史。
  if (resolveToolSearchMode(input.model, input.mode) === "off") return undefined;
  // Bug 根因：全量 metadata 与增量正文不一致，compact 保留尾部时会误以为旧名称仍在上下文。
  // 只从保留的公告事实恢复状态；恢复提示不算完整列名，原始列名被压缩后仍需补齐。
  const announced = new Set<string>();
  const listed = new Set<string>();
  const preCompactDiscoveredTools = new Set(compactDiscoveredTools);
  for (const entry of input.entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? [])
      preCompactDiscoveredTools.add(name);
    const delta = entry.metadata?.toolSearchAnnouncement;
    if (!delta) continue;
    const readded = new Set(delta.readdedNames);
    for (const name of delta.addedNames) {
      announced.add(name);
      if (!readded.has(name)) listed.add(name);
    }
    for (const name of delta.removedNames) announced.delete(name);
  }
  const { enabled, deferred, mode } = resolveToolSearchCatalog(input, preCompactDiscoveredTools);
  if (!enabled) return undefined;
  const names = [...deferred].sort();
  const addedNames = names.filter((name) => !announced.has(name) || !listed.has(name));
  const readdedNames = names.filter((name) => !announced.has(name) && listed.has(name));
  // deferred 转 alwaysLoad 后工具仍然可用，删除必须对照完整的当前作用域目录。
  const available = new Set(input.tools.map((tool) => tool.name));
  const removedNames = [...announced].filter((name) => !available.has(name)).sort();
  if (addedNames.length === 0 && removedNames.length === 0) return undefined;
  // 只能在生成时判断哪些删除只是本轮隐藏：之后 registry 会变，请求投影按记下的名称渲染。
  const hiddenNames = removedNames.filter((name) => input.registry?.get(name) !== undefined);
  const delta = { addedNames, removedNames, readdedNames };
  return {
    kind: "attachment",
    content: renderToolSearchAnnouncement(delta, mode, hiddenNames),
    metadata: {
      source: "tool_search_announcement",
      toolSearchAnnouncement: delta,
      ...(hiddenNames.length ? { toolSearchHiddenNames: hiddenNames } : {}),
    },
  };
}
