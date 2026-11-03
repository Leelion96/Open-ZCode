import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Streamdown } from "streamdown";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { createConversationTurnRenderUnitsSelector } from "@/v4/conversationTurnRenderUnits.js";
import { getConversationRowsPartition } from "@/v4/conversationProjectionStore.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import {
  clearV4ComposerDraftTaskGroup,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  resolveComposerScope,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { projectAssistantCodeComments } from "@/lib/assistantCodeComment.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationFindMatchState } from "@/v4/legacyChatViewTypes.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const workspace = "/render-boundary";
if (params.get("group") === "1")
  useZCodeSessionStore
    .getState()
    .startDraft(workspace, undefined, undefined, { taskGroupId: "group-a" });
persistV4ComposerDraft(
  workspace,
  undefined,
  V4_DRAFT_SCOPE_ROOT,
  { text: "", mode: "build", updatedAt: 0 },
  resolveComposerScope(null),
);
let ownerRenders = 0;
function DraftOwner() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const owner = useDraftConfigControl({
    workspacePath: workspace,
    provider: "zcode",
    sessionId,
    sessionConfig: null,
    agentStartupAllowed: false,
    modelSelectionService: null,
  });
  ownerRenders++;
  Object.assign(window, {
    __draftBoundary: {
      renders: () => ownerRenders,
      type: (text: string) => {
        owner.stageComposerContent({ text });
        // 修复前落入旧保存路径，先保留真实失败基线。
        const persist =
          "persistComposerContent" in owner
            ? owner.persistComposerContent
            : owner.updateComposerContent;
        (persist as (content: { text: string }) => void)({ text });
      },
      mode: () => owner.handleDraftSwitchMode("yolo"),
      switch: () => setSessionId((value) => (value ? null : "another")),
      read: () =>
        readV4ComposerDraft(workspace, undefined, V4_DRAFT_SCOPE_ROOT, resolveComposerScope(null)),
      owner: () => owner.composerDraft,
      capture: (text: string) => owner.captureComposerSubmissionDraftTransaction({ text }),
      promote: () => owner.promoteComposerDraft("created"),
      lifecycle: () => owner.captureComposerContentLifecycleCommit(),
      clearGroup: () => {
        clearV4ComposerDraftTaskGroup(workspace, undefined, resolveComposerScope(null));
        useZCodeSessionStore.getState().clearDraftTaskGroup(workspace);
      },
    },
  });
  return <output data-testid="draft-ready">{sessionId ?? "draft"}</output>;
}
const rows: ConversationRow[] = Array.from({ length: 1000 }, (_, index) => {
  const base = { turnId: `turn-${index}`, createdAt: 1, createdAtSeq: index * 3 + 1 };
  return [
    {
      ...base,
      rowId: index * 3 + 1,
      kind: "turnHeader",
      origin: "userInput",
      state: index === 999 ? "running" : "completedSuccess",
      startedAt: 1,
      endedAt: index === 999 ? undefined : 2,
    },
    {
      ...base,
      rowId: index * 3 + 2,
      kind: "userInput",
      origin: "realUser",
      text: `question ${index}`,
    },
    {
      ...base,
      rowId: index * 3 + 3,
      kind: "assistantText",
      text: `answer ${index}`,
      state: index === 999 ? "streaming" : "complete",
    },
  ] as ConversationRow[];
}).flat();
const virtualItems = [{ index: 0, start: 0, size: 100 }];
function Navigation() {
  const [source, setSource] = useState(rows);
  const select = useMemo(() => createConversationTurnRenderUnitsSelector(), []);
  const units = select(getConversationRowsPartition(source), { nowMs: 5000 });
  const [jump, setJump] = useState("");
  Object.assign(window, {
    __navBoundary: {
      stream: () =>
        setSource((old) =>
          old.map((row) =>
            row.kind === "assistantText" && row.turnId === "turn-999"
              ? { ...row, text: row.text + " next" }
              : row,
          ),
        ),
      revise: () =>
        setSource((old) =>
          old.map((row) =>
            row.kind === "assistantText" && row.turnId === "turn-0"
              ? { ...row, text: "revised answer" }
              : row,
          ),
        ),
      trim: () => setSource((old) => old.filter((row) => row.turnId !== "turn-0")),
    },
  });
  return (
    <main className="relative h-screen w-full @container/conversation">
      <output data-testid="jump">{jump}</output>
      <ConversationTurnNavigator
        renderUnits={units}
        scrollOffsetPx={0}
        viewportHeightPx={700}
        virtualItems={virtualItems}
        onJumpToQuery={useMemo(
          () => (target: { unitIndex: number; rowId: number }) => setJump(JSON.stringify(target)),
          [],
        )}
      />
    </main>
  );
}

