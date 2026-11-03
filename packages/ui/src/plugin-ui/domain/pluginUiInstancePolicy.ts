import type {
  ConversationRow,
  ConversationRowsPartition,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { resolvePluginUiLogicalScope } from "./pluginUiLogicalScope.js";

/** ：最近几个回合的插件卡片默认展开，更早的按默认收进折叠区。 */
export const PLUGIN_UI_AUTO_EXPAND_TURNS = 3;

/** 一个逻辑 UI：仅显式 surface 或权限范围一致的 widgetSessionId 共用，其余调用独立。 */
export interface PluginUiLogicalInstance {
  key: string;
  /** 当前显示的调用：最新一次成功（非 isError）的；没有成功的就是最新一条。 */
  activeToolCallId: string;
  /** 被较新成功结果替代的成功调用；它们不建沙箱，只保留普通工具记录。 */
  supersededToolCallIds: string[];
}

/** 单条插件工具行的展示裁决；渲染层据此决定进不进折叠区、要不要建沙箱。 */
export interface PluginUiRowDisposition {
  key: string;
  superseded: boolean;
  /** 所在回合在最近 PLUGIN_UI_AUTO_EXPAND_TURNS 个回合内。 */
  autoExpand: boolean;
  /** 工具级 `openai/widgetShowCodexWidgetInline`（display.ui.showInline）。 */
  forcedInline: boolean;
}

export interface PluginUiInstanceDerivation {
  instances: PluginUiLogicalInstance[];
  byToolCallId: Readonly<Record<string, PluginUiRowDisposition>>;
}

export const EMPTY_PLUGIN_UI_INSTANCE_DERIVATION: PluginUiInstanceDerivation = {
  instances: [],
  byToolCallId: {},
};

function isPluginUiToolRow(row: ConversationRow): row is ToolCallRow {
  return (
    row.kind === "toolCall" && row.display?.kind === "mcp_tool" && row.display.ui !== undefined
  );
}

function isSuccessfulUiRow(row: ToolCallRow): boolean {
  return (
    row.status === "success" &&
    !(row.display?.kind === "mcp_tool" && row.display.ui?.isError === true)
  );
}

/**
 * 纯函数：从投影行推导逻辑 UI 实例与每行的展示裁决（V-a）。
 * key 同时绑定来源、server、资源、权限与逻辑视图；同 key 内最新一次成功结果替代更早的成功结果，
 * running / failed / isError 的行既不替代别人也不被替代（各自显示自己的状态）。
 * autoExpand 按全部行的回合顺序取最近 N 个回合（回合里没有插件卡片也算一个回合）。
 */
export function deriveLogicalUiInstances(
  rows: readonly ConversationRow[],
  options: { autoExpandTurns?: number } = {},
): PluginUiInstanceDerivation {
  // domain 不用 Map / Set（模块边界约束），全部用数组与普通对象。
  const turnOrder: string[] = [];
  // 流式追加会重复推导整窗；数组 includes 查重会随历史回合数变成平方级开销。
  const seenTurns: Record<string, true | undefined> = Object.create(null);
  for (const row of rows) {
    if (!seenTurns[row.turnId]) {
      seenTurns[row.turnId] = true;
      turnOrder.push(row.turnId);
    }
  }
  const recentTurns = Object.fromEntries(
    turnOrder
      .slice(-(options.autoExpandTurns ?? PLUGIN_UI_AUTO_EXPAND_TURNS))
      .map((id) => [id, true]),
  );
  const groupKeys: string[] = [];
  const groups: Record<string, ToolCallRow[]> = {};
  for (const row of rows) {
    if (!isPluginUiToolRow(row)) continue;
    const display = row.display;
    if (display?.kind !== "mcp_tool" || !display.ui) continue;
    const logical = resolvePluginUiLogicalScope(display.ui, {
      kind: "toolCall",
      toolCallId: row.toolCallId,
    });
    const key = JSON.stringify([
      display.ui.pluginId,
      display.serverName,
      display.ui.resourceUri,
      logical,
    ]);
    const group = groups[key];
    if (group) group.push(row);
    else {
      groups[key] = [row];
      groupKeys.push(key);
    }
  }
  const instances: PluginUiLogicalInstance[] = [];
  const byToolCallId: Record<string, PluginUiRowDisposition> = {};
  for (const key of groupKeys) {
    const group = groups[key]!;
    const successes = group.filter(isSuccessfulUiRow);
    const active = successes.at(-1) ?? group.at(-1)!;
    const superseded = successes.filter((row) => row !== active).map((row) => row.toolCallId);
    const supersededById = Object.fromEntries(superseded.map((id) => [id, true]));
    instances.push({ key, activeToolCallId: active.toolCallId, supersededToolCallIds: superseded });
    for (const row of group) {
      byToolCallId[row.toolCallId] = {
        key,
        superseded: Object.hasOwn(supersededById, row.toolCallId),
        autoExpand: Object.hasOwn(recentTurns, row.turnId),
        forcedInline: row.display?.kind === "mcp_tool" && row.display.ui?.showInline === true,
      };
    }
  }
  return { instances, byToolCallId };
}

function sameRefs<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * deriveLogicalUiInstances 只读插件 UI 行和全部行的回合顺序。
 *
 * Bug 根因：时间线每帧对整个 rows 重新推导，长会话流式输出时成本随历史长度线性增长。
 * 调用方传入与 rows 对应的「历史 + 尾轮」分区（两段回合不相交，见
 * docs/ui/chat-virtual-scroll.md「每帧派生成本」）：历史段引用不变，且尾轮的回合序列与插件 UI
 * 行引用都不变时，推导输入完全相同，直接复用上一份结果；否则整窗重新推导。
 */
export function createLogicalUiInstancesSelector() {
  let previous: {
    history: readonly ConversationRow[];
    tailTurnIds: string[];
    tailUiRows: ToolCallRow[];
    result: PluginUiInstanceDerivation;
  } | null = null;
  return (
    rows: readonly ConversationRow[],
    partition: ConversationRowsPartition,
  ): PluginUiInstanceDerivation => {
    const tailTurnIds: string[] = [];
    const tailUiRows: ToolCallRow[] = [];
    for (const row of partition.tail) {
      if (!tailTurnIds.includes(row.turnId)) tailTurnIds.push(row.turnId);
      if (isPluginUiToolRow(row)) tailUiRows.push(row);
    }
    if (
      previous?.history === partition.history &&
      sameRefs(previous.tailTurnIds, tailTurnIds) &&
      sameRefs(previous.tailUiRows, tailUiRows)
    ) {
      return previous.result;
    }
    const result = deriveLogicalUiInstances(rows);
    previous = { history: partition.history, tailTurnIds, tailUiRows, result };
    return result;
  };
}
