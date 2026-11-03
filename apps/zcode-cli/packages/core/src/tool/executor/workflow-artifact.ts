/**
 * workflow run 产物的序列化规则，被 core 内的两处共用：完成通知的 `<result>`（background-tasks.ts）
 * 与 runtime task 条目上的 `resultText`（background-task-registry.ts，TaskOutput 的唯一来源）。
 *
 * 实现**搬到了 `@zcode/contracts`**（`interfaces/dynamic-workflow-run.port.ts`，与
 * `boundDynamicWorkflowRunEventPayload` 同一个接缝），因为它多了第三个消费者：bootstrap 的 v4
 * 投影要用同一条规则算 `workflowRuns.reports[].preview`（详情页 Results 区）。bootstrap 不能
 * import core 的内部模块，而复制一份序列化规则就是「同一个值在通知里和面板上长得不一样」的
 * 来源。这里保留一个再导出，好让 core 侧的两个 import 站点不动。
 */
import {
  serializeWorkflowArtifact,
  type BackgroundResultOriginMeta,
  type DynamicWorkflowRunError,
  type DynamicWorkflowRunStopReason,
  type DynamicWorkflowRunSnapshot,
  type ExecutionPort,
  type SubagentTaskSnapshot,
  type WorkflowTaskSnapshot,
  type WorkflowNotificationMeta,
} from "@zcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import { isRecord } from "./utils.js";
import {
  buildWorkflowArtifactsManifestSection,
  toPublishedArtifactSummaries,
} from "./workflow-published-artifacts.js";

export { serializeWorkflowArtifact };

/**
 * 完成通知里 `<reports>` 那一节的预算：整节最多这么多字符。
 *
 * 通知端本来就有 120k 的总截断，但那是**最后一道**闸：它先斩到的是排在后面的字段。快照带来的
 * 渐进产物可以有 256 条（`DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS`），任由它铺开会把 `<result>` 与
 * `<error>` 挤出通知——而那两个才是模型首先要看的。所以这一节自己带预算。
 */
const WORKFLOW_REPORTS_PREVIEW_MAX_CHARS = 8_000;
/** 单条的界。一条 32KB 的产物不该吃掉整节预算，让后面十条一条也进不来。 */
const WORKFLOW_REPORT_ITEM_MAX_CHARS = 2_000;

interface WorkflowReportsNotificationSection {
  /** **真实总条数**（不是预览里的条数）。 */
  count: number;
  /** 预览里实际给出的条数；小于 count 即预览是局部的。 */
  shown: number;
  preview: string;
}

/**
 * journal 里的 report 条目 → 完成通知的 `<reports>` 一节（completed / failed / cancelled 通用）。
 *
 * 截断与计数**两者都重要**：计数才是让主 agent 知道「预览是局部的、全量可经 run id 取回」的
 * 那个信号。只给预览会让模型以为它看到了全部；只给计数则等于什么产物都没回。
 *
 * `total` 是 run 的真实总条数（快照的 `reportCount`）；`items` 只是它的前若干条（快照截在
 * 256 条处）。缺席时退回 `items.length`——老快照没有这个字段，而那时 `items` 就是全部。
 *
 * 零条时返回 `undefined`，调用方据此让整节缺席——不发一节空的 `<reports>`。
 */
export function buildWorkflowReportsNotificationSection(
  items: readonly unknown[] | undefined,
  total?: number,
): WorkflowReportsNotificationSection | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const lines: string[] = [];
  let used = 0;
  for (const [index, item] of items.entries()) {
    const text = clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_REPORT_ITEM_MAX_CHARS);
    const line = `[${index + 1}] ${text}`;
    // 至少给一条：一条超长产物也比"报过 11 条但一条都看不到"有用。
    if (lines.length > 0 && used + line.length + 1 > WORKFLOW_REPORTS_PREVIEW_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  return {
    count: Math.max(total ?? 0, items.length),
    shown: lines.length,
    preview: lines.join("\n"),
  };
}

/**
 * manifest 载荷（`WorkflowNotificationMeta.reports`）的 `<reports>` 一节。与上面那个
 * **通知文本**用的一节同源同逐条序列化（`serializeWorkflowArtifact`），只是产出 **string[]**
 * 而非拼接好的一段文本——manifest 由 GUI 逐条渲染成编号预览，拼接会让它再拆一次。
 *
 * 界与通知文本那一节刻意不同：这里逐条 ≤500、最多 8 条（同步于 shared 的 `workflowNotificationMetaSchema`——超界会让 turnHeader row 落库时 zod 拒收）。
 * `count` 恒是**真实总条数**：`count ≠ shown` 就是「预览是局部的、全量经 run id 可取」的信号。
 *
 * `total` 与通知那一节同义（快照的 `reportCount`，缺席退回 `items.length`）。
 *
 * 零条时返回 `undefined`，调用方据此让整字段缺席。
 */
