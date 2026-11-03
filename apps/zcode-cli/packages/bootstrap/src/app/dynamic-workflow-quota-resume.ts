// ============================================================
// 额度停止的 run 到点自动续跑
// ============================================================
// 规格：apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Resuming after a quota
// reset」。
//
// 问题：子代理撞上 1308 / 1310（5 小时、周 / 月额度用完）时整个 run 停成 stopped(provider)，
// 要人或主代理在额度恢复后手动 ResumeWorkflowRun。实测（2026-10 一位重度用户的 20 天日志）22 个
// run 撞额度停下，17 个是事后手动续跑的，5 个就此搁置。
//
// 做法：停止记录里已经有重置时刻（`failure.providerStop.resetAt`，adapters 的
// inspectWorkflowModelFailure 从 Retry-After 或原文读出）。本模块在它之后
// {@link WORKFLOW_QUOTA_RESUME_MARGIN_MS} 自动续跑。
//
//   - **唯一数据源是 journal 的 run 行**。定时器只是唤醒：到点重新读行，仍是同一个 quota 停止
//     （resetAt 相同）才续跑。期间用户手动 Resume、AmendWorkflow 替换（superseded），或 run 停在
//     了别的原因上，都以行为准，不续跑、不做内存与库的同步。
//   - **两个入口**：本会话 App 构造（冷启动扫描本会话最近的 run：已到点的立即续跑，未到点的排上
//     定时器），与本进程里的 run 结算（subscribeRunSettled）。run 停下之后不再阻止会话被回收，
//     进程内的定时器可能活不到重置时刻；冷启动扫描就是那时的补做——下次打开该会话时续跑。
//   - **不循环**：provider 过了重置时刻仍拒绝、报出同一个（或更早的）重置时刻时不再续跑，只留日志；
//     否则会每隔一个余量就撞一次额度。
//   - **多次续跑拉开间隔**：本进程里同一个 run 每自动续跑一次，下一次最早开始时刻就往后推：距上次
//     开始 {@link WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS} 起、逐次翻倍、封顶
//     {@link WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS}。「不循环」挡的是重置时刻不动；这一条挡的是
//     重置时刻在动、但不对（例如额度停止回了个几秒的 Retry-After），否则会每分钟续跑、撞额度一次。
//     真实的额度窗口相隔数小时，碰不到这个间隔。
//   - **瞬态拒绝有界补做**：resume 回 `already_running` 或抛错（执行边界、关闭竞争）时，隔一个余量
//     再试，最多 {@link WORKFLOW_QUOTA_RESUME_RETRY_LIMIT} 次；每次补做照样先读行。其余拒绝说明 run
//     按原样续不了，不补做。补做用完行仍是额度停止，下次冷启动扫描会再试。
//   - **自愈不拖垮进程**：定时器与结算订阅里的 journal 读取都像冷启动扫描一样收口，读失败只记一条
//     截断过的日志、本次不续跑，异常绝不从定时器回调或订阅回调里逃出去（MR !3072 评审 CR-01）。
//
// 续跑本身由调用方注入（create-app：统一执行边界 → port.resume → runtime 重臂追踪），与 UI 的
// 「恢复」走同一条路，终态通知、后台任务条目与常驻护栏因此都在。

import type {
  DynamicWorkflowRunResumeErrorReason,
  DynamicWorkflowRunResumeResult,
  Logger,
} from "@zcode/contracts";
import type { JournalStorePort, RunRecord } from "@zcode/dynamic-workflow";
import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import { defaultSchedule } from "./workflow-driver-helpers.js";

/** 重置时刻之后再等一分钟：服务端窗口按秒取整，各端时钟也有偏差，早到只会再撞一次额度。 */
export const WORKFLOW_QUOTA_RESUME_MARGIN_MS = 60_000;
/** setTimeout 的上限（约 24.8 天）。月度额度可能更远：到这个上限先醒一次，重新读行再排。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** 冷启动扫描的条数上界：与会话 run 列表的上限同量级，只看最近的。 */
const COLD_START_SCAN_LIMIT = 64;
/** 同一个 run 两次自动续跑之间的最短间隔（第二次起），逐次翻倍到 {@link WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS}。 */
export const WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS = 10 * 60_000;
/** 间隔的上限：小于最短的真实额度窗口（5 小时），正常的续跑永远不会被它推迟。 */
export const WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS = 60 * 60_000;
/** 瞬态拒绝后的补做次数上界；间隔一个 {@link WORKFLOW_QUOTA_RESUME_MARGIN_MS}。 */
export const WORKFLOW_QUOTA_RESUME_RETRY_LIMIT = 2;
/** 会过去的拒绝：同 runId 正在本进程飞行（例如用户同一时刻点了恢复）。其余拒绝都是 run 本身续不了。 */
const TRANSIENT_RESUME_REFUSALS: ReadonlySet<DynamicWorkflowRunResumeErrorReason> = new Set([
  "already_running",
]);
/** 日志里错误文本的上界：存储层的异常文本可能带整段 SQL 或路径。 */
const LOG_ERROR_MESSAGE_MAX_CHARS = 500;

