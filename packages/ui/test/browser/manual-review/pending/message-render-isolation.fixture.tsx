import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { useShallow } from "zustand/react/shallow";
import { shallow } from "zustand/shallow";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import {
  buildConversationTurnRenderUnits,
  createConversationTurnRenderUnitsSelector,
} from "@/v4/conversationTurnRenderUnits.js";
import { getConversationRowsPartition } from "@/v4/conversationProjectionStore.js";
import {
  selectWorkflowJoinRows,
  buildWorkflowGraphByToolCallId,
  buildWorkflowFillGraphByRunId,
  buildWorkflowSaveCandidatesByRunId,
} from "@/v4/workflowRunCardJoin.js";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";
import {
  createTaskFindNavigationState,
  changeTaskFindSelection,
  navigateTaskFindSelection,
} from "@/quickpick/taskFindNavigationState.js";
import {
  getPluginUiDisclosureSnapshot,
  setPluginUiManualPin,
  subscribePluginUiDisclosure,
} from "@/plugin-ui/app/pluginUiDisclosureStore.js";
import { deriveLogicalUiInstances } from "@/plugin-ui/index.js";
import { toolCallCreateWorkflowDisplaySchema } from "@zcode/shared/zcode-protocol-v4";
import * as highspeed from "@/highspeed/highspeedTurnStore.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const mobile = query.get("mobile") === "true";
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const start = 1_700_000_000_000;
const context = {
  workspacePath: "/fixture",
  theme,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  compactForRemoteControl: mobile,
} as const;
const onFeedback = () => undefined;
function turn(turnId: string, index: number, running = false): ConversationRow[] {
  const base = { turnId, createdAt: start, createdAtSeq: index * 3 + 1 };
  return [
    {
      ...base,
      rowId: index * 3 + 1,
      kind: "turnHeader",
      origin: "userInput",
      sourceCommandId: `${turnId}-command`,
      state: running ? "running" : "completedSuccess",
      startedAt: start,
      ...(!running ? { endedAt: start + 1000, activeMs: 1000 } : {}),
    },
    {
      ...base,
      rowId: index * 3 + 2,
      kind: "userInput",
      origin: "realUser",
      text: `input ${turnId}`,
    },
    {
      ...base,
      rowId: index * 3 + 3,
      kind: "assistantText",
      entityId: `text-${turnId}`,
      text: running ? "stream 0" : `answer ${turnId}`,
      state: running ? "streaming" : "complete",
    },
  ];
}
const initial = [...turn("history-0", 0), ...turn("history-1", 1), ...turn("active", 2, true)];
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}
function equal(a: unknown, b: unknown, label: string) {
  const serialize = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (item instanceof Map ? [...item] : item));
  check(serialize(a) === serialize(b), label);
}
function boundaryChecks() {
  const evidence: string[] = [];
  // 以原纯构建器为值语义对照，跨行种类、终态、隐藏行与窗口变化；不把引用相等当业务正确。
  const select = createConversationTurnRenderUnitsSelector();
  const compare = (rows: ConversationRow[], options = {}) => {
    // selector 输出按「历史 + 尾轮」分区；拼平后与整窗纯构建器逐项对照。
    const partition = select(getConversationRowsPartition(rows), {
      nowMs: start + 5000,
      ...options,
    });
    const actual = [...partition.history, ...partition.tail];
    equal(
      actual,
      buildConversationTurnRenderUnits(rows, { nowMs: start + 5000, ...options }),
      "turn value parity",
    );
    return actual;
  };
  let rows = initial;
  const old = compare(rows);
  rows = rows.map((r) =>
    r.kind === "assistantText" && r.turnId === "active" ? { ...r, text: "changed" } : r,
  );
  const changed = compare(rows);
  check(old[0] === changed[0] && old[2] !== changed[2], "turn identity boundary");
  for (const state of ["completedSuccess", "completedInterrupted", "failed"] as const)
    compare(
      rows.map((r) => (r.kind === "turnHeader" && r.turnId === "active" ? { ...r, state } : r)),
    );
  compare(
    rows.filter((r) => r.kind !== "turnHeader"),
    { sessionPhase: "completedInterrupted" },
  );
  compare([...turn("prepended", 4), ...rows]);
  compare(rows.slice(3));
  compare([]);
  compare(initial);
  const plugin = {
    ...rows[0],
    rowId: 90,
    kind: "toolCall",
    toolCallId: "plugin",
    toolName: "mcp__fixture__view",
    status: "success",
    display: { kind: "mcp_tool", ui: { resourceUri: "ui://fixture/view" } },
  } as ToolCallRow;
  const pinned = compare([...rows, plugin], {
    pluginUiPinResolver: () => ({ manualPinned: true }),
  });
  const unpinned = compare([...rows, plugin], {
    pluginUiPinResolver: () => ({ manualPinned: false }),
  });
  check(pinned[0] !== unpinned[0], "pin changes historical unit");
  const recent = [...rows, plugin];
  const derive = (input: ConversationRow[]) => {
    const disposition = deriveLogicalUiInstances(input).byToolCallId;
    return compare(input, {
      pluginUiPinResolver: (id: string) => ({ disposition: disposition[id] }),
    });
  };
  const recentThree = derive(recent);
  const outsideRecentThree = derive([...recent, ...turn("fourth", 4)]);
  check(
    recentThree[0] !== outsideRecentThree[0],
    "recent-three plugin boundary updates historical unit",
  );
  const cardMeta = {
    schemaVersion: 1 as const,
    cardId: "persisted",
    taskId: "fixture",
    provider: "fixture",
    model: "fixture",
    issuedAt: start,
    expiresAt: start + 6000,
    outputTokens: 100,
    regularTps: 10,
    highspeedTps: 50,
  };
  const cardRows = initial.map((r) => (r.kind === "userInput" ? { ...r, highspeed: cardMeta } : r));
  compare(cardRows);
  const expired = compare(cardRows, { nowMs: start + 7000 });
  check(
    expired.filter((u) => u.showHighspeedOutputFooter).length === 1 &&
      expired.at(-1)?.showHighspeedOutputFooter,
    "one footer at last card turn",
  );
  compare(cardRows.slice(0, 6), { nowMs: start + 8000 });
  evidence.push(
    "turn parity, completion, interruption, missing header, prepend, trim, pin, footer expiry and movement",
  );

  const graph = {
    steps: [{ id: "step", kind: "ask", label: "step", lane: "worker" }],
    lanes: [{ id: "worker" }],
    participants: [],
    handoffs: [],
  };
  const tool = (toolName: string, id: number, extra = {}) =>
    ({
      turnId: "workflow",
      createdAt: start,
      createdAtSeq: id,
      rowId: id,
      kind: "toolCall",
      toolCallId: `tool-${id}`,
      toolName,
      status: "success",
      inputText: "{}",
      ...extra,
    }) as ToolCallRow;
  const create = tool("CreateWorkflow", 100, {
    display: {
      kind: "create_workflow",
      ok: false,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: graph,
    },
  });
  const amend = tool("AmendWorkflow", 101, { input: { run_id: "run" } });
  const fill = tool("FillWorkflowHole", 102, {
    input: { run_id: "run", hole_id: "hole", name: "fill" },
    display: {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: graph,
    },
  });
  const save = tool("SaveWorkflow", 103, {
    input: { run_id: "run", name: "saved", scope: "project" },
  });
  const launch = {
    ...turn("launch", 40)[0],
    workflowLaunch: {
      toolCallId: "launch",
      runId: "launch-run",
      display: {
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph: graph,
      },
    },
  } as ConversationRow;
  toolCallCreateWorkflowDisplaySchema.parse(create.display);
  toolCallCreateWorkflowDisplaySchema.parse(fill.display);
  const relevant = [create, amend, fill, save, launch];
  const selected = selectWorkflowJoinRows([...initial, ...relevant]);
  check(
    shallow(selected, selectWorkflowJoinRows([...rows, ...relevant])),
    "text must retain workflow dependencies",
  );
  const builders = [
    buildWorkflowGraphByToolCallId,
    buildWorkflowFillGraphByRunId,
    buildWorkflowDraftByToolCallId,
    buildWorkflowSaveCandidatesByRunId,
  ];
  for (const input of [
    relevant,
    relevant.slice(1),
    relevant.slice(0, 3),
    [create, { ...create, rowId: 104, toolCallId: "next" }],
    relevant.map((r) => (r.kind === "toolCall" ? { ...r, status: "running" as const } : r)),
  ])
    for (const build of builders)
      equal(
        [...build(selectWorkflowJoinRows([...initial, ...input]))],
        [...build([...initial, ...input])],
        "workflow filtered parity",
      );
  check(buildWorkflowGraphByToolCallId(selected).size >= 1, "nonempty graph");
  check(buildWorkflowFillGraphByRunId(selected).size === 1, "fill reached join");
  check(
    buildWorkflowSaveCandidatesByRunId(selected).get("run")?.[0]?.name === "saved",
    "save reached join",
  );
  evidence.push("nonempty workflow graph, draft, amend, fill, save, launch and removal");

  let find = createTaskFindNavigationState();
  find = changeTaskFindSelection(find, "answer", 0);
  const next = navigateTaskFindSelection(find, "answer", 0);
  check(next.navigationRequestId === find.navigationRequestId + 1, "single result navigation");
  check(changeTaskFindSelection(next, "answer", 1).activeIndex === 1, "selection changes");
  evidence.push("explicit find navigation; passive callback covered by native App probe");
  return evidence;
}
let scopeRenders = 0;
function ScopeConsumer() {
  scopeRenders++;
  const select = useShallow(highspeed.getHighspeedSessionDependencies);
  const data = useSyncExternalStore(highspeed.subscribeHighspeedTurns, () => select("current"));
  const pins = useSyncExternalStore(subscribePluginUiDisclosure, () =>
    getPluginUiDisclosureSnapshot("current"),
  );
  return (
    <output data-testid="scope">
      {data.length}:{pins.size}
    </output>
  );
}
async function scopeChecks() {
  const settle = () =>
    new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const record = (sessionId: string, sourceCommandId: string, cardId: string) =>
    highspeed.recordHighspeedTurn({
      sessionId,
      sourceCommandId,
      createdAt: start,
      card: {
        cardId,
        taskId: sessionId,
        provider: "fixture",
        model: "fixture",
        issuedAt: start,
        expiresAt: start + 1000,
        regularTps: 10,
      },
    });
  const groupCounts = () => ({
    ...(window as unknown as { __turnRenders: Record<string, number> }).__turnRenders,
  });
  const initialGroups = groupCounts();
  let before = scopeRenders;
  setPluginUiManualPin("other", "tool", true);
  record("other", "other", "other-card");
  await settle();
  check(scopeRenders === before, "unrelated stores skip");
  equal(groupCounts(), initialGroups, "unrelated Highspeed update skips real turn groups");
  setPluginUiManualPin("current", "tool", true);
  await settle();
  check(scopeRenders > before, "current pin updates");
  record("current", "history-1-command", "shared");
  await settle();
  before = scopeRenders;
  record("other", "shared-other", "shared");
  await settle();
  check(scopeRenders > before, "same card across sessions updates");
  before = scopeRenders;
  highspeed.completeHighspeedTurn({
    sourceCommandId: "shared-other",
    outputTokens: 250,
    durationMs: 1000,
  });
  await settle();
  check(
    scopeRenders > before && highspeed.aggregateHighspeedCardMetrics("shared").outputTokens === 250,
    "same card completion",
  );
  before = scopeRenders;
  highspeed.setHighspeedCardTps("shared", 80);
  await settle();
  check(
    scopeRenders > before && highspeed.aggregateHighspeedCardMetrics("shared").highspeedTps === 80,
    "TPS updates",
  );
  check(
    (groupCounts()["history-1"] ?? 0) > (initialGroups["history-1"] ?? 0),
    "related real group receives Highspeed changes",
  );
  before = scopeRenders;
  highspeed.hydrateHighspeedTurnsFromTranscript("current", [
    {
      sourceCommandId: "history-1-command",
      createdAt: start,
      highspeed: {
        schemaVersion: 1,
        cardId: "shared",
        taskId: "current",
        provider: "fixture",
        model: "fixture",
        issuedAt: start,
        expiresAt: start + 1000,
        outputTokens: 50,
        durationMs: 500,
        regularTps: 10,
        highspeedTps: 80,
        savedDurationMs: 4500,
      },
    },
  ]);
  await settle();
  check(
    scopeRenders > before &&
      highspeed.getHighspeedTurnByCommandId("history-1-command")?.metricsPersistedAt !== undefined,
    "hydration and persisted metrics update",
  );
  before = scopeRenders;
  highspeed.discardHighspeedTurn("shared-other");
  await settle();
  check(
    scopeRenders > before && highspeed.aggregateHighspeedCardMetrics("shared").outputTokens === 50,
    "removal updates",
  );
  before = scopeRenders;
  for (let i = 0; i < 301; i++) record("other", `evict-${i}`, "other-card");
  await settle();
  check(
    scopeRenders > before && !highspeed.getHighspeedTurnByCommandId("history-1-command"),
    "bounded store eviction updates",
  );
  return "scoped subscriptions: unrelated skip, current pin, shared card completion, TPS, hydration, removal, eviction";
}
function Fixture() {
  const [rows, setRows] = useState(initial);
  const [nowMs, setNow] = useState(start + 2000);
  const [checks, setChecks] = useState("pending");
  const [evidence, setEvidence] = useState<string[]>([]);
  const select = useMemo(() => createConversationTurnRenderUnitsSelector(), []);
  const partition = select(getConversationRowsPartition(rows), { nowMs });
  const units = [...partition.history, ...partition.tail];
  return (
    <>
      <nav>
        <button
          data-testid="stream"
          onClick={() =>
            setRows((previous) =>
              previous.map((r) =>
                r.kind === "assistantText" && r.turnId === "active"
                  ? { ...r, text: `stream ${Number(r.text.split(" ")[1]) + 1}` }
                  : r,
              ),
            )
          }
        >
          Stream
        </button>
        <button data-testid="clock" onClick={() => setNow((n) => n + 1000)}>
          Clock
        </button>
        <button
          data-testid="complete"
          onClick={() =>
            setRows((previous) =>
              previous.map((r) =>
                r.turnId !== "active"
                  ? r
                  : r.kind === "turnHeader"
                    ? { ...r, state: "completedSuccess", endedAt: nowMs }
                    : r.kind === "assistantText"
                      ? { ...r, state: "complete" }
                      : r,
              ),
            )
          }
        >
          Complete
        </button>
        <button
          data-testid="append"
          onClick={() => setRows((previous) => [...previous, ...turn("new", 3, true)])}
        >
          Append
        </button>
        <button
          data-testid="trim"
          onClick={() => setRows((previous) => previous.filter((r) => r.turnId !== "history-0"))}
        >
          Trim
        </button>
        <button
          data-testid="assert-boundaries"
          onClick={async () => {
            try {
              const result = boundaryChecks();
              result.push(await scopeChecks());
              setEvidence(result);
              setChecks("passed");
            } catch (error) {
              setChecks(String(error));
            }
          }}
        >
          Check boundaries
        </button>
        <output data-testid="checks">{checks}</output>
        <output data-testid="evidence">{JSON.stringify(evidence)}</output>
        <ScopeConsumer />
      </nav>
      <main className="min-h-dvh bg-background text-foreground @container/conversation">
        {units.map((unit) => (
          <ConversationTurnGroup
            key={unit.key}
            unit={unit}
            nowMs={unit.isRunning ? nowMs : undefined}
            context={context}
            onFeedbackChange={onFeedback}
          />
        ))}
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <ZCodeIntlProvider initialLocale={mobile ? "en-US" : "zh-CN"}>
      <Fixture />
    </ZCodeIntlProvider>
  </TooltipProvider>,
);
