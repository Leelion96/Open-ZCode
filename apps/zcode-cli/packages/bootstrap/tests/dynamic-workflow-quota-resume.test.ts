/**
 * 额度停止的 run 到点自动续跑（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
 * 「Resuming after a quota reset」）。
 *
 * 唯一数据源是 journal 的 run 行；定时器只是唤醒，到点重新读行再决定。这里用假时钟与假 journal
 * 钉住：冷启动扫描、本进程结算后排定、到点复核、行变了不续跑、重置时刻不前进不再续跑、dispose，
 * 以及 MR !3072 评审补的两条：journal 读失败不逃出回调（CR-01）、瞬态拒绝有界补做（SG-01）。
 */

import { describe, expect, it, vi } from "vitest";
import type { DynamicWorkflowRunResumeResult } from "@zcode/contracts";
import type { RunRecord } from "@zcode/dynamic-workflow";
import {
  WORKFLOW_QUOTA_RESUME_MARGIN_MS,
  WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS,
  WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS,
  WORKFLOW_QUOTA_RESUME_RETRY_LIMIT,
  startWorkflowQuotaAutoResume,
} from "../src/app/dynamic-workflow-quota-resume.js";

const SESSION = "sess-quota";
const HOUR = 60 * 60 * 1000;

/** 从 resetAt 起按余量逐步推进 steps 个余量：补做定时器是在触发中、相对当时的时钟排的。 */
async function stepThrough(
  h: { advanceTo(at: number): Promise<void> },
  resetAt: number,
  steps: number,
): Promise<void> {
  for (let step = 1; step <= steps; step += 1) {
    await h.advanceTo(resetAt + step * WORKFLOW_QUOTA_RESUME_MARGIN_MS);
  }
}

/** 让 resume 的 promise 链（含 Promise.resolve 包装与 then 回调）走完。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function quotaStopped(runId: string, resetAt: number | undefined): RunRecord {
  return {
    runId,
    status: "stopped",
    stopReason: "provider",
    parentSessionId: SESSION,
    failure: {
      code: "ProviderStop",
      message: "quota",
      providerStop: {
        kind: "quota",
        reason: "rate_limited",
        providerCode: "1308",
        ...(resetAt === undefined ? {} : { resetAt }),
      },
    },
  } as unknown as RunRecord;
}

interface HarnessOptions {
  /** 缺省：把行改成 running 并回 ok（与真实 resume 的效果一致）。 */
  resume?: (runId: string) => Promise<DynamicWorkflowRunResumeResult>;
}