export interface WorkflowQuotaAutoResumeDeps {
  journal: Pick<JournalStorePort, "getRun"> & {
    listRunsByParentSession?: (parentSessionId: string, limit: number) => DwfRunSessionListItem[];
  };
  parentSessionId: string;
  subscribeRunSettled: (listener: (notice: { runId: string }) => void) => () => void;
  /** 续跑一个 run 并重臂追踪（create-app 注入）。 */
  resume: (runId: string) => Promise<DynamicWorkflowRunResumeResult>;
  /** 测试注入；缺省是真时钟与 unref 的 setTimeout。 */
  clock?: { now(): number; schedule(callback: () => void, delayMs: number): () => void };
  logger?: Logger;
}

export interface WorkflowQuotaAutoResume {
  /** App 关闭时调用：退订结算、取消全部定时器。幂等。 */
  dispose(): void;
}

/**
 * 这一行若是「额度停止且带重置时刻」，返回应当续跑的时刻；否则 undefined。纯函数，到点复核与
 * 排定共用它，判据只有一处。
 */
export function quotaResumeAt(
  row: Pick<RunRecord, "status" | "stopReason" | "failure"> | undefined,
): number | undefined {
  if (row?.status !== "stopped" || row.stopReason !== "provider") return undefined;
  const stop = row.failure?.providerStop;
  if (stop?.kind !== "quota" || typeof stop.resetAt !== "number") return undefined;
  return stop.resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS;
}