export function buildWorkflowReportsManifestSection(
  items: readonly unknown[] | undefined,
  total?: number,
): { count: number; shown: number; preview: string[] } | undefined {
  if (items === undefined || items.length === 0) return undefined;

  const preview: string[] = [];
  for (const item of items) {
    if (preview.length >= WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS) break;
    preview.push(
      clip(serializeWorkflowArtifact(item) ?? "", WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS),
    );
  }
  return { count: Math.max(total ?? 0, items.length), shown: preview.length, preview };
}

/** manifest 载荷里逐条产物预览的界（shared schema：≤500 字符）。 */
const WORKFLOW_NOTIFICATION_REPORT_ITEM_MAX_CHARS = 500;
/** manifest 载荷里预览最多几条（shared schema：≤8 条）。 */
const WORKFLOW_NOTIFICATION_REPORTS_MAX_ITEMS = 8;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// 通知载荷与展示摘要由同一模块生成；tracker 只负责观察和持久化生命周期事件。
export type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // workflow run 的快照沿用 WorkflowTaskSnapshot 的形状但把 output 放宽成 unknown（产物由脚本
  // 的顶层返回值决定），所以它不是 WorkflowTaskSnapshot 的子类型，必须单列一支。
  | DynamicWorkflowRunSnapshot;

export function buildWorkflowTaskSummary(input: {
  lost?: boolean;
  status: "completed" | "failed" | "killed";
  runStatus?: WorkflowTerminalRunStatus;
  stopReason?: DynamicWorkflowRunStopReason | undefined;
  subject: string;
}): string {
  const prefix = `Workflow "${input.subject}"`;
  if (input.lost) return `${prefix} failed because its in-process state was lost.`;
  // 一句话就要把「怎么结束的」说清：模型读 summary 比读 XML 字段更早。dwf 的三终态词优先；
  // legacy `Workflow` 不带 runStatus，落回追踪器的通用词。
  if (input.runStatus === "errored") return `${prefix} errored: the script failed.`;
  if (input.runStatus === "stopped" || input.status === "killed") {
    switch (input.stopReason) {
      case "user":
        return `${prefix} was stopped by the user.`;
      case "model":
        return `${prefix} was stopped by you (TaskStop).`;
      case "provider":
        return `${prefix} was stopped on a provider error.`;
      case "interrupted":
        return `${prefix} was stopped: the process that owned it exited.`;
      case "superseded":
        return `${prefix} was stopped and superseded by an amended run.`;
      default:
        return `${prefix} was stopped.`;
    }
  }
  return input.status === "completed" ? `${prefix} completed.` : `${prefix} failed.`;
}

type WorkflowTerminalRunStatus = "completed" | "errored" | "stopped";

/**
 * dwf 快照上的三终态事实。只有 dwf 那支快照带
 * `runStatus` / `stopReason` / `failure`（端口契约 `DynamicWorkflowRunSnapshot`）；老端口或
 * stub 不发它们时按追踪器的通用词折算：`failed` → errored、`cancelled` → stopped（reason 缺席，
 * 由调用方拿 registry 兜底）。非终态回 undefined。
 */
export function workflowSnapshotTerminal(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
):
  | {
      runStatus: WorkflowTerminalRunStatus;
      stopReason?: DynamicWorkflowRunStopReason;
      failure?: DynamicWorkflowRunError;
    }
  | undefined {
  const record = snapshot === undefined ? undefined : (snapshot as Record<string, unknown>);
  const declared = record?.runStatus;
  const runStatus: WorkflowTerminalRunStatus | undefined =
    declared === "completed" || declared === "errored" || declared === "stopped"
      ? declared
      : status === "completed"
        ? "completed"
        : status === "failed"
          ? "errored"
          : status === "cancelled"
            ? "stopped"
            : undefined;
  if (runStatus === undefined) return undefined;
  const reason = record?.stopReason;
  const stopReason =
    runStatus === "stopped" &&
    (reason === "user" ||
      reason === "model" ||
      reason === "provider" ||
      reason === "interrupted" ||
      reason === "superseded")
      ? reason
      : undefined;
  const failure = isRecord(record?.failure)
    ? (record?.failure as unknown as DynamicWorkflowRunError)
    : undefined;
  return {
    runStatus,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(failure === undefined ? {} : { failure }),
  };
}