function Search() {
  const [source, setSource] = useState(() =>
    rows.slice(0, 9).map((row) =>
      row.kind !== "assistantText"
        ? row
        : {
            ...row,
            text:
              row.turnId === "turn-0"
                ? 'Visible alpha\n::code-comment{title="Hidden" body="hidden-value" file="/repo/a.ts"}\nTail'
                : row.turnId === "turn-1"
                  ? '`::code-comment{title="Literal" body="protected-value" file="/repo/b.ts"}`'
                  : `普通文本 ${"alpha ".repeat(300)}没有指令。`,
          },
    ),
  );
  const select = useMemo(() => createConversationTurnRenderUnitsSelector(), []);
  const units = useMemo(() => select(getConversationRowsPartition(source), {}), [select, source]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState({ query: "", activeIndex: 0, matchCount: 0 });
  const scrollToUnit = useMemo(() => () => undefined, []);
  useConversationTimelineFind({
    rootRef,
    renderUnits: units,
    rows: source,
    mountedRowsKey: "all",
    isMountedLayoutMeasured: useMemo(() => () => true, []),
    canLoadOlder: false,
    loadingOlder: false,
    conversationFindQuery: query,
    conversationFindActiveIndex: 0,
    conversationFindNavigationRequestId: 0,
    onConversationFindMatchStateChange: useMemo(
      () => (next: typeof matches) =>
        setMatches((old) =>
          old.query === next.query &&
          old.activeIndex === next.activeIndex &&
          old.matchCount === next.matchCount
            ? old
            : next,
        ),
      [],
    ),
    scrollToUnit,
  });
  return (
    <div ref={rootRef}>
      <input aria-label="Find" value={query} onChange={(event) => setQuery(event.target.value)} />
      <output data-testid="find-count">{matches.matchCount}</output>
      <button
        onClick={() =>
          setSource((old) =>
            old.map((row) =>
              row.kind === "assistantText" && row.turnId === "turn-0"
                ? { ...row, text: "revised alpha alpha" }
                : row,
            ),
          )
        }
      >
        Revise history
      </button>
      {source.flatMap((row) =>
        row.kind === "assistantText"
          ? [
              <p key={row.rowId} data-row-id={row.rowId}>
                {
                  projectAssistantCodeComments(row.text, { streaming: row.state === "streaming" })
                    .visibleText
                }
              </p>,
            ]
          : [],
      )}
    </div>
  );
}

function SearchNavigation() {
  const source = useMemo(
    () =>
      rows
        .slice(0, 72)
        .map((row) =>
          row.kind === "assistantText" && row.turnId === "turn-0"
            ? { ...row, text: "**needle**\n\n[needle link](https://example.com/hidden-target)" }
            : row,
        ),
    [],
  );
  const select = useMemo(() => createConversationTurnRenderUnitsSelector(), []);
  const units = useMemo(() => select(getConversationRowsPartition(source), {}), [select, source]);
  const unitCount = units.history.length + units.tail.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [requestId, setRequestId] = useState(1);
  const [mountTarget, setMountTarget] = useState(params.get("hold") !== "1");
  const [matchCount, setMatchCount] = useState(0);
  const scrollCalls = useRef<number[]>([]);
  const doneRequests = useRef<number[]>([]);
  const virtualizer = useVirtualizer({
    count: unitCount,
    getScrollElement: () => rootRef.current,
    estimateSize: () => 300,
    overscan: 1,
  });
  const items = virtualizer.getVirtualItems();
  const external = params.get("entry") === "result";
  const request = useMemo(
    () =>
      external && query
        ? {
            requestId,
            query,
            taskId: "find-regression",
            workspacePath: workspace,
          }
        : null,
    [external, query, requestId],
  );
  const scrollToUnit = useCallback(
    (index: number) => {
      scrollCalls.current.push(index);
      const offset = virtualizer.getOffsetForIndex(index, "start")?.[0];
      if (offset !== undefined) rootRef.current?.scrollTo({ top: offset });
    },
    [virtualizer],
  );
  useConversationTimelineFind({
    rootRef,
    renderUnits: units,
    rows: source,
    mountedRowsKey: `${mountTarget}:${items.map((item) => `${item.index}:${item.size}`).join(":")}`,
    isMountedLayoutMeasured: useCallback(
      () =>
        virtualizer.getVirtualItems().every((item) => {
          const node = virtualizer.elementsCache.get(item.key);
          return node?.isConnected && node.getBoundingClientRect().height === item.size;
        }),
      [virtualizer],
    ),
    canLoadOlder: false,
    loadingOlder: false,
    conversationFindQuery: external ? "" : query,
    conversationFindActiveIndex: 0,
    conversationFindNavigationRequestId: requestId,
    onConversationFindMatchStateChange: useCallback(
      (state: ConversationFindMatchState) => setMatchCount(state.matchCount),
      [],
    ),
    searchResultHighlightRequest: request,
    onSearchResultHighlightDone: useCallback((id: number) => {
      doneRequests.current.push(id);
    }, []),
    scrollToUnit,
  });
  Object.assign(window, {
    __findNavigation: {
      snapshot: () => ({
        calls: [...scrollCalls.current],
        done: [...doneRequests.current],
        requestId,
      }),
    },
  });
  return (
    <main>
      <input aria-label="Find" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button onClick={() => setRequestId((id) => id + 1)}>Navigate again</button>
      <button onClick={() => setMountTarget(true)}>Mount target</button>
      <output data-testid="find-count">{matchCount}</output>
      <div ref={rootRef} data-testid="find-scroll" style={{ height: 400, overflow: "auto" }}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                width: "100%",
                height: 300,
                transform: `translateY(${item.start}px)`,
              }}
            >
              {(item.index !== 0 || mountTarget) && (
                <div data-row-id={item.index * 3 + 3}>
                  <Streamdown mode="static">
                    {
                      (
                        source[item.index * 3 + 2] as Extract<
                          ConversationRow,
                          { kind: "assistantText" }
                        >
                      ).text
                    }
                  </Streamdown>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      {params.get("mode") === "draft" ? (
        <DraftOwner />
      ) : params.get("mode") === "find-navigation" ? (
        <AssistantCodeCommentFeatureProvider enabled>
          <SearchNavigation />
        </AssistantCodeCommentFeatureProvider>
      ) : params.get("mode") === "find" ? (
        <AssistantCodeCommentFeatureProvider enabled>
          <Search />
        </AssistantCodeCommentFeatureProvider>
      ) : (
        <Navigation />
      )}
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
