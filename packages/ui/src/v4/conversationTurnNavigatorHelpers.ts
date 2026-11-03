import {
  sameItems,
  type ConversationTurnRenderUnit,
  type ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";

export type ConversationTurnNavigatorAssistantPreviewKind = "empty" | "running" | "text";

export interface ConversationTurnNavigatorItem {
  key: string;
  turnId: string;
  unitIndex: number;
  rowId: number;
  userPreview: string;
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
  isRunning: boolean;
}

export interface BuildConversationTurnNavigatorItemsOptions {
  assistantEmptyPreview: string;
  assistantRunningPreview: string;
  userFallbackPreview: string;
  maxPreviewChars?: number;
  maxPreviewParagraphs?: number;
}

export interface ConversationTurnNavigatorVirtualItem {
  index: number;
  start: number;
  size: number;
}

export interface ResolveConversationTurnNavigatorActiveUnitIndexOptions {
  items: readonly ConversationTurnNavigatorItem[];
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export interface ConversationTurnNavigatorQueryPosition {
  rowId: number;
  start: number;
  end: number;
}

export interface ResolveConversationTurnNavigatorActiveQueryRowIdOptions {
  positions: readonly ConversationTurnNavigatorQueryPosition[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
}

export type ConversationTurnNavigatorBarTone = "idle" | "mid" | "near" | "peak";
export type ConversationTurnNavigatorBarColorTone = "focus" | "muted";

export interface ConversationTurnNavigatorBarVisualState {
  colorTone: ConversationTurnNavigatorBarColorTone;
  opacity: number;
  scaleX: number;
  tone: ConversationTurnNavigatorBarTone;
}

export interface ResolveConversationTurnNavigatorBarVisualStateOptions {
  itemIndex: number;
  visualFocusItemIndex: number | undefined;
}

export interface ResolveConversationTurnNavigatorVisualFocusItemIndexOptions {
  activeItemIndex: number;
  interactionItemIndex: number | undefined;
}

export const CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX = 864;

function collectRealUserQueryRowIds(units: readonly ConversationTurnRenderUnit[]): number[] {
  const rowIds: number[] = [];
  for (const unit of units) {
    for (const row of unit.visibleUserInputs) {
      if (row.origin === "realUser") rowIds.push(row.rowId);
    }
  }
  return rowIds;
}

/**
 * 目录成员未变时保持身份；正文 token/时钟不能让 DOM 锚点登记跟着全量重建。
 * 输入按「历史 + 尾轮」分区（docs/ui/chat-virtual-scroll.md「每帧派生成本」）：历史段引用不变且
 * 尾轮成员不变时直接复用，流式帧只收集尾轮；历史段变化时才整窗比较成员。
 */
export function createConversationTurnNavigatorQueryRowIdsSelector() {
  let previous: ReadonlySet<number> = new Set<number>();
  let previousHistory: readonly ConversationTurnRenderUnit[] | null = null;
  let previousTailRowIds: number[] = [];
  return (units: ConversationTurnRenderUnitsPartition): ReadonlySet<number> => {
    const tailRowIds = collectRealUserQueryRowIds(units.tail);
    if (previousHistory === units.history && sameItems(previousTailRowIds, tailRowIds)) {
      return previous;
    }
    previousHistory = units.history;
    previousTailRowIds = tailRowIds;
    const next = new Set([...collectRealUserQueryRowIds(units.history), ...tailRowIds]);
    if (next.size !== previous.size || [...next].some((rowId) => !previous.has(rowId))) {
      previous = next;
    }
    return previous;
  };
}

export type ConversationTurnNavigatorHydrationResult =
  | { status: "hydrated"; logEpoch: string }
  | { status: "not-enough-queries"; logEpoch: string }
  | { status: "retryable-failure"; logEpoch: string }
  | { status: "stale"; logEpoch: string };

export function shouldHydrateConversationTurnNavigatorDirectory(params: {
  canLoadOlder: boolean;
  containerWidthPx: number;
  hasLoadHandler: boolean;
  loadingOlder: boolean;
}): boolean {
  return (
    params.canLoadOlder &&
    !params.loadingOlder &&
    params.hasLoadHandler &&
    params.containerWidthPx >= CONVERSATION_TURN_NAVIGATOR_MIN_WIDTH_PX
  );
}

export function resolveConversationTurnNavigatorHydrationRetryDelayMs(
  failedAttemptCount: number,
): number | null {
  if (failedAttemptCount === 1) return 250;
  if (failedAttemptCount === 2) return 1_000;
  return null;
}

const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;

function truncatePreview(text: string, maxChars: number): string {
  const normalizedMaxChars = Math.max(8, maxChars);
  if (text.length <= normalizedMaxChars) {
    return text;
  }
  return `${text.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
}

function buildPreviewText({
  texts,
  fallback,
  maxPreviewChars,
  maxPreviewParagraphs,
}: {
  texts: readonly string[];
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}): string {
  const maxChars = Math.max(8, maxPreviewChars);
  const maxParagraphs = Math.trunc(Math.max(1, maxPreviewParagraphs));
  let preview = "";
  let paragraphs = 1;
  let whitespace = false;
  let newlines = 0;
  // 旧实现先拼接并正则处理整份正文，最后才截断；每个流式 delta 都会重扫长历史。
  // 多读一个有效字符即可判断是否省略，保留原来的空白、空行分段及 UTF-16 截断语义。
  for (const text of texts) {
    if (preview) {
      whitespace = true;
      newlines = 2;
    }
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]!;
      if (/\s/u.test(character)) {
        whitespace = true;
        if (character === "\n") newlines += 1;
        continue;
      }
      if (whitespace && preview) {
        if (newlines >= 2) {
          if (paragraphs >= maxParagraphs) return truncatePreview(preview, maxChars);
          paragraphs += 1;
          preview += "\n";
        } else {
          preview += " ";
        }
      }
      preview += character;
      whitespace = false;
      newlines = 0;
      if (preview.length > maxChars) return truncatePreview(preview, maxChars);
    }
  }
  return preview || fallback;
}

function buildAssistantPreview(
  unit: ConversationTurnRenderUnit,
  options: Required<BuildConversationTurnNavigatorItemsOptions>,
): {
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
} {
  if (unit.assistantTextRows.length > 0) {
    return {
      assistantPreview: buildPreviewText({
        texts: unit.assistantTextRows.map((row) => row.text),
        fallback: options.assistantEmptyPreview,
        maxPreviewChars: options.maxPreviewChars,
        maxPreviewParagraphs: options.maxPreviewParagraphs,
      }),
      assistantPreviewKind: "text",
    };
  }

  if (unit.isRunning) {
    return {
      assistantPreview: options.assistantRunningPreview,
      assistantPreviewKind: "running",
    };
  }

  return {
    assistantPreview: options.assistantEmptyPreview,
    assistantPreviewKind: "empty",
  };
}

export function buildConversationTurnNavigatorItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
): ConversationTurnNavigatorItem[] {
  const resolvedOptions: Required<BuildConversationTurnNavigatorItemsOptions> = {
    ...options,
    maxPreviewChars: options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs: options.maxPreviewParagraphs ?? DEFAULT_MAX_PREVIEW_PARAGRAPHS,
  };

  return units.flatMap((unit, unitIndex) => {
    // provider/store 的物理 role=user 还包含 background/goal/mailbox
    // 等系统上下文；目录代表用户主动 query，只能使用投影明确裁决的 realUser。
    const realUserInputs = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
    if (unit.timelineOnly || realUserInputs.length === 0) {
      return [];
    }

    // 导航项按 query 拆分，但 hover 的 assistant 摘要保持旧产品语义：
    // 取所属 product turn 的文本结果，不在 renderer 猜测 guide 回复分段。
    const { assistantPreview, assistantPreviewKind } = buildAssistantPreview(unit, resolvedOptions);
    return realUserInputs.map((row, queryIndex) => ({
      // 不能以 product turn 为目录粒度，并把同一 turn 的 steer query
      // 全部拼进一个 preview。目录真正导航的是用户可见 query，必须用稳定 row
      // 身份逐条建项，turnId 只负责把虚拟列表先定位到所属容器。
      key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
      turnId: unit.turnId,
      unitIndex,
      rowId: row.rowId,
      userPreview: buildPreviewText({
        texts: [row.text],
        fallback: resolvedOptions.userFallbackPreview,
        maxPreviewChars: resolvedOptions.maxPreviewChars,
        maxPreviewParagraphs: resolvedOptions.maxPreviewParagraphs,
      }),
      assistantPreview,
      assistantPreviewKind,
      // 同一 running product turn 可能已有多个已结束 guide segment；只有最后一条
      // query 仍代表当前工作，避免所有旧 query 一起呈现 running 强调。
      isRunning: unit.isRunning && queryIndex === realUserInputs.length - 1,
    }));
  });
}

/**
 * 缓存只覆盖当前目录；未变历史轮不应因尾轮 token 或时钟重新扫描正文。
 * 输入按「历史 + 尾轮」分区：历史段条目按 history 引用缓存，每帧只为尾轮重建条目，
 * 尾轮条目值未变时直接返回上一份目录（预览最多 220 字，超过后流式正文不再改变条目）。
 */
export function createConversationTurnNavigatorItemsSelector() {
  type UnitCache = Map<
    string,
    { unit: ConversationTurnRenderUnit; index: number; items: ConversationTurnNavigatorItem[] }
  >;
  let historyCache: UnitCache = new Map();
  let tailCache: UnitCache = new Map();
  let previousOptions: BuildConversationTurnNavigatorItemsOptions | undefined;
  let history: {
    units: readonly ConversationTurnRenderUnit[];
    items: ConversationTurnNavigatorItem[];
  } | null = null;
  let previousTailItems: ConversationTurnNavigatorItem[] = [];
  let previousItems: ConversationTurnNavigatorItem[] = [];

  const selectUnitItems = (
    units: readonly ConversationTurnRenderUnit[],
    indexOffset: number,
    options: BuildConversationTurnNavigatorItemsOptions,
    lookup: (key: string) => ReturnType<UnitCache["get"]>,
    next: UnitCache,
  ) =>
    units.flatMap((unit, offset) => {
      const index = indexOffset + offset;
      const cached = lookup(unit.key);
      if (cached?.unit === unit && cached.index === index) {
        next.set(unit.key, cached);
        return cached.items;
      }
      const built = buildConversationTurnNavigatorItems([unit], options).map((item) => ({
        ...item,
        unitIndex: index,
      }));
      // running 时钟或不可见正文尾部变化，未必改变目录实际展示值。
      const stable = built.map((item, i) => {
        const old = cached?.items[i];
        return old &&
          Object.keys(item).every(
            (key) => item[key as keyof typeof item] === old[key as keyof typeof item],
          )
          ? old
          : item;
      });
      next.set(unit.key, { unit, index, items: stable });
      return stable;
    });

  return (
    units: ConversationTurnRenderUnitsPartition,
    options: BuildConversationTurnNavigatorItemsOptions,
  ) => {
    if (
      !previousOptions ||
      Object.keys({ ...previousOptions, ...options }).some(
        (key) =>
          options[key as keyof typeof options] !== previousOptions?.[key as keyof typeof options],
      )
    ) {
      historyCache.clear();
      tailCache.clear();
      history = null;
    }
    previousOptions = options;
    const previousHistoryCache = historyCache;
    const previousTailCache = tailCache;
    let historyChanged = false;
    if (history?.units !== units.history) {
      historyCache = new Map();
      history = {
        units: units.history,
        items: selectUnitItems(
          units.history,
          0,
          options,
          (key) => previousHistoryCache.get(key) ?? previousTailCache.get(key),
          historyCache,
        ),
      };
      historyChanged = true;
    }
    tailCache = new Map();
    const tailItems = selectUnitItems(
      units.tail,
      units.history.length,
      options,
      (key) => previousTailCache.get(key) ?? previousHistoryCache.get(key),
      tailCache,
    );
    if (!historyChanged && sameItems(tailItems, previousTailItems)) {
      return previousItems;
    }
    previousTailItems = tailItems;
    const items = [...history.items, ...tailItems];
    if (sameItems(items, previousItems)) return previousItems;
    previousItems = items;
    return items;
  };
}

function resolveFiniteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolveConversationTurnNavigatorActiveUnitIndex({
  items,
  virtualItems,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveUnitIndexOptions): number | undefined {
  if (items.length === 0) {
    return undefined;
  }

  // items 由 renderUnits 顺序生成（同轮可有多个 query）。滚动只查少量可见轮，
  // 二分已有顺序即可，不能每个像素滚动都为完整目录重新分配 Map。
  const lowerBound = (unitIndex: number) => {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (items[middle]!.unitIndex < unitIndex) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));

  let activeUnitIndex: number | undefined;
  let activeDistance = Number.POSITIVE_INFINITY;
  for (const virtualItem of virtualItems) {
    const item = items[lowerBound(virtualItem.index)];
    if (item?.unitIndex !== virtualItem.index) {
      continue;
    }
    const rowStart = resolveFiniteNonNegative(virtualItem.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(virtualItem.size));
    if (rowEnd < viewportStart || rowStart > viewportEnd) {
      continue;
    }
    const distanceToViewportStart = rowStart <= viewportStart ? 0 : rowStart - viewportStart;
    if (distanceToViewportStart < activeDistance) {
      activeUnitIndex = item.unitIndex;
      activeDistance = distanceToViewportStart;
    }
  }

  if (activeUnitIndex !== undefined) {
    return activeUnitIndex;
  }

  const topVirtualIndex = virtualItems.find((item) => {
    const rowStart = resolveFiniteNonNegative(item.start);
    const rowEnd = rowStart + Math.max(1, resolveFiniteNonNegative(item.size));
    return rowEnd >= viewportStart && rowStart <= viewportEnd;
  })?.index;
  if (topVirtualIndex === undefined) {
    return items[0]?.unitIndex;
  }

  return (
    items[lowerBound(topVirtualIndex)]?.unitIndex ?? items.at(-1)?.unitIndex ?? items[0]?.unitIndex
  );
}

export function resolveConversationTurnNavigatorActiveQueryRowId({
  positions,
  scrollOffsetPx,
  viewportHeightPx,
}: ResolveConversationTurnNavigatorActiveQueryRowIdOptions): number | undefined {
  if (positions.length === 0) return undefined;

  const viewportStart = resolveFiniteNonNegative(scrollOffsetPx);
  const viewportEnd = viewportStart + Math.max(1, resolveFiniteNonNegative(viewportHeightPx));
  let nearest: ConversationTurnNavigatorQueryPosition | undefined;
  let distance = Number.POSITIVE_INFINITY;
  let before: ConversationTurnNavigatorQueryPosition | undefined;
  let after: ConversationTurnNavigatorQueryPosition | undefined;
  // 保留原先按 start/rowId 排序后的距离与平局规则；无需每次 scroll 分配、排序三份数组。
  for (const position of positions) {
    const start = resolveFiniteNonNegative(position.start);
    const end = Math.max(start, resolveFiniteNonNegative(position.end));
    const candidate =
      start === position.start && end === position.end ? position : { ...position, start, end };
    const delta = Math.abs(start - viewportStart);
    if (
      end >= viewportStart &&
      start <= viewportEnd &&
      (delta < distance ||
        (delta === distance &&
          nearest &&
          (start < nearest.start || (start === nearest.start && position.rowId < nearest.rowId))))
    ) {
      nearest = candidate;
      distance = delta;
    }
    if (
      start <= viewportStart &&
      (!before || start > before.start || (start === before.start && position.rowId > before.rowId))
    )
      before = candidate;
    if (
      start > viewportStart &&
      (!after || start < after.start || (start === after.start && position.rowId < after.rowId))
    )
      after = candidate;
  }
  return nearest?.rowId ?? before?.rowId ?? after?.rowId;
}

export function resolveConversationTurnNavigatorBarVisualState({
  itemIndex,
  visualFocusItemIndex,
}: ResolveConversationTurnNavigatorBarVisualStateOptions): ConversationTurnNavigatorBarVisualState {
  if (visualFocusItemIndex === undefined) {
    return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
  }

  const distance = Math.abs(itemIndex - visualFocusItemIndex);
  if (distance === 0) {
    return { colorTone: "focus", opacity: 1, scaleX: 2.6, tone: "peak" };
  }
  if (distance === 1) {
    return { colorTone: "muted", opacity: 0.86, scaleX: 1.7, tone: "near" };
  }
  if (distance === 2) {
    return { colorTone: "muted", opacity: 0.72, scaleX: 1.25, tone: "mid" };
  }
  return { colorTone: "muted", opacity: 0.58, scaleX: 1, tone: "idle" };
}

export function resolveConversationTurnNavigatorVisualFocusItemIndex({
  interactionItemIndex,
}: ResolveConversationTurnNavigatorVisualFocusItemIndexOptions): number | undefined {
  return interactionItemIndex;
}