export function workflowTaskSubject(
  toolCall: ExecutableToolCall,
  taskId: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  return (
    stringField(input, "description") ??
    (snapshot && "description" in snapshot ? runtimeString(snapshot.description) : undefined) ??
    (snapshot && "name" in snapshot ? runtimeString(snapshot.name) : undefined) ??
    stringField(output, "name") ??
    stringField(input, "name") ??
    stringField(input, "scriptPath") ??
    taskId
  );
}

export function runtimeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** manifest 载荷（`WorkflowNotificationMeta`）里各字段的界。发射侧就地截断——载荷随 turnHeader
 *  row 走协议 + snapshot，shared 的 `workflowNotificationMetaSchema` 用同一组 `.max()` 把关，
 *  超界会让整行落库时 zod 拒收。所以截断是**构造前**的纪律，不是可有可无的收尾。 */
const WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS = 500;
const WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS = 4_000;
const WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS = 2_000;

/**
 * workflow run 终态通知的 workflow originMeta（含 manifest 载荷）。CreateWorkflow / ResumeWorkflowRun
 * 两个入口同构，都经这里铸造：title 与 summary 同源（`workflowTaskSubject`），载荷只在**终态且
 * 快照在场**时携带（非终态 / lost 无快照 → 整字段缺席，GUI 退回裸标题行）。
 */
export function buildWorkflowNotificationOriginMeta(
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): BackgroundResultOriginMeta {
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const workflowNotification = buildWorkflowTerminalNotification(status, subject, snapshot);
  return {
    backgroundSource: "workflow",
    title: subject,
    workId: taskId,
    ...(workflowNotification ? { workflowNotification } : {}),
  };
}

/**
 * 快照级事实 → terminal 判别分支的 manifest 载荷。
 *
 * 只在三个终态（completed / failed / cancelled）且快照在场时铸造。`lost`（快照缺失）与非终态
 * 一律回 `undefined`——载荷缺席即 GUI 退回现状标题行，而不是谎报一个空壳。**usage/tokens 发射
 * 时不可知**（只在内存态投影里），所以只带 durationMs，tokens 留给 GUI 渲染期按 runId 联查。
 */
function buildWorkflowTerminalNotification(
  status: string,
  summary: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): WorkflowNotificationMeta | undefined {
  const terminalStatus = workflowTerminalNotificationStatus(status);
  if (terminalStatus === undefined || snapshot === undefined) return undefined;

  const terminal = workflowSnapshotTerminal(status, snapshot);
  const meta: Extract<WorkflowNotificationMeta, { kind: "terminal" }> = {
    kind: "terminal",
    status: terminal?.runStatus ?? terminalStatus,
    ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
    summary: summary.slice(0, WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS),
  };

  // 产物：脚本的任意顶层返回值，统一序列化。截断诚实——`resultTruncated` 在场即预览是局部的，
  // 全量经 run id / GetWorkflowRun 可取。resultForm 与 serializeWorkflowArtifact 的分叉对齐：
  // string 原样（prose），其余 JSON.stringify（json）。
  const outputValue = snapshot && "output" in snapshot ? snapshot.output : undefined;
  const serialized = serializeWorkflowArtifact(outputValue);
  if (serialized !== undefined) {
    if (serialized.length > WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS) {
      meta.result = serialized.slice(0, WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS);
      meta.resultTruncated = true;
    } else {
      meta.result = serialized;
    }
    meta.resultForm = typeof outputValue === "string" ? "prose" : "json";
  }

  const error = snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined;
  if (error !== undefined) meta.error = error.slice(0, WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS);

  // 渐进产物三个终态一律携带：一个死在第 12 个 ask 上的 run 仍做完了 11 个 ask 的活。
  const reports = buildWorkflowReportsManifestSection(
    workflowSnapshotReports(snapshot),
    workflowSnapshotReportCount(snapshot),
  );
  if (reports !== undefined) meta.reports = reports;

  // 用户面产物的 chips 载荷。这是通知行 chips 的
  // **唯一**数据源：hydration 冷恢复把它按 shared 的 zod 原样读回，缺一个键就等于 chips 永久
  // 消失。三个终态一律携带，理由同 reports。
  const artifactsSection = buildWorkflowArtifactsManifestSection(
    workflowSnapshotArtifacts(snapshot),
  );
  if (artifactsSection !== undefined) {
    meta.artifacts = artifactsSection.artifacts;
    if (artifactsSection.artifactsTruncated) meta.artifactsTruncated = true;
  }

  const durationMs = workflowNotificationDurationMs(snapshot);
  if (durationMs !== undefined) meta.durationMs = durationMs;

  return meta;
}

/**
 * 追踪器终态 status → manifest 的三个终态字面（`failed` → errored、`cancelled` → stopped）；非终态（running / lost 等）回 undefined（不携带
 * 载荷）。快照自带 `runStatus` 时以它为准（见 workflowSnapshotTerminal）。
 */
