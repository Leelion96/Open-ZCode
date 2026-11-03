import type { ConversationFindMatch } from "@/v4/conversationFindIndex.js";

export const FIND_HIGHLIGHT_NAME = "zcode-v4-conversation-find";
export const ACTIVE_FIND_HIGHLIGHT_NAME = "zcode-v4-conversation-find-active";
export const SEARCH_RESULT_HIGHLIGHT_NAME = "zcode-v4-conversation-search-result";

const FIND_STYLE_ID = "zcode-v4-conversation-find-highlight-style";
const FIND_HIGHLIGHT_STYLE = `
::highlight(${FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight, #fde68a);
  color: var(--color-foreground);
}
::highlight(${ACTIVE_FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
::highlight(${SEARCH_RESULT_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
`;

interface CssHighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type CssHighlightLike = { priority?: number };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

export function ensureConversationFindHighlightStyle() {
  if (typeof document === "undefined") {
    return;
  }

  const style = document.getElementById(FIND_STYLE_ID) ?? document.createElement("style");
  style.id = FIND_STYLE_ID;
  if (style.textContent !== FIND_HIGHLIGHT_STYLE) {
    // 开发态 HMR 会复用旧 style 节点；内容变化时必须同步更新。
    style.textContent = FIND_HIGHLIGHT_STYLE;
  }
  if (!style.isConnected) {
    document.head.append(style);
  }
}

function getCssHighlightSupport(): {
  highlights: CssHighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return null;
  }

  const highlights = (CSS as unknown as { highlights?: CssHighlightRegistryLike }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!highlights || !Highlight) {
    return null;
  }
  return { highlights, Highlight };
}

function createHighlight(
  Highlight: HighlightConstructor,
  ranges: Range[],
  priority: number,
): unknown {
  const highlight = new Highlight(...ranges) as CssHighlightLike;
  highlight.priority = priority;
  return highlight;
}

function shouldSkipTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) {
    return true;
  }
  return Boolean(
    parent.closest(
      'button,input,textarea,select,[contenteditable="true"],[data-conversation-find-ignore="true"]',
    ),
  );
}

function collectTextRangesInElement(element: HTMLElement, normalizedQuery: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || shouldSkipTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.data.toLocaleLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    const normalizedText = textNode.data.toLocaleLowerCase();
    let searchStart = 0;
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      const range = document.createRange();
      range.setStart(textNode, matchIndex);
      range.setEnd(textNode, matchIndex + normalizedQuery.length);
      ranges.push(range);
      searchStart = matchIndex + normalizedQuery.length;
    }
    currentNode = walker.nextNode();
  }

  return ranges;
}

export function getMountedConversationFindRow(
  root: HTMLElement,
  rowId: number,
): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
}

export function getMountedConversationFindRange(
  root: HTMLElement,
  query: string,
  match: ConversationFindMatch,
): Range | null {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return null;
  }
  const rowElement = getMountedConversationFindRow(root, match.rowId);
  if (!rowElement) {
    return null;
  }
  const rowRanges = collectTextRangesInElement(rowElement, normalizedQuery);
  return rowRanges[match.rowMatchIndex] ?? null;
}

export function applyConversationFindHighlights({
  root,
  query,
  matches,
  activeMatch,
}: {
  root: HTMLElement;
  query: string;
  matches: readonly ConversationFindMatch[];
  activeMatch: ConversationFindMatch | null;
}): Range | null {
  ensureConversationFindHighlightStyle();
  const support = getCssHighlightSupport();
  if (!support) {
    return null;
  }

  // 同一行的每个命中都重新遍历全文会放大为二次复杂度；屏外行也不应逐命中查 DOM。
  const mountedRows = new Map<number, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-row-id]")) {
    const rowId = Number(element.dataset.rowId);
    if (!mountedRows.has(rowId)) mountedRows.set(rowId, element);
  }
  const rowRanges = new Map<number, Range[]>();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const resolveRange = (match: ConversationFindMatch): Range | null => {
    const element = mountedRows.get(match.rowId);
    if (!element || !normalizedQuery) return null;
    let found = rowRanges.get(match.rowId);
    if (!found) {
      found = collectTextRangesInElement(element, normalizedQuery);
      rowRanges.set(match.rowId, found);
    }
    return found[match.rowMatchIndex] ?? null;
  };
  const ranges = matches.map(resolveRange).filter((range): range is Range => range !== null);
  const activeRange = activeMatch ? resolveRange(activeMatch) : null;

  support.highlights.set(FIND_HIGHLIGHT_NAME, createHighlight(support.Highlight, ranges, 0));
  support.highlights.set(
    ACTIVE_FIND_HIGHLIGHT_NAME,
    createHighlight(support.Highlight, activeRange ? [activeRange] : [], 1),
  );
  return activeRange;
}

export function applySearchResultHighlight({
  root,
  query,
  match,
}: {
  root: HTMLElement;
  query: string;
  match: ConversationFindMatch;
}): Range | null {
  ensureConversationFindHighlightStyle();
  const support = getCssHighlightSupport();
  if (!support) {
    return null;
  }
  const range = getMountedConversationFindRange(root, query, match);
  support.highlights.set(
    SEARCH_RESULT_HIGHLIGHT_NAME,
    createHighlight(support.Highlight, range ? [range] : [], 2),
  );
  return range;
}

export function scrollConversationFindRangeIntoView(range: Range) {
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  // 虚拟窗口居中会挂载新的缓冲行；后续测高补偿会取消原生 smooth 动画，留下错误落点。
  // 先立即完成命中定位，再由既有锚点补偿保持相对位置，不与动画争夺滚动权。
  element?.scrollIntoView({ block: "center", behavior: "auto" });
}

export function clearConversationFindHighlights() {
  const support = getCssHighlightSupport();
  support?.highlights.delete(FIND_HIGHLIGHT_NAME);
  support?.highlights.delete(ACTIVE_FIND_HIGHLIGHT_NAME);
}

export function clearSearchResultHighlight() {
  getCssHighlightSupport()?.highlights.delete(SEARCH_RESULT_HIGHLIGHT_NAME);
}
