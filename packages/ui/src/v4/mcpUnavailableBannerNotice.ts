import type {
  ConversationRow,
  ConversationRowsPartition,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { OfficialMcpToolErrorCode } from "@zcode/shared";
import { memoizeByRows } from "@/v4/conversationProjectionStore.js";

/**
 * 官方 Server MCP 本次会话内被判定不可用的事实（额度耗尽 / 无 Coding Plan）。
 *
 * 事实来源是 tool row 上的 `display.unavailable`——CLI 侧只对官方 MCP 且 isError 的结果填充，
 * 因此这里不需要再判来源。
 */
export interface McpUnavailableNotice {
  code: OfficialMcpToolErrorCode;
  serverName: string;
  toolName: string;
  /** 去重用：同一次调用只提示一次，换一次新的失败调用会重新提示。 */
  rowId: number;
}

function toolKeyOf(display: { serverName: string; toolName: string }): string {
  return `${display.serverName}\u0000${display.toolName}`;
}

/** 每个工具的最新一条 MCP 调用，按位置从新到旧排列。 */
function latestMcpRowsPerTool(rows: readonly ConversationRow[]): ToolCallRow[] {
  const latest: ToolCallRow[] = [];
  const seenTools = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== "toolCall" || row.display?.kind !== "mcp_tool") continue;
    const toolKey = toolKeyOf(row.display);
    if (seenTools.has(toolKey)) continue;
    seenTools.add(toolKey);
    latest.push(row);
  }
  return latest;
}

const latestMcpRowsByRows = memoizeByRows(latestMcpRowsPerTool);

function toNotice(row: ToolCallRow): McpUnavailableNotice | null {
  const display = row.display;
  if (display?.kind !== "mcp_tool" || !display.unavailable) return null;
  return {
    code: display.unavailable.code,
    rowId: row.rowId,
    serverName: display.serverName,
    toolName: display.toolName,
  };
}

/**
 * 取窗口内最新一条带不可用标识的官方 MCP 工具调用；结果与对 history ++ tail 整窗倒序扫描相同。
 *
 * 取"最新"而不是"第一条"：同一会话里可能先撞额度、后换了连接又撞权益，提示要跟随最近事实。
 * 同一工具的最新成功事实覆盖旧失败，所以每个工具只看它最新的一条。
 * 注意 rows 是窗口视图，滚动很远后旧标识会离开窗口、提示随之消失——刚发生的调用一定在窗口内，
 * 这是可接受的取舍。
 *
 * Bug 根因：没有不可用标识时原实现要倒序扫完整窗，随每个流式帧执行，成本随历史线性增长。
 * 现在两段各取“每个工具的最新一条”（历史段按引用缓存）：尾段的行都比历史段新，所以先看尾段，
 * 再看历史段里尾段没出现过的工具，顺序与整窗倒序扫描一致。
 */
export function resolveMcpUnavailableNoticeInPartition(
  partition: ConversationRowsPartition | null,
): McpUnavailableNotice | null {
  if (!partition) return null;
  const history = latestMcpRowsByRows(partition.history);
  const tail = latestMcpRowsByRows(partition.tail);
  for (const row of tail) {
    const notice = toNotice(row);
    if (notice) return notice;
  }
  const tailTools = new Set(
    tail.flatMap((row) => (row.display?.kind === "mcp_tool" ? [toolKeyOf(row.display)] : [])),
  );
  for (const row of history) {
    if (row.display?.kind !== "mcp_tool" || tailTools.has(toolKeyOf(row.display))) continue;
    const notice = toNotice(row);
    if (notice) return notice;
  }
  return null;
}
