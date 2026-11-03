import { formatLocalIsoDate, type TraceContext } from "@zcode/contracts";
import { buildCurrentDateSection } from "../../context/sections/current-date.js";
import {
  buildEnvironmentAnnouncement,
  buildGitSystemContextSection,
  buildModelSection,
  environmentSnapshot,
  isEnvInfoGitRepository,
  type EnvironmentSnapshot,
} from "../../context/sections/env-info.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  buildDateChangeReminderBody,
  buildOutputStyleInstructionsBody,
  OUTPUT_STYLE_RESET_REMINDER,
} from "../helpers/runtime-reminders.js";
import { querySourceForTask } from "./turn-model-step-usage.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import { countContextPrefixMessages } from "../deps.js";
import type { Model, OutputStylePromptConfig } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { throwIfTurnAborted } from "../helpers/turn-errors.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  const contextEntries = buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}

// 输入附件中的环境、模型与 output style 指令（environment → model → output_style_instructions）。
// ToolSearch 公告、agent listing、skills 由 turn-loop 紧随其后追加。
export async function appendRuntimeContextAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  model: Model,
  outputStyle: OutputStylePromptConfig | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const last = lastAnnouncedAttachments(state.entries);
  const result = runtime.latestContextBuildResult;
  const attachments: RuntimeAttachmentEntry[] = [];
  if (result?.sections.some((section) => section.source === "env_info")) {
    const previous = environmentOf(last.get("environment"))?.snapshot;
    const snapshot = await resolveCurrentEnvironment(runtime, previous, traceContext, signal);
    const hasFullBlock = state.entries.some((entry) => environmentOf(entry)?.full);
    const announcement = snapshot
      ? buildEnvironmentAnnouncement(snapshot, previous, hasFullBlock)
      : null;
    if (announcement) attachments.push(environmentAttachment(announcement));
    const identity = buildModelSection(model)!;
    if (last.get("model")?.content !== identity.content) {
      attachments.push(systemReminderAttachmentEntry("model", identity.content));
    }
    // output style 只对主线程宣告。内容与最近一次宣告不同时再宣告；
    // 清除风格时，若最近一次宣告的是某个风格，宣告一次重置。
    if (querySourceForTask(runtime.config.taskType) === "main_turn") {
      const previousStyle = last.get("output_style_instructions")?.content;
      const instructions =
        buildOutputStyleInstructionsBody(outputStyle) ??
        (previousStyle === undefined ? undefined : OUTPUT_STYLE_RESET_REMINDER);
      if (instructions !== undefined && instructions !== previousStyle) {
        attachments.push(systemReminderAttachmentEntry("output_style_instructions", instructions));
      }
    }
  }
  throwIfTurnAborted(signal);
  await persistAnnouncements(runtime, state, attachments, traceContext);
}

