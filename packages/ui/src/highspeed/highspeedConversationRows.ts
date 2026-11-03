import type {
  ConversationRow,
  ConversationRowsPartition,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { memoizeByRows } from "@/v4/conversationProjectionStore.js";

function sortedHighspeedExpiries(rows: readonly ConversationRow[]): number[] {
  return rows
    .flatMap((row) => (row.kind === "userInput" && row.highspeed ? [row.highspeed.expiresAt] : []))
    .sort((left, right) => left - right);
}

function firstExpiryAfter(expiries: readonly number[], nowMs: number): number | undefined {
  let low = 0;
  let high = expiries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (expiries[middle]! <= nowMs) low = middle + 1;
    else high = middle;
  }
  return expiries[low];
}

// 协议行不可变，同一个行数组的到期时间集合不会变，升序缓存后按时钟二分即可。
const highspeedExpiriesByRows = memoizeByRows(sortedHighspeedExpiries);

/**
 * 下一个晚于 nowMs 的 Highspeed 卡到期时间，结果与在 history ++ tail 上逐行求最小值相同。
 * Bug 根因：时间线每帧扫描全部 rows 找下一个到期边界，长会话流式输出时成本随历史线性增长；
 * 历史段的到期时间按引用缓存后，每帧只处理尾轮。
 */
export function resolveNextHighspeedExpiryMsInPartition(
  partition: ConversationRowsPartition,
  nowMs: number,
): number | undefined {
  const fromHistory = firstExpiryAfter(highspeedExpiriesByRows(partition.history), nowMs);
  const fromTail = firstExpiryAfter(highspeedExpiriesByRows(partition.tail), nowMs);
  if (fromHistory === undefined) return fromTail;
  return fromTail === undefined ? fromHistory : Math.min(fromHistory, fromTail);
}

/** 带 highspeed 元数据与 sourceCommandId 的 userInput 行；只有这类行会被统计与回退提示采用。 */
export type HighspeedInputRow = UserInputRow & {
  sourceCommandId: string;
  highspeed: NonNullable<UserInputRow["highspeed"]>;
};

interface HighspeedRowsIndex {
  /** 保持 rows 顺序。 */
  inputs: HighspeedInputRow[];
  firstInputByCommandId: Map<string, UserInputRow>;
  firstHeaderByCommandId: Map<string, TurnHeaderRow>;
}

function isHighspeedInputRow(row: UserInputRow): row is HighspeedInputRow {
  return Boolean(row.sourceCommandId && row.highspeed);
}

function buildHighspeedRowsIndex(rows: readonly ConversationRow[]): HighspeedRowsIndex {
  const index: HighspeedRowsIndex = {
    inputs: [],
    firstInputByCommandId: new Map(),
    firstHeaderByCommandId: new Map(),
  };
  for (const row of rows) {
    if (row.kind === "userInput" && row.sourceCommandId) {
      if (isHighspeedInputRow(row)) index.inputs.push(row);
      if (!index.firstInputByCommandId.has(row.sourceCommandId)) {
        index.firstInputByCommandId.set(row.sourceCommandId, row);
      }
    } else if (
      row.kind === "turnHeader" &&
      row.sourceCommandId &&
      !index.firstHeaderByCommandId.has(row.sourceCommandId)
    ) {
      index.firstHeaderByCommandId.set(row.sourceCommandId, row);
    }
  }
  return index;
}

const highspeedIndexByRows = memoizeByRows(buildHighspeedRowsIndex);

/**
 * Highspeed 统计相关的 rows 查询，与在 history ++ tail 上逐行扫描结果相同。
 * Bug 根因：SessionPane 的 highspeed effect 随每个流式帧触发，原先每次都逐行过滤全部历史，
 * 每个待统计记录再各做两次整窗 find。历史段索引按引用缓存后，每帧只扫描尾轮。
 */
export function listHighspeedInputRows(
  partition: ConversationRowsPartition,
): readonly HighspeedInputRow[] {
  const history = highspeedIndexByRows(partition.history);
  const tail = highspeedIndexByRows(partition.tail);
  if (tail.inputs.length === 0) return history.inputs;
  return history.inputs.length === 0 ? tail.inputs : [...history.inputs, ...tail.inputs];
}

/** 等价于 rows.find(userInput && sourceCommandId === id)。 */
export function findUserInputBySourceCommandId(
  partition: ConversationRowsPartition,
  sourceCommandId: string,
): UserInputRow | undefined {
  const history = highspeedIndexByRows(partition.history);
  const tail = highspeedIndexByRows(partition.tail);
  return (
    history.firstInputByCommandId.get(sourceCommandId) ??
    tail.firstInputByCommandId.get(sourceCommandId)
  );
}

/** 等价于 rows.find(turnHeader && sourceCommandId === id)。 */
export function findTurnHeaderBySourceCommandId(
  partition: ConversationRowsPartition,
  sourceCommandId: string,
): TurnHeaderRow | undefined {
  const history = highspeedIndexByRows(partition.history);
  const tail = highspeedIndexByRows(partition.tail);
  return (
    history.firstHeaderByCommandId.get(sourceCommandId) ??
    tail.firstHeaderByCommandId.get(sourceCommandId)
  );
}
