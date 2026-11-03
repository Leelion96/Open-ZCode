// ============================================================
// Dynamic Workflow Run：本会话拥有的 run 的生命周期簿记（结算 / 关闭 / 关闭闸门 / 外来终态行留痕）
// ============================================================
// 拆分原因：dynamic-workflow-run-service.ts 顶到 oxlint max-lines 上限（400 行），把 run 从结算到
// 关闭的这一段生命周期拆到本文件——结算簿记（终态进条目、失败归一、常驻登记、结算通知、终态
// 条目淘汰）与 service 侧关闭和外来终态行检查的闭包。
// 它们只借用 service 的注册表与 journal，经窄依赖递进来；service 文件头的不变式 6、7 仍是它们的规格。

import type { Logger } from "@zcode/contracts";
import type { JournalStorePort, RunSettlement } from "@zcode/dynamic-workflow";
import {
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";

/** 终态 run 在内存注册表里的保留条数（产物只在结算里，journal 不存脚本返回值）。 */
const TERMINAL_REGISTRY_LIMIT = 32;

/** 一个 run 结算后的通知；`liveRunCount` 是通知那一刻本服务名下仍在飞的 run 数。 */
export interface DynamicWorkflowRunSettledNotice {
  runId: string;
  liveRunCount: number;
}

interface RunServiceLifecycleDeps {
  /** 只读 `getRun`：外来终态行的判定要看行上的状态。 */
  journal: Pick<JournalStorePort, "getRun">;
  logger?: Logger;
  parentSessionId: string;
  /** 见 service 的 `DynamicWorkflowRunServiceDeps.registerResidencyBlockingWork`（不变式 6）。 */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /** service 的注册表本体（不是快照）：结算时淘汰旧终态条目、关闭时枚举在飞条目、留痕时置位标记。 */
  runs: Map<string, RunRegistryEntry>;
}

interface RunServiceLifecycle {
  /** 此刻仍未结算的 run 数（registry 里 `terminal === undefined` 的条目）。 */
  countLiveRuns(): number;
  /** 订阅结算通知（簿记之后发；监听器抛错只记日志）。返回退订函数。 */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /** 结算簿记（submit / amend / resume 共享）：终态进条目、失败归一、常驻登记。永不 reject。 */
  trackSettlement(
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement>;
  /** 见 {@link createRunServiceLifecycle} 的 close 说明。幂等。 */
  close(): Promise<void>;
  /** 关闭之后的 launch 是接线错误：抛，而不是给 contracts 的拒绝枚举加成员。 */
  assertOpen(): void;
  trackOperation<T>(operation: () => Promise<T>): Promise<T>;
  /** 活条目下出现终态行 ⇒ 外来写入，每个条目记一条 warn。 */
  noteForeignTerminalRow(runId: string): void;
}

/**
 * 关闭（service 文件头不变式 7）。
 *
 * 引擎是本 App 的闭包（actor runtime、事件链、取消控制器、结算
 * promise 都在这里），App 一关它就没了宿主，可 journal 行还停在 running——下一次激活只能
 * 靠孤儿收敛去猜。所以关闭要**主动停**：以 `"interrupted"` abort 每个在飞条目，harness 归一
 * 成 `engine.stop("interrupted", Interrupted)`，行由引擎自己写成可 resume 的 stopped。
 *
 * 无超时地等：harness 收到 stop 后同步结算，而「等前驱自己的结算 promise」正是 amend 早已
 * 在用的那条纪律（绝不用定时器替代状态）。结算 promise 永不 reject（见 {@link RunServiceLifecycle.trackSettlement}）。
 */
export function createRunServiceLifecycle(deps: RunServiceLifecycleDeps): RunServiceLifecycle {
  const { runs } = deps;
  const terminalOrder: string[] = [];
  const cleanup = new Set<Promise<void>>();
  const unreleased = new Set<RunRegistryEntry>();
  const operations = new Set<Promise<unknown>>();
  const settledListeners = new Set<(notice: DynamicWorkflowRunSettledNotice) => void>();
  const countLiveRuns = (): number => {
    let live = 0;
    for (const entry of runs.values()) if (entry.terminal === undefined) live += 1;
    return live;
  };
  // 结算通知在簿记**之后**发：监听器（宿主的 registry 安全边界）读到的计数必须已经扣掉本 run。
  const notifySettled = (runId: string): void => {
    if (settledListeners.size === 0) return;
    const notice: DynamicWorkflowRunSettledNotice = { runId, liveRunCount: countLiveRuns() };
    for (const listener of settledListeners) {
      try {
        listener(notice);
      } catch (error: unknown) {
        deps.logger?.warn?.("Dynamic workflow run settled listener threw", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.settled_listener_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    }
  };
  const subscribeRunSettled = (
    listener: (notice: DynamicWorkflowRunSettledNotice) => void,
  ): (() => void) => {
    settledListeners.add(listener);
    return () => {
      settledListeners.delete(listener);
    };
  };

  const rememberTerminal = (runId: string): void => {
    terminalOrder.push(runId);
    while (terminalOrder.length > TERMINAL_REGISTRY_LIMIT) {
      const evicted = terminalOrder.shift();
      if (evicted !== undefined && runs.get(evicted)?.terminal !== undefined) runs.delete(evicted);
    }
  };

  /**
   * 结算簿记（submit 与 resume 共享）：终态进条目、失败归一。
   * harness 之外的失败（引擎构造抛错等）归一成 errored 终态：绝不编码成 stopped——journal 里
   * 两者语义与 resume UX 不同（stopped 可恢复，errored 只能修订）。
   */
  const trackSettlement = (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement> => {
    const settlement = launched.then(
      (result) => {
        entry.terminal = result;
        entry.completedAt = new Date();
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger?.warn?.("Dynamic workflow run failed before settling", {
          errorMessage: message,
          event: "dynamic_workflow.run.start_failed",
          module: "bootstrap.app",
          runId,
        });
        entry.completedAt = new Date();
        const result: RunSettlement = {
          status: "errored",
          error: error instanceof Error ? (error as never) : (new Error(message) as never),
        };
        entry.terminal = result;
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
    );
    // service 文件头不变式 6：三条入口（submit / amend / resume）共用这一个登记点，且必须在 launch 的
    // 同一同步片登记——晚一个微任务，一次常驻再平衡就能落在启动与登记之间。登记的是**结算后**
    // 的 promise（`settlement` 永不 reject，簿记已做完），计数随它的 finally 释放。
    // run terminal 与 actor drain 不同；独立保留未完成清理，不能随 terminal registry 淘汰。
    const released = settlement.then(() => entry.quiescence?.drain());
    unreleased.add(entry);
    cleanup.add(released);
    void released.then(
      () => {
        cleanup.delete(released);
        unreleased.delete(entry);
      },
      () => {
        cleanup.delete(released);
      },
    );
    deps.registerResidencyBlockingWork?.(released.catch(() => undefined));
    return settlement;
  };

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // 幂等 + **同步**置位：`closed` 必须在本同步片就为真，否则关闭期间到达的一次 launch
    // 会溜进来，造出一个没人拥有的引擎。
    closePromise ??= (async () => {
      closed = true;
      const live = [...deps.runs.values()].filter((entry) => entry.terminal === undefined);
      deps.logger?.info?.("Dynamic workflow run service closing", {
        event: "dynamic_workflow.service.closing",
        liveRunCount: live.length,
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
      });
      for (const entry of live) entry.controller.abort("interrupted");
      while (operations.size) await Promise.allSettled(operations);
      await Promise.all(live.map((entry) => entry.settlement));
      while (cleanup.size > 0) await Promise.allSettled(cleanup);
      const results = await Promise.allSettled(
        [...unreleased].map(async (entry) => {
          await entry.quiescence?.drain();
          unreleased.delete(entry);
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Workflow actor cleanup failed");
      deps.logger?.info?.("Dynamic workflow run service closed", {
        event: "dynamic_workflow.service.closed",
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
        stoppedRunCount: live.length,
      });
    })().catch((error) => {
      // unreleased 保留失败的 actor；不能把 rejected flight 当作永久关闭结果。
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  };

  /**
   * 关闭之后的 launch 是**接线错误**，不是业务拒绝：常驻池的关闭闸门已经挡住了命令面，能走到
   * 这里说明有人绕过了它。所以抛，而不是给 contracts 的拒绝枚举加一个成员——那会让每个调用方
   * 都要处理一个正常运行中永不出现的分支。
   */
  const assertOpen = (): void => {
    if (closed) {
      throw new Error(
        "dynamic workflow run service is closed; a launch after App close is a wiring fault",
      );
    }
  };

  /**
   * 活条目下出现终态行 ⇒ 外来写入，每个条目记一条 warn。
   *
   * 第二个桌面实例冷恢复了同一个会话，它的孤儿收敛把本
   * 进程仍在跑的 run 写成终态行。读面已经按 {@link RunRegistryEntry} 的活条目忽略它
   * （observation 的 synthesizeRunStatus），但这件事本身必须留痕——否则「两个实例互相踩」只能
   * 靠事后猜。
   *
   * 每条目一次：追踪器每秒轮询一次 `getTask`，不设标记就是每秒一条同样的 warn。标记未置位时
   * 多读一次 `getRun`（索引单行查询），置位后连这一次也省掉。
   */
  const noteForeignTerminalRow = (runId: string): void => {
    const entry = deps.runs.get(runId);
    if (entry === undefined || entry.terminal !== undefined || entry.foreignTerminalLogged) return;
    const record = deps.journal.getRun(runId);
    if (record === undefined || !TERMINAL_RUN_STATUSES.has(record.status)) return;
    entry.foreignTerminalLogged = true;
    deps.logger?.warn?.("Dynamic workflow run has a foreign terminal row under a live engine", {
      event: "dynamic_workflow.run.foreign_terminal_row",
      journalStatus: record.status,
      module: "bootstrap.app",
      runId,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
    });
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    trackOperation<T>(operation: () => Promise<T>): Promise<T> {
      assertOpen();
      const work = operation();
      operations.add(work);
      void work.then(
        () => operations.delete(work),
        () => operations.delete(work),
      );
      return work;
    },
    noteForeignTerminalRow,
  };
}