async function resolveCurrentEnvironment(
  runtime: AgentRuntimeInternal,
  previous: EnvironmentSnapshot | undefined,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<EnvironmentSnapshot | undefined> {
  const initial = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  const additionalWorkingDirectories = runtime.config.additionalDirectories ?? [];
  const baseline =
    previous ?? (initial ? environmentSnapshot(initial, additionalWorkingDirectories) : undefined);
  if (!baseline) return undefined;
  const cwd = runtime.workingDirectory;
  const shell = runtime.config.bashShellSelection?.display.name;
  const port = runtime.contextSourcePort;
  if (cwd === baseline.cwd || !port) {
    const current = {
      ...baseline,
      cwd,
      shell: shell ?? baseline.shell,
      additionalWorkingDirectories: [...additionalWorkingDirectories],
    };
    if (!runtime.repositoryRecheckPending || !port) return current;
    // 修复原因：目录不变时沿用历史，冷恢复后的新 runtime 就一直报告存储里的"是否仓库"；
    // 会话中途 git init 后冷恢复，环境公告仍写 false。新 runtime 第一次公告重读一次，只取是否仓库，
    // 平台、shell、系统版本仍沿用历史。
    const facts = await port.resolveEnvironment(
      { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
      { signal },
    );
    throwIfTurnAborted(signal);
    runtime.repositoryRecheckPending = false;
    return { ...current, isGitRepository: isEnvInfoGitRepository(facts) };
  }
  // 新目录的仓库属性必须重新探测，不能沿用起始目录冻结的 envInfo。
  const facts = await port.resolveEnvironment(
    { workingDirectory: cwd, effectiveShellDisplayName: shell, trace },
    { signal },
  );
  throwIfTurnAborted(signal);
  runtime.repositoryRecheckPending = false;
  // cwd/shell 与事实来自同一次读取，公告自洽。IO 期间的变化不重试：
  // 历史是唯一基线，下一次请求比较最新公告与当前状态时再宣告。
  return environmentSnapshot(
    { ...facts, cwd, shell: shell ?? facts.shell },
    additionalWorkingDirectories,
  );
}

/**
 * 给定历史里没有 skill 列表、且当前目录不为空时返回完整列表。
 * 输入附件收集对比整段历史，compaction 对比保留段（否则 compact 后第一次请求没有 skill 名单）。
 * 目录变化不在这里宣告，由 refreshRestoredAnnouncements 在加载历史时原位更新。
 */
export function collectSkillsListing(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry | undefined {
  const content = currentSkillsListing(runtime);
  if (!content || lastAnnouncedAttachments(entries).has("skills_listing")) return undefined;
  return systemReminderAttachmentEntry("skills_listing", content);
}

// 只在 runtime 启动时读取、加载历史后按当前内容原位更新的公告来源。
const REFRESHED_ON_LOAD_SOURCES: ReadonlySet<string> = new Set([
  "skills_listing",
  "context_prefix",
]);

/**
 * 从库加载历史后（冷恢复、rewind），已恢复的 skill 列表与指令公告（含 Memory 索引）按
 * runtime 当前内容原位更新：内容不同就在原位置改成当前内容，当前为空就删除。
 * 历史里的公告随加载带回；当前为空时没有新内容可宣告，只靠插入新公告撤回不了旧内容。
 * 只改内存，库里的记录只决定位置，每次加载都重新套用。两者都只在 runtime 启动时读取，
 * 运行中不变；内容变化时之前的请求字节变一次，prompt cache 失效一次。
 * 修复原因：指令公告原来恢复后原样保留，模型看到旧的 MEMORY.md，读文件状态却记录磁盘上的
 * 当前内容；Write 的新鲜度检查放行，模型按旧内容写入，会覆盖它没见过的新内容。
 */
export function refreshRestoredAnnouncements(runtime: AgentRuntimeInternal): void {
  const attachments = runtime.latestContextBuildResult?.metaUserAttachments;
  if (!attachments) return;
  const currentContent = (source: string) =>
    attachments.find((item) => item.source === source)?.content;
  const entries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const isStale = (entry: RuntimeMessageEntry) =>
    entry.kind === "attachment" &&
    REFRESHED_ON_LOAD_SOURCES.has(entry.metadata.source) &&
    entry.content !== currentContent(entry.metadata.source);
  if (!entries.some(isStale)) return;
  runtime.messageHistory.replaceMessages(
    entries.flatMap((entry) => {
      if (entry.kind !== "attachment" || !isStale(entry)) return [entry];
      const content = currentContent(entry.metadata.source);
      return content ? [{ ...entry, content }] : [];
    }),
  );
}

function currentSkillsListing(runtime: AgentRuntimeInternal): string | undefined {
  return runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "skills_listing",
  )?.content;
}

export async function appendRuntimeSkillsAnnouncement(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
): Promise<void> {
  const entry = collectSkillsListing(runtime, state.entries);
  await persistAnnouncements(runtime, state, entry ? [entry] : [], traceContext);
}

/**
 * 请求前公告：instructions → session_context → date。
 * 每次模型请求前都运行，不受输入附件的跳过规则影响。
 */
export async function appendRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const sessionContext = await resolveSessionContextAnnouncement(
    runtime,
    state.entries,
    "request",
    traceContext,
    signal,
  );
  await persistAnnouncements(
    runtime,
    state,
    buildRequestAnnouncements(runtime, state.entries, sessionContext),
    traceContext,
  );
}

/**
 * 按给定历史去重后需要宣告的请求前公告；compaction 也用它放置 summary 之前的公告。
 * 指令文件（含 Memory 索引）在 runtime 运行中不变：历史中没有才宣告，不比对内容；
 * 从库加载历史后由 refreshRestoredAnnouncements 原位更新。
 * compact 移除旧公告后按剩余历史重新宣告一次。Git 会话上下文由调用方按同一规则先读好传入。
 */
export function buildRequestAnnouncements(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
): RuntimeAttachmentEntry[] {
  const last = lastAnnouncedAttachments(entries);
  const instructions = runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "context_prefix",
  );
  const attachments =
    instructions && !last.has("context_prefix")
      ? [systemReminderAttachmentEntry("context_prefix", instructions.content)]
      : [];
  if (sessionContext) attachments.push(sessionContext);
  const previousDate = last.get("date");
  // 日期一律取运行时时钟：context snapshot 的日期在会话起点冻结，跨天 compact 后
  // 剩余历史没有日期公告时，回退到它会先宣告一次过期日期。
  const date = formatLocalIsoDate(runtime.now());
  const initialDate = buildCurrentDateSection(date)!.content;
  const changedDate = buildDateChangeReminderBody(date);
  if (previousDate?.content !== initialDate && previousDate?.content !== changedDate) {
    attachments.push(
      systemReminderAttachmentEntry("date", previousDate ? changedDate : initialDate),
    );
  }
  return attachments;
}

