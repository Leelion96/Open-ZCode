import {
  isToolSearchName,
  toolSearchNameForMode,
  TOOL_SEARCH_NAME,
  LOCAL_TOOL_SEARCH_NAME,
} from "@zcode/contracts";
import { renderToolSearchAnnouncement } from "./description.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type {
  CompactBoundaryPayload,
  ModelMessageContentBlock,
  ModelToolContract,
  ResolvedToolSearchMode,
} from "@zcode/contracts";
import {
  createLocalToolDefinitionRenderer,
  localToolsAlreadyLoadedReminder,
  localToolsLoadedReminder,
} from "./local-projection.js";

export function compactDiscoveryMetadata(
  boundary: Pick<CompactBoundaryPayload, "boundaryId" | "preCompactDiscoveredTools">,
) {
  return {
    boundaryId: boundary.boundaryId,
    preCompactDiscoveredTools: [...(boundary.preCompactDiscoveredTools ?? [])],
  };
}

export function collectToolSearchHistory(entries: readonly RuntimeMessageEntry[]) {
  const discovered = new Set<string>();
  const preCompactDiscoveredTools = new Set<string>();
  for (const entry of entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? []) {
      discovered.add(name);
      preCompactDiscoveredTools.add(name);
    }
    if (entry.kind === "attachment" || entry.message.role !== "tool" || entry.message.isError)
      continue;
    if (!Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_reference") discovered.add(block.toolName);
    }
  }
  return { discovered, preCompactDiscoveredTools };
}

export function collectDiscoveredTools(entries: readonly RuntimeMessageEntry[]): Set<string> {
  return collectToolSearchHistory(entries).discovered;
}

export function projectToolReferences(
  entries: readonly RuntimeMessageEntry[],
  mode: ResolvedToolSearchMode,
  tools: readonly ModelToolContract[],
  deferred: ReadonlySet<string> = new Set(),
): { entries: RuntimeMessageEntry[]; loadedToolCallIds: ReadonlySet<string> } {
  const catalog = mode === "off" ? undefined : new Map(tools.map((tool) => [tool.name, tool]));
  const searchName = toolSearchNameForMode(mode);
  const searchTool = catalog?.get(searchName);
  if (searchTool) {
    catalog!.set(TOOL_SEARCH_NAME, searchTool);
    catalog!.set(LOCAL_TOOL_SEARCH_NAME, searchTool);
  }
  const renderDefinition = mode === "local" ? createLocalToolDefinitionRenderer() : undefined;
  // 同批结果尚未被模型看到：直到下一条 assistant 才合入已交付集合，避免并行搜索互相去重。
  const visible = mode === "local" ? new Set<string>() : undefined;
  const pending = mode === "local" ? new Set<string>() : undefined;
  const projected: RuntimeMessageEntry[] = [];
  const loadedToolCallIds = new Set<string>();
  for (const originalEntry of entries) {
    let entry = originalEntry;
    if (pending && entry.kind !== "attachment" && entry.message.role === "assistant") {
      for (const name of pending) visible!.add(name);
      pending.clear();
    }
    if (mode === "off" && entry.metadata?.toolSearchAnnouncement) continue;
    // 同一会话可以切换模式；仅在请求副本中配对改名，不污染原始历史或正在发送的请求。
    if (mode !== "off") {
      if (entry.kind === "attachment") {
        if (entry.metadata?.toolSearchAnnouncement) {
          const content = renderToolSearchAnnouncement(
            entry.metadata.toolSearchAnnouncement,
            mode,
            entry.metadata.toolSearchHiddenNames,
          );
          if (content !== entry.content) entry = { ...entry, content };
        }
      } else {
        const message = entry.message;
        const renameResult = isToolSearchName(message.toolName) && message.toolName !== searchName;
        const renameCalls = message.toolCalls?.some(
          (call) => isToolSearchName(call.name) && call.name !== searchName,
        );
        if (renameResult || renameCalls)
          entry = {
            ...entry,
            message: {
              ...message,
              ...(renameResult ? { toolName: searchName } : {}),
              ...(renameCalls
                ? {
                    toolCalls: message.toolCalls!.map((call) =>
                      isToolSearchName(call.name) ? { ...call, name: searchName } : call,
                    ),
                  }
                : {}),
            },
          };
      }
    }
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      !Array.isArray(entry.message.content)
    ) {
      projected.push(entry);
      continue;
    }
    const original = entry.message.content;
    let content: ModelMessageContentBlock[] | undefined;
    let definitions: string[] | undefined;
    let alreadyLoaded: Set<string> | undefined;
    let newlyLoaded: Set<string> | undefined;
    const successfulSearch = isToolSearchName(entry.message.toolName) && !entry.message.isError;
    for (let index = 0; index < original.length; index++) {
      const block = original[index]!;
      if (block.type !== "tool_reference") {
        if (definitions) {
          content!.push(localDefinitionsBlock(definitions));
          definitions = undefined;
        }
        content?.push(block);
        continue;
      }
      const tool = catalog?.get(block.toolName);
      if (tool && !renderDefinition) {
        // 结果外的成功提示仅用于 Native；Local 已在结果内给出加载和调用指引。
        if (successfulSearch && entry.message.toolCallId)
          loadedToolCallIds.add(entry.message.toolCallId);
        if (tool.name !== block.toolName) {
          content ??= original.slice(0, index);
          content.push({ ...block, toolName: tool.name });
        } else content?.push(block);
        continue;
      }
      // 仅在引用确实被移除/展开时复制；普通结果与有效 Native 引用直接共享原历史。
      content ??= original.slice(0, index);
      if (tool && renderDefinition) {
        if (successfulSearch && deferred.has(tool.name) && visible!.has(tool.name)) {
          (alreadyLoaded ??= new Set()).add(tool.name);
        } else {
          (definitions ??= []).push(renderDefinition(tool));
          // 常驻及 compact 提升工具仍直接调用，不能混入包装调用的首搜指引。
          if (successfulSearch && deferred.has(tool.name))
            (newlyLoaded ??= new Set()).add(tool.name);
        }
        if (successfulSearch) pending!.add(tool.name);
      }
      // 被删除的引用不切断连续段，保持原来“先过滤再展开”的合并语义。
    }
    if (definitions) content!.push(localDefinitionsBlock(definitions));
    if (newlyLoaded)
      content!.push({ type: "text", text: localToolsLoadedReminder([...newlyLoaded]) });
    if (alreadyLoaded)
      content!.push({ type: "text", text: localToolsAlreadyLoadedReminder([...alreadyLoaded]) });
    projected.push(
      content === undefined
        ? entry
        : {
            ...entry,
            message: {
              ...entry.message,
              content: content.length
                ? content
                : [
                    {
                      type: "text",
                      text:
                        mode === "off"
                          ? "[Tool references removed - tool search not enabled]"
                          : "[Tool references removed - tools no longer available]",
                    },
                  ],
            },
          },
    );
  }
  return { entries: projected, loadedToolCallIds };
}

function localDefinitionsBlock(definitions: readonly string[]): ModelMessageContentBlock {
  return { type: "text", text: `<functions>\n${definitions.join("\n")}\n</functions>` };
}

/** 公告隐藏名称是宽松字段：冷恢复只保留公告 removedNames 里的字符串，其余忽略。 */
export function parseToolSearchHiddenNames(
  value: unknown,
  announcement: { removedNames: readonly string[] },
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const removed = new Set(announcement.removedNames);
  const names = value.filter(
    (name): name is string => typeof name === "string" && removed.has(name),
  );
  return names.length ? names : undefined;
}