function harness(initial: RunRecord[] = [], options: HarnessOptions = {}) {
  let now = Date.parse("2026-10-19T08:00:00.000Z");
  const rows = new Map(initial.map((row) => [row.runId, row]));
  /** 置上后 getRun 抛它：模拟 journal 关闭、SQLite 句柄异常。 */
  let readError: Error | undefined;
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const listeners: ((notice: { runId: string; liveRunCount: number }) => void)[] = [];
  const resumed: string[] = [];
  const clock = {
    now: () => now,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { at: now + delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  const service = startWorkflowQuotaAutoResume({
    journal: {
      getRun: (runId: string) => {
        if (readError !== undefined) throw readError;
        return rows.get(runId);
      },
      listRunsByParentSession: (sessionId: string) =>
        [...rows.values()].filter((row) => row.parentSessionId === sessionId) as never,
    },
    parentSessionId: SESSION,
    subscribeRunSettled: (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    resume: async (runId) => {
      resumed.push(runId);
      if (options.resume !== undefined) return options.resume(runId);
      const row = rows.get(runId);
      if (row) rows.set(runId, { ...row, status: "running", stopReason: undefined } as RunRecord);
      return { ok: true, runId, status: "backgrounded" } as never;
    },
    clock,
    logger: logger as never,
  });
  /** 把时钟拨到 at，依次触发到期的定时器（触发中新排的也算）。 */
  const advanceTo = async (at: number) => {
    now = at;
    for (;;) {
      const due = timers.find((timer) => !timer.cancelled && timer.at <= now);
      if (due === undefined) break;
      due.cancelled = true;
      due.callback();
      await flush();
    }
    await flush();
  };
  const settle = (row: RunRecord) => {
    rows.set(row.runId, row);
    for (const listener of [...listeners]) listener({ runId: row.runId, liveRunCount: 0 });
  };
  /** 记下的事件名（info / warn 的第二个参数里的 event）。 */
  const events = () =>
    [...logger.info.mock.calls, ...logger.warn.mock.calls].map(
      (call) => (call[1] as { event?: string } | undefined)?.event,
    );
  return {
    advanceTo,
    events,
    failReads: (error: Error | undefined) => {
      readError = error;
    },
    listeners,
    logger,
    now: () => now,
    resumed,
    rows,
    service,
    settle,
    pendingTimers: () => timers.filter((timer) => !timer.cancelled),
  };
}

describe("workflow quota auto-resume", () => {
  it("resumes a run stopped by quota a margin after its reset time", async () => {
    const h = harness();
    const resetAt = h.now() + 2 * HOUR;
    h.settle(quotaStopped("run-a", resetAt));

    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS - 1);
    expect(h.resumed).toEqual([]);
    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-a"]);
  });

  it("on start, resumes the session's quota-stopped runs that are due, and arms the rest", async () => {
    const base = Date.parse("2026-10-19T08:00:00.000Z");
    const h = harness([
      quotaStopped("run-due", base - HOUR),
      quotaStopped("run-later", base + HOUR),
      { ...quotaStopped("run-other-session", base - HOUR), parentSessionId: "sess-x" },
    ]);

    await h.advanceTo(base);
    expect(h.resumed).toEqual(["run-due"]);
    await h.advanceTo(base + HOUR + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-due", "run-later"]);
  });

  it("does nothing for a quota stop without a reset time, or a stop for another reason", async () => {
    const h = harness();
    h.settle(quotaStopped("run-no-reset", undefined));
    h.settle({
      ...quotaStopped("run-auth", h.now() + HOUR),
      failure: {
        code: "ProviderStop",
        message: "auth",
        providerStop: { kind: "auth", reason: "auth_failed", resetAt: h.now() + HOUR },
      },
    } as unknown as RunRecord);
    h.settle({ ...quotaStopped("run-user", h.now() + HOUR), stopReason: "user" } as RunRecord);

    await h.advanceTo(h.now() + 10 * HOUR);
    expect(h.resumed).toEqual([]);
    expect(h.pendingTimers()).toHaveLength(0);
  });

  it("re-reads the row when the timer fires: a run resumed or amended meanwhile is left alone", async () => {
    const h = harness();
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));
    h.rows.set("run-a", { ...h.rows.get("run-a")!, stopReason: "superseded" } as RunRecord);

    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual([]);
  });

  it("does not resume again when the run stops on the same reset time", async () => {
    const h = harness();
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));
    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-a"]);

    // provider 过了重置时刻仍拒绝、报同一个时刻：不再续跑，否则会一分钟一次地循环。
    h.settle(quotaStopped("run-a", resetAt));
    await h.advanceTo(h.now() + 10 * HOUR);
    expect(h.resumed).toEqual(["run-a"]);

    // 下一个窗口（重置时刻前进了）照常续跑。
    const nextReset = h.now() + HOUR;
    h.settle(quotaStopped("run-a", nextReset));
    await h.advanceTo(nextReset + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-a", "run-a"]);
  });

  // MR !3072 第 2 轮评审 SG-01 引出的下限：额度停止回了个几秒的 Retry-After，重置时刻每次都「前进」，
  // 不循环规则挡不住；间隔逐次翻倍、封顶，避免每分钟续跑一次、撞额度一次。
  it("spaces repeated resumes of a run whose reset time keeps moving by seconds", async () => {
    const h = harness();
    const starts: number[] = [];
    let resetAt = h.now() + 5_000;
    h.settle(quotaStopped("run-a", resetAt));
    for (let round = 0; round < 6; round += 1) {
      // 推进到下一次续跑（逐分钟走，最多两小时）。
      const before = h.resumed.length;
      for (let step = 0; step < 120 && h.resumed.length === before; step += 1) {
        await h.advanceTo(h.now() + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
      }
      expect(h.resumed.length).toBe(before + 1);
      starts.push(h.now());
      // 续跑后马上又撞额度，provider 又报「5 秒后重置」。
      resetAt = h.now() + 5_000;
      h.settle(quotaStopped("run-a", resetAt));
    }
    const gaps = starts.slice(1).map((at, index) => at - starts[index]!);
    const minute = WORKFLOW_QUOTA_RESUME_MARGIN_MS;
    // 第二次起：10、20、40 分钟，之后封顶 60 分钟（逐分钟推进，允许一分钟的粒度）。
    expect(WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS).toBe(10 * minute);
    expect(WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS).toBe(60 * minute);
    const expected = [10, 20, 40, 60, 60].map((minutes) => minutes * minute);
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(expected[index]!);
      expect(gap).toBeLessThanOrEqual(expected[index]! + minute);
    });
    expect(h.events()).toContain("dynamic_workflow.quota_resume.scheduled");
  });

  it("does not delay a real next quota window, hours later", async () => {
    const h = harness();
    const first = h.now() + HOUR;
    h.settle(quotaStopped("run-a", first));
    await h.advanceTo(first + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    for (const hours of [5, 10]) {
      const next = first + hours * HOUR;
      h.settle(quotaStopped("run-a", next));
      await h.advanceTo(next + WORKFLOW_QUOTA_RESUME_MARGIN_MS - 1);
      const before = h.resumed.length;
      await h.advanceTo(next + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
      expect(h.resumed.length).toBe(before + 1);
    }
  });

  it("keeps a reset more than 24 days away correct across the timer ceiling", async () => {
    const h = harness();
    const resetAt = h.now() + 30 * 24 * HOUR;
    h.settle(quotaStopped("run-monthly", resetAt));

    await h.advanceTo(h.now() + 25 * 24 * HOUR);
    expect(h.resumed).toEqual([]);
    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-monthly"]);
  });

  it("stops listening and cancels its timers on dispose", async () => {
    const h = harness();
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));
    h.service.dispose();
    expect(h.listeners).toHaveLength(0);

    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual([]);
  });

  it("logs and survives a refused resume", async () => {
    const warn = vi.fn();
    const rows = new Map([["run-a", quotaStopped("run-a", 0)]]);
    let fire: (() => void) | undefined;
    startWorkflowQuotaAutoResume({
      journal: { getRun: (runId: string) => rows.get(runId) },
      parentSessionId: SESSION,
      subscribeRunSettled: (listener) => {
        queueMicrotask(() => listener({ runId: "run-a", liveRunCount: 0 }));
        return () => {};
      },
      resume: async () => ({ ok: false, reason: "already_running" }) as never,
      clock: {
        now: () => WORKFLOW_QUOTA_RESUME_MARGIN_MS,
        schedule: (callback) => {
          fire = callback;
          return () => {};
        },
      },
      logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
    });
    await Promise.resolve();
    fire?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith(
      "Dynamic workflow quota auto-resume was refused",
      expect.objectContaining({ reason: "already_running", runId: "run-a" }),
    );
  });

  // CR-01：定时器回调与结算订阅里的 journal 读取失败，只记日志、本次不续跑，异常不逃出回调。
  it("survives a journal read that throws when the timer fires", async () => {
    const h = harness();
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));
    h.failReads(new Error(`SQLITE_MISUSE: database is closed ${"x".repeat(2_000)}`));

    await expect(h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS)).resolves.toBeUndefined();
    expect(h.resumed).toEqual([]);
    expect(h.pendingTimers()).toHaveLength(0);
    const readFailed = h.logger.warn.mock.calls.find(
      (call) =>
        (call[1] as { event?: string }).event === "dynamic_workflow.quota_resume.read_failed",
    );
    expect(readFailed?.[1]).toMatchObject({ runId: "run-a" });
    // 日志里的错误文本截断过：存储异常可能带很长的上下文。
    const message = (readFailed?.[1] as { errorMessage: string }).errorMessage;
    expect(message.startsWith("SQLITE_MISUSE")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(501);
  });

  it("survives a journal read that throws on run-settled", () => {
    const h = harness();
    h.failReads(new Error("database is closed"));
    expect(() => h.settle(quotaStopped("run-a", h.now() + HOUR))).not.toThrow();
    expect(h.pendingTimers()).toHaveLength(0);
    expect(h.events()).toContain("dynamic_workflow.quota_resume.read_failed");
  });

  // SG-01：瞬态拒绝（already_running）或 resume 抛错时有界补做；其余拒绝不补做。
  it("retries after a transient refusal and resumes", async () => {
    let calls = 0;
    const h = harness([], {
      resume: async (runId) => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: "already_running" };
        return { ok: true, runId };
      },
    });
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));

    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-a"]);
    expect(h.events()).toContain("dynamic_workflow.quota_resume.retry_scheduled");
    await h.advanceTo(resetAt + 2 * WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-a", "run-a"]);
    expect(h.pendingTimers()).toHaveLength(0);
  });

  it("retries a resume that throws a bounded number of times, then gives up", async () => {
    const h = harness([], {
      resume: async () => {
        throw new Error("execution boundary failed");
      },
    });
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));

    await stepThrough(h, resetAt, 10);
    expect(h.resumed).toHaveLength(1 + WORKFLOW_QUOTA_RESUME_RETRY_LIMIT);
    expect(h.events()).toContain("dynamic_workflow.quota_resume.gave_up");
    expect(h.pendingTimers()).toHaveLength(0);
  });

  it("does not retry a refusal that says the run cannot be resumed", async () => {
    const h = harness([], {
      resume: async () => ({ ok: false, reason: "not_resumable" }),
    });
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));

    await stepThrough(h, resetAt, 10);
    expect(h.resumed).toEqual(["run-a"]);
    expect(h.pendingTimers()).toHaveLength(0);
  });

  it("re-reads the row on a retry: a run that started meanwhile is left alone", async () => {
    const rows: { current?: Map<string, RunRecord> } = {};
    const h = harness([], {
      resume: async (runId) => {
        // 用户同一时刻点了恢复：run 已在飞，自动续跑被拒为 already_running。
        const row = rows.current!.get(runId)!;
        rows.current!.set(runId, { ...row, status: "running", stopReason: undefined } as RunRecord);
        return { ok: false, reason: "already_running" };
      },
    });
    rows.current = h.rows;
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));

    await stepThrough(h, resetAt, 10);
    expect(h.resumed).toEqual(["run-a"]);
    expect(h.pendingTimers()).toHaveLength(0);
  });

  it("drops a pending retry when the run stops again on the same reset time", async () => {
    const rows: { current?: Map<string, RunRecord> } = {};
    const h = harness([], {
      resume: async (runId) => {
        // resume 报错，但 run 其实已经跑起来了（例如重臂追踪那一步失败）。
        const row = rows.current!.get(runId)!;
        rows.current!.set(runId, { ...row, status: "running", stopReason: undefined } as RunRecord);
        throw new Error("track failed");
      },
    });
    rows.current = h.rows;
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));
    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.pendingTimers()).toHaveLength(1);

    // 补做到点前，run 又停在同一窗口：不前进，补做一并撤掉，不再撞一次额度。
    h.settle(quotaStopped("run-a", resetAt));
    expect(h.pendingTimers()).toHaveLength(0);
    await stepThrough(h, resetAt, 10);
    expect(h.resumed).toEqual(["run-a"]);
  });

  it("does not schedule a retry when disposed while a resume is in flight", async () => {
    let refuse: ((result: DynamicWorkflowRunResumeResult) => void) | undefined;
    const h = harness([], {
      resume: () =>
        new Promise((resolve) => {
          refuse = resolve;
        }),
    });
    const resetAt = h.now() + HOUR;
    h.settle(quotaStopped("run-a", resetAt));
    await h.advanceTo(resetAt + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    expect(h.resumed).toEqual(["run-a"]);

    h.service.dispose();
    refuse?.({ ok: false, reason: "already_running" });
    await flush();
    expect(h.pendingTimers()).toHaveLength(0);
  });
});