export function startWorkflowQuotaAutoResume(
  deps: WorkflowQuotaAutoResumeDeps,
): WorkflowQuotaAutoResume {
  const clock = deps.clock ?? { now: () => Date.now(), schedule: defaultSchedule };
  const timers = new Map<string, () => void>();
  /** 本进程里每个 run 最近一次自动续跑所依据的时刻：不前进就不再续跑（见文件头「不循环」）。 */
  const lastResumedAt = new Map<string, number>();
  /** 本进程里每个 run 最近一次自动续跑的开始时刻与累计次数：算下一次的最早时刻（见文件头「拉开间隔」）。 */
  const resumeStarts = new Map<string, { at: number; count: number }>();
  let disposed = false;

  const logContext = (runId: string) => ({
    module: "bootstrap.app",
    parentSessionId: deps.parentSessionId,
    runId,
  });

  /** 读一行；读失败记日志并当作「没有可续的行」，异常不出本模块（见文件头「自愈不拖垮进程」）。 */
  const readRow = (runId: string): RunRecord | undefined => {
    try {
      return deps.journal.getRun(runId);
    } catch (error) {
      deps.logger?.warn?.("Dynamic workflow quota auto-resume could not read the run", {
        ...logContext(runId),
        errorMessage: clippedErrorMessage(error),
        event: "dynamic_workflow.quota_resume.read_failed",
      });
      return undefined;
    }
  };

  const arm = (runId: string, resumeAt: number): void => {
    const previous = lastResumedAt.get(runId);
    if (previous !== undefined && resumeAt <= previous) {
      deps.logger?.warn?.("Dynamic workflow quota auto-resume skipped: reset time did not move", {
        ...logContext(runId),
        event: "dynamic_workflow.quota_resume.not_advancing",
        previousResumeAt: previous,
        resumeAt,
      });
      // 一并撤掉还挂着的补做：resume 报错其实已经跑起来、又停在同一窗口时，补做会再撞一次额度。
      timers.get(runId)?.();
      timers.delete(runId);
      return;
    }
    timers.get(runId)?.();
    const startAt = Math.max(resumeAt, earliestNextStart(runId));
    const delayMs = Math.min(Math.max(0, startAt - clock.now()), MAX_TIMER_DELAY_MS);
    timers.set(
      runId,
      clock.schedule(() => fire(runId, resumeAt, WORKFLOW_QUOTA_RESUME_RETRY_LIMIT), delayMs),
    );
    deps.logger?.info?.("Dynamic workflow quota auto-resume scheduled", {
      ...logContext(runId),
      event: "dynamic_workflow.quota_resume.scheduled",
      resumeAt,
      ...(startAt === resumeAt ? {} : { spacedUntil: startAt }),
    });
  };

  /** 下一次自动续跑最早可以开始的时刻；本进程里没续跑过时不设限。 */
  const earliestNextStart = (runId: string): number => {
    const previous = resumeStarts.get(runId);
    if (previous === undefined) return Number.NEGATIVE_INFINITY;
    const spacing = Math.min(
      WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS * 2 ** (previous.count - 1),
      WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS,
    );
    return previous.at + spacing;
  };

  /** 瞬态失败后隔一个余量补做；不经 arm，因为 lastResumedAt 已记下这个时刻，arm 会当成「不前进」。 */
  const retryLater = (runId: string, resumeAt: number, retriesLeft: number): void => {
    if (disposed) return;
    // 期间结算回调已按新的行排上了定时器：以它为准。
    if (timers.has(runId)) return;
    if (retriesLeft <= 0) {
      deps.logger?.warn?.("Dynamic workflow quota auto-resume gave up after retries", {
        ...logContext(runId),
        event: "dynamic_workflow.quota_resume.gave_up",
        resumeAt,
      });
      return;
    }
    timers.set(
      runId,
      clock.schedule(() => fire(runId, resumeAt, retriesLeft - 1), WORKFLOW_QUOTA_RESUME_MARGIN_MS),
    );
    deps.logger?.info?.("Dynamic workflow quota auto-resume retry scheduled", {
      ...logContext(runId),
      event: "dynamic_workflow.quota_resume.retry_scheduled",
      resumeAt,
      retriesLeft,
    });
  };

  const fire = (runId: string, expectedAt: number, retriesLeft: number): void => {
    timers.delete(runId);
    if (disposed) return;
    const resumeAt = quotaResumeAt(readRow(runId));
    if (resumeAt === undefined) return; // 行已不是额度停止：被手动续跑、替换或停在别处。
    if (resumeAt !== expectedAt || resumeAt > clock.now()) {
      // 行换了一个重置时刻，或只是在定时器上限处醒来：按行重新排。
      arm(runId, resumeAt);
      return;
    }
    lastResumedAt.set(runId, resumeAt);
    resumeStarts.set(runId, {
      at: clock.now(),
      count: (resumeStarts.get(runId)?.count ?? 0) + 1,
    });
    deps.logger?.info?.("Dynamic workflow run auto-resuming after quota reset", {
      ...logContext(runId),
      event: "dynamic_workflow.quota_resume.started",
      resumeAt,
    });
    // 包一层 Promise：注入的 resume 即使同步抛错，也走下面的失败分支，不从定时器回调里逃出去。
    void Promise.resolve()
      .then(() => deps.resume(runId))
      .then(
        (result) => {
          if (result.ok) return;
          deps.logger?.warn?.("Dynamic workflow quota auto-resume was refused", {
            ...logContext(runId),
            event: "dynamic_workflow.quota_resume.refused",
            reason: result.reason,
          });
          if (TRANSIENT_RESUME_REFUSALS.has(result.reason)) {
            retryLater(runId, resumeAt, retriesLeft);
          }
        },
        (error: unknown) => {
          deps.logger?.warn?.("Dynamic workflow quota auto-resume failed", {
            ...logContext(runId),
            errorMessage: clippedErrorMessage(error),
            event: "dynamic_workflow.quota_resume.failed",
          });
          retryLater(runId, resumeAt, retriesLeft);
        },
      );
  };

  const consider = (runId: string, row: Parameters<typeof quotaResumeAt>[0]): void => {
    const resumeAt = quotaResumeAt(row);
    if (resumeAt !== undefined) arm(runId, resumeAt);
  };

  const unsubscribe = deps.subscribeRunSettled(({ runId }) => {
    if (disposed) return;
    consider(runId, readRow(runId));
  });

  // 冷启动扫描：本会话最近的 run 里额度停止的，到点的立即续跑（定时器 0 延迟），未到点的排上。
  if (deps.journal.listRunsByParentSession !== undefined) {
    try {
      for (const row of deps.journal.listRunsByParentSession(
        deps.parentSessionId,
        COLD_START_SCAN_LIMIT,
      )) {
        consider(row.runId, row);
      }
    } catch (error) {
      // 自愈动作不拖垮构造：查不出来就只是不补做，run 仍可手动续跑。
      deps.logger?.warn?.("Dynamic workflow quota auto-resume scan failed", {
        errorMessage: clippedErrorMessage(error),
        event: "dynamic_workflow.quota_resume.scan_failed",
        module: "bootstrap.app",
      });
    }
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const cancel of timers.values()) cancel();
      timers.clear();
    },
  };
}

function clippedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > LOG_ERROR_MESSAGE_MAX_CHARS
    ? `${message.slice(0, LOG_ERROR_MESSAGE_MAX_CHARS)}…`
    : message;
}