/**
 * compaction 放在 summary 之前的请求前公告：保留段已有的来源不重复，date 也按来源判断。
 * date 不比较内容：保留段里是过期日期时，summary 前若再加一条日期变化，
 * 下一次请求又以保留段里的旧日期为基准追加一条，同一请求出现两次。
 */
export function buildCompactLeadingAnnouncements(
  runtime: AgentRuntimeInternal,
  keptEntries: readonly RuntimeMessageEntry[],
  sessionContext?: RuntimeAttachmentEntry,
): RuntimeAttachmentEntry[] {
  const kept = lastAnnouncedAttachments(keptEntries);
  return buildRequestAnnouncements(runtime, keptEntries, sessionContext).filter(
    (entry) => !kept.has(entry.metadata.source),
  );
}

/**
 * compaction 重述环境、模型与 output style 指令：
 * 保留段已有完整环境块或同类公告时不重复；否则取 compact 前最近一次公告。
 * 历史里没有时不重述，由下一次请求的输入附件收集补上。
 * 最近一次 output style 公告是重置时不重述。
 */
export function restateContextAfterCompact(
  runtime: AgentRuntimeInternal,
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  return [
    ...(runtime.latestContextBuildResult?.sections.some((section) => section.source === "env_info")
      ? restateEnvironmentAndModel(preCompactEntries, keptEntries)
      : []),
    ...restateOutputStyle(preCompactEntries, keptEntries),
  ];
}

function restateEnvironmentAndModel(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  const attachments: RuntimeAttachmentEntry[] = [];
  if (!keptEntries.some((entry) => environmentOf(entry)?.full)) {
    const snapshot = preCompactEntries
      .map(environmentOf)
      .findLast((value) => value !== undefined)?.snapshot;
    const announcement = snapshot ? buildEnvironmentAnnouncement(snapshot, undefined, false) : null;
    if (announcement) attachments.push(environmentAttachment(announcement));
  }
  const latestModel = lastAnnouncedAttachments(preCompactEntries).get("model");
  if (latestModel && !lastAnnouncedAttachments(keptEntries).has("model")) {
    attachments.push(systemReminderAttachmentEntry("model", latestModel.content));
  }
  return attachments;
}

// 已恢复和克隆的条目在 hydrate / clone 时校验过 environment 元数据，这里直接读取。
function environmentOf(entry: RuntimeMessageEntry | undefined) {
  return entry?.kind === "attachment" && entry.metadata.source === "environment"
    ? entry.metadata.environment
    : undefined;
}

/** 历史中最近一次环境公告的快照。 */
export function latestAnnouncedEnvironment(entries: readonly RuntimeMessageEntry[]) {
  return environmentOf(lastAnnouncedAttachments(entries).get("environment"))?.snapshot;
}

function environmentAttachment(
  announcement: NonNullable<ReturnType<typeof buildEnvironmentAnnouncement>>,
): RuntimeAttachmentEntry {
  return {
    ...systemReminderAttachmentEntry("environment", announcement.content),
    metadata: { source: "environment", environment: announcement.environment },
  };
}

function restateOutputStyle(
  preCompactEntries: readonly RuntimeMessageEntry[],
  keptEntries: readonly RuntimeMessageEntry[],
): RuntimeAttachmentEntry[] {
  if (lastAnnouncedAttachments(keptEntries).has("output_style_instructions")) return [];
  const latest = lastAnnouncedAttachments(preCompactEntries).get("output_style_instructions");
  return latest && latest.content !== OUTPUT_STYLE_RESET_REMINDER
    ? [systemReminderAttachmentEntry("output_style_instructions", latest.content)]
    : [];
}