function workflowTerminalNotificationStatus(
  status: string,
): "completed" | "errored" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

/**
 * 通知里的墙钟时长（完成卡的「时间」格，见
 * docs/dynamic-workflow/transcript-and-notifications.md「How long it took」）。
 *
 * 两个来源，取**大**者：
 *   - 本世：`completedAt - startedAt`，结算它的这个进程自己看到的那一段；
 *   - 整条 lineage 的活动时长：`activeDurationMs`，由端口从 journal 求和（resume 的每一世 +
 *     沿 `resumedFrom` 的每个前驱），缺席即读不出。
 *
 * 缺陷原因（2026-09-21）：只报本世会把「跑了四小时、修订过一次」的 run 报成 12 秒——修订与
 * resume 各自重开一次进程内时钟，而那一世大半是缓存重放。取大而不是直接取 lineage，是为了守住
 * 「永不少报本进程亲眼所见」：老 run 的事件早于本记账、journal 读面不在场时 `activeDurationMs`
 * 缺席，退回本世；而 lineage 值正常总比本世大（它含本世）。
 *
 * 两个来源都读不出时整字段缺席（卡上写 `—`），不写 0。
 */
function workflowNotificationDurationMs(snapshot: BackgroundTaskSnapshot): number | undefined {
  const startedAt =
    "startedAt" in snapshot && snapshot.startedAt instanceof Date
      ? snapshot.startedAt.getTime()
      : undefined;
  const completedAt =
    "completedAt" in snapshot && snapshot.completedAt instanceof Date
      ? snapshot.completedAt.getTime()
      : undefined;
  const ownLifeMs =
    startedAt === undefined || completedAt === undefined
      ? undefined
      : nonNegativeFinite(completedAt - startedAt);
  const lineageMs =
    "activeDurationMs" in snapshot ? nonNegativeFinite(snapshot.activeDurationMs) : undefined;
  if (ownLifeMs === undefined) return lineageMs;
  return lineageMs === undefined ? ownLifeMs : Math.max(ownLifeMs, lineageMs);
}

/** 非负有限数才算一个时长；其余（NaN / Infinity / 负数 / 非数）一律读作「说不出」。 */
function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 快照上的 dwf 渐进产物。`BackgroundTaskSnapshot` 是个联合类型（bash / subagent / legacy
 * workflow / dwf 各一支），只有 dwf 那支有 `reports`，所以按 `in` 收窄而不是断言。
 * 形状照样防御性检查：这条路径的输入来自端口实现，而快照是跨包契约。
 */
/**
 * 快照上的 dwf 脚本文件（绝对路径）。收窄方式与 {@link workflowSnapshotReports} 同款
 * （`in` 而不是断言：`BackgroundTaskSnapshot` 是四支联合，只有 dwf 那支有这个键），形状再过
 * 一遍 typeof——快照是跨包契约，老端口 / stub 完全可能不带它。
 */
export function workflowSnapshotScriptPath(
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (snapshot === undefined || !("scriptPath" in snapshot)) return undefined;
  return typeof snapshot.scriptPath === "string" && snapshot.scriptPath.length > 0
    ? snapshot.scriptPath
    : undefined;
}

export function workflowSnapshotReports(
  snapshot: BackgroundTaskSnapshot | undefined,
): readonly unknown[] | undefined {
  if (snapshot === undefined || !("reports" in snapshot)) return undefined;
  return Array.isArray(snapshot.reports) ? snapshot.reports : undefined;
}

/** 快照上的 report 真实总数（`reports` 只带前 256 条）；缺席即老快照，读侧退回条目数。 */
export function workflowSnapshotReportCount(
  snapshot: BackgroundTaskSnapshot | undefined,
): number | undefined {
  if (snapshot === undefined || !("reportCount" in snapshot)) return undefined;
  return typeof snapshot.reportCount === "number" ? snapshot.reportCount : undefined;
}

/**
 * 快照上的 dwf **用户面产物**（`artifact.*` 发布的产出，不是 `output` 那个返回值）。收窄方式
 * 与 {@link workflowSnapshotReports} 同款（`in` 而不是断言：`BackgroundTaskSnapshot` 是四支
 * 联合，只有 dwf 那支有这个键），形状再过一遍防御性解析——快照是跨包契约。
 */
export function workflowSnapshotArtifacts(
  snapshot: BackgroundTaskSnapshot | undefined,
): ReturnType<typeof toPublishedArtifactSummaries> {
  if (snapshot === undefined || !("artifacts" in snapshot)) return undefined;
  return toPublishedArtifactSummaries(snapshot.artifacts);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return runtimeString(record?.[key]);
}