/**
 * Git 会话上下文每个窗口（会话开始或 compaction 之后的历史）只决定一次，只看历史：
 * 已有 Git 公告就沿用，什么都不读（切目录也不重读）。请求前已有 date 公告，说明本窗口的首个请求
 * 决定过（决定后同一批写入 date），也什么都不读：当时没有 Git、之后进入仓库或冷恢复后继续都一样。
 * 否则按当前目录读取 Git，是仓库才宣告；不在仓库时不宣告，并记住该目录（是否在仓库由文件系统查找
 * .git 决定，总是确定的）。compaction 为压缩后的历史决定：保留段已有 Git 公告就沿用，否则读取。
 * 新会话初始化时刚读过 Git，只给第一次判断用一次（目录未变时）；恢复的快照来自存储，不算。
 * 读到的 Git 只进入公告，不改 runtime 的 context 快照。
 * 修复原因：原来按「上一次构建结果里有没有 Git 段」决定是否读取；会话从非仓库目录开始，
 * 或在非仓库目录 compact 一次之后，进入仓库也永远不再宣告 Git。现在进入仓库后，从下一个窗口开始宣告。
 * 修复原因（date 判断）：非仓库窗口没有 Git 公告，"已决定"原来只记在 runtime 内存里；冷恢复后的
 * 新 runtime 又读 Git 并宣告，与环境公告里的 "Is a git repository: false" 矛盾。现在恢复的窗口与 live
 * 一样沿用历史、不读 Git；新 runtime 只在环境公告里报告自己读到的是否仓库。
 */
export async function resolveSessionContextAnnouncement(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  occasion: "request" | "compaction",
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<RuntimeAttachmentEntry | undefined> {
  // 子 agent 与自定义 system prompt 不带 Git（与 context builder 的分支相同）。
  if (runtime.config.subagentContext || runtime.config.systemPrompt?.trim()) return undefined;
  // 预取只服务第一次判断，不论这次历史里有没有 Git；否则很久之后的 compaction 会用到旧快照。
  const prefetched = runtime.sessionStartGitPrefetch === true;
  runtime.sessionStartGitPrefetch = false;
  const last = lastAnnouncedAttachments(entries);
  if (last.has("session_context")) return undefined;
  if (occasion === "request" && last.has("date")) return undefined;
  const directory = runtime.workingDirectory;
  // 本 runtime 已确认不是仓库的目录，之后的窗口不再检查。修复原因：不在仓库时每次判断都要跑一次
  // git 检查，慢文件系统上可能等到 git 命令超时。
  if (runtime.nonGitDirectories?.has(directory)) return undefined;
  const snapshot = runtime.contextSourceSnapshot;
  const port = runtime.contextSourcePort;
  if (!snapshot || !port) {
    // 没有 context port 时，会话起始快照是唯一的 Git 来源。
    return startSnapshotSessionContext(runtime);
  }
  if (prefetched && directory === snapshot.workingDirectory) {
    // 修复原因：起始快照原来分不清"确定不是仓库"与"没读到"，为空时不记住，第二个请求还要再查一次。
    // 现在它来自文件系统查找，说"不是仓库"就是确定结论，同样记住目录。
    if (snapshot.envInfo.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
    return startSnapshotSessionContext(runtime);
  }
  const git = await port.resolveGitContext({ workingDirectory: directory, trace }, { signal });
  throwIfTurnAborted(signal);
  const content = buildGitSystemContextSection({ ...snapshot.envInfo, ...git })?.content;
  if (content) return systemReminderAttachmentEntry("session_context", content);
  if (git.isGitRepository === false) rememberNonGitDirectory(runtime, directory);
  return undefined;
}

function rememberNonGitDirectory(runtime: AgentRuntimeInternal, directory: string): void {
  (runtime.nonGitDirectories ??= new Set()).add(directory);
}

function startSnapshotSessionContext(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const content = runtime.latestContextBuildResult?.metaUserAttachments.find(
    (item) => item.source === "session_context",
  )?.content;
  return content ? systemReminderAttachmentEntry("session_context", content) : undefined;
}

function lastAnnouncedAttachments(
  entries: readonly RuntimeMessageEntry[],
): Map<string, RuntimeAttachmentEntry> {
  const last = new Map<string, RuntimeAttachmentEntry>();
  for (const entry of entries) {
    if (entry.kind === "attachment") last.set(entry.metadata.source, entry);
  }
  return last;
}

export async function persistAnnouncements(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  attachments: readonly RuntimeAttachmentEntry[],
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  for (const entry of attachments) {
    // 持久化成功才算已宣告；同一历史同时负责恢复、去重和 provider 投影。
    // 与 ToolSearch 公告、compaction 附件同一种隐藏提醒记录：不写顶层 source，
    // 旧版本 App 按封闭列表校验该字段，新值会让它拒绝整个会话。
    // 隐藏提醒不是对话消息，不移动对话指针（compaction 覆盖边界、timeline 锚点读它）。
    await persistRuntimeReminderMessage.call(runtime, entry, traceContext, {
      model,
      anchor: buildProjectionAnchor(traceContext, "synthetic"),
    });
    commitTurnRequestEntries(runtime, state, [entry]);
  }
}
