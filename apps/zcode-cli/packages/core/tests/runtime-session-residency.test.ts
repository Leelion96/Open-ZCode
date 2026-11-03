import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSessionId, createTraceId, createTurnId, type TraceContext } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskType } from "../src/runtime-task/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function createRuntime(
  suffix: string,
  registry = new InMemoryRuntimeTaskRegistry(),
): { registry: InMemoryRuntimeTaskRegistry; runtime: AgentRuntime } {
  const sessionId = createSessionId(`runtime-residency-${suffix}`);
  return {
    registry,
    runtime: createTestAgentRuntime(
      sessionId,
      { workingDirectory: "/tmp/zcode-runtime-residency" },
      {
        eventStore: createTestSessionEventStore(),
        runtimeTaskRegistry: registry,
      },
    ),
  };
}

describe("AgentRuntime session residency facts", () => {
  it("idle runtime 没有 active/queued work 或 running background work", () => {
    const { runtime } = createRuntime("idle");

    expect(runtime.hasActiveOrQueuedTurnWork()).toBe(false);
    expect(runtime.hasRunningBackgroundTasks()).toBe(false);
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it("turn-start reservation 在真正 active turn 建立前也保护 runtime", () => {
    const { runtime } = createRuntime("reservation");
    const sessionId = createSessionId("runtime-residency-reservation");
    const turnId = createTurnId("runtime-residency-reservation-turn");
    const traceContext: TraceContext = {
      sessionId,
      traceId: createTraceId("runtime-residency-reservation-trace"),
    };
    const reservationRuntime = runtime as AgentRuntime & {
      releaseTurnStart(turnId: typeof turnId): void;
      reserveTurnStart(turnId: typeof turnId, traceContext: TraceContext, kind: "regular"): void;
    };

    reservationRuntime.reserveTurnStart(turnId, traceContext, "regular");
    expect(runtime.hasActiveOrQueuedTurnWork()).toBe(true);
    expect(runtime.hasResidencyBlockingWork()).toBe(true);

    reservationRuntime.releaseTurnStart(turnId);
    expect(runtime.hasActiveOrQueuedTurnWork()).toBe(false);
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it.each([
    ["background subagent", "local_agent"],
    ["background Bash", "local_bash"],
    ["background Workflow", "local_workflow"],
    ["background MCP monitor", "monitor_mcp"],
  ] as const)(
    "%s 的 running registry task 保护 runtime，终态后解除",
    (_label, taskType: RuntimeTaskType) => {
      const { registry, runtime } = createRuntime(taskType);
      registry.register({
        isBackgrounded: true,
        sessionId: createSessionId(`runtime-residency-${taskType}`),
        startedAt: new Date(1),
        status: "running",
        taskId: `background-${taskType}`,
        type: taskType,
      });

      expect(runtime.hasRunningBackgroundTasks()).toBe(true);
      expect(runtime.hasResidencyBlockingWork()).toBe(true);

      registry.update(`background-${taskType}`, (task) => ({
        ...task,
        completedAt: new Date(2),
        status: "completed",
      }));
      expect(runtime.hasRunningBackgroundTasks()).toBe(false);
      expect(runtime.hasResidencyBlockingWork()).toBe(false);
    },
  );

  // 不再经 cast：登记口在公开 AgentRuntime 面上（runtime 之外的 sidecar——dwf 引擎——也要用它，
  // 见 execution-engine.md「Engine ownership」规则一），这一行同时钉住那个暴露。
  it("detached sidecar 从同步登记到 promise finally 全程保护 runtime", async () => {
    const { runtime } = createRuntime("detached-sidecar");
    const sidecar = deferred<void>();

    const tracked = runtime.trackResidencyBlockingWork(sidecar.promise);
    expect(runtime.hasResidencyBlockingWork()).toBe(true);

    sidecar.resolve();
    await tracked;
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it("memory extraction 与 recall prefetch 的既有状态进入统一保护事实", () => {
    const { runtime } = createRuntime("memory-work");
    const internal = runtime as unknown as {
      memoryExtractionScheduler?: { hasPendingWork(): boolean };
      memoryRecallPrefetch?: { settled: boolean };
    };

    internal.memoryExtractionScheduler = { hasPendingWork: () => true };
    expect(runtime.hasResidencyBlockingWork()).toBe(true);
    internal.memoryExtractionScheduler = undefined;

    internal.memoryRecallPrefetch = { settled: false };
    expect(runtime.hasResidencyBlockingWork()).toBe(true);
    internal.memoryRecallPrefetch.settled = true;
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("runtime cleanup failure visibility", () => {
  it("propagates browser cleanup failure to the lifecycle resource owner", async () => {
    const runtime = createTestAgentRuntime(
      createSessionId("cleanup-browser"),
      { workingDirectory: "/workspace" },
      {
        eventStore: createTestSessionEventStore(),
        browserControlPort: {
          execute: async () => {
            throw new Error("unused");
          },
          closeSession: async () => {
            throw new Error("browser cleanup failed");
          },
        },
      },
    );
    await expect(runtime.closeBrowserSession()).rejects.toThrow("browser cleanup failed");
  });
});

it("owner close drains late registered work and leaves another runtime usable", async () => {
  const { runtime } = createRuntime("close-drain");
  const other = createRuntime("other").runtime;
  let release!: () => void;
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseTail!: () => void;
  const tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  void runtime.trackResidencyBlockingWork(
    work.then(() => {
      void runtime.trackResidencyBlockingWork(tail);
    }),
  );
  let closed = false;
  const closing = runtime.closeOwnedWork().then(() => {
    closed = true;
  });
  release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(closed).toBe(false);
  expect(other.hasResidencyBlockingWork()).toBe(false);
  releaseTail();
  await closing;
  expect(runtime.hasResidencyBlockingWork()).toBe(false);
  await other.trackResidencyBlockingWork(Promise.resolve());
});

it("background cleanup failure still waits for other cancellations", async () => {
  const { runtime, registry } = createRuntime("background-drain");
  for (const taskId of ["failed", "pending"])
    registry.register({
      taskId,
      type: "local_bash",
      isBackgrounded: true,
      status: "running",
      sessionId: createSessionId("background-drain"),
      startedAt: new Date(),
    });
  const tail = deferred<void>();
  const started = deferred<void>();
  runtime.stopBackgroundTask = async (id) => {
    if (id === "failed") throw new Error("cancel failed");
    started.resolve();
    await tail.promise;
    return { ok: true, taskId: String(id), type: "local_bash", status: "cancelled" };
  };
  let settled = false;
  const closing = runtime.cancelRunningRuntimeBackgroundTasks({ reason: "session_closed" });
  const checked = expect(closing).rejects.toThrow();
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  tail.resolve();
  await checked;
});

it("retirement waits for background work, then releases resources without parent shutdown", async () => {
  const { runtime, registry } = createRuntime("retire");
  const close = vi.spyOn(runtime, "closeBrowserSession").mockResolvedValue();
  registry.register({
    taskId: "bash",
    type: "local_bash",
    isBackgrounded: true,
    sessionId: createSessionId("retire"),
    startedAt: new Date(),
    status: "running",
  });
  const tail = deferred<void>();
  void runtime.trackResidencyBlockingWork(tail.promise);
  const retired = runtime.retire();
  registry.update("bash", (task) => ({ ...task, status: "completed" }));
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  tail.resolve();
  await retired;
  expect(close).toHaveBeenCalledOnce();
});

it("owner close cancels a retiring child's background work and shares its resource release", async () => {
  const { runtime, registry } = createRuntime("retire-cancel");
  const browser = vi.spyOn(runtime, "closeBrowserSession").mockResolvedValue();
  registry.register({
    taskId: "bash",
    type: "local_bash",
    isBackgrounded: true,
    sessionId: createSessionId("retire"),
    startedAt: new Date(),
    status: "running",
  });
  vi.spyOn(runtime, "stopBackgroundTask").mockImplementation(async () => {
    registry.update("bash", (task) => ({ ...task, status: "cancelled" }));
    return { ok: true, taskId: "bash", type: "local_bash", status: "cancelled" };
  });
  const retired = runtime.retire();
  await runtime.close();
  await retired;
  expect(browser).toHaveBeenCalledOnce();
});

it("natural child retirement waits beyond background terminal status for the actual event write", async () => {
  const { runtime, registry } = createRuntime("background-write");
  const terminal = deferred<{ status: string; taskId: string }>();
  const writing = deferred<void>();
  const written = deferred<void>();
  const browser = vi.spyOn(runtime, "closeBrowserSession").mockResolvedValue();
  const tracker = new BackgroundTaskTracker({
    sessionId: runtime.sessionId,
    runtimeTaskRegistry: registry,
    executionPort: { waitForBackgroundTask: () => terminal.promise },
    shouldEnqueueBackgroundTaskNotification: () => false,
    registerResidencyBlockingWork: (work: Promise<void>) => {
      void runtime.trackResidencyBlockingWork(work);
    },
    emitEvent: async (event: SessionEvent) => {
      if (event.type === SessionEventType.BackgroundTaskCompleted) {
        writing.resolve();
        await written.promise;
      }
    },
  } as never);
  await tracker.trackBackgroundTask(
    { id: "bash-call", name: "Bash", input: { command: "echo done" } } as never,
    { status: "backgrounded", backgroundTaskId: "bash-task" },
    runtime.rootTraceContext,
    undefined,
  );
  const retired = runtime.retire();
  terminal.resolve({ status: "completed", taskId: "bash-task" });
  await writing.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(browser).not.toHaveBeenCalled();
  written.resolve();
  await retired;
  expect(browser).toHaveBeenCalledOnce();
});

it("最终 owner 可以重试失败的所属工作；成功的浏览器释放不会重复", async () => {
  const { runtime } = createRuntime("owner-retry");
  const work = vi
    .spyOn(runtime, "cancelRunningRuntimeBackgroundTasks")
    .mockRejectedValueOnce(new Error("child cleanup failed"))
    .mockResolvedValue();
  const browser = vi.spyOn(runtime, "closeBrowserSession").mockResolvedValue();
  await expect(runtime.close()).rejects.toThrow("Runtime cleanup failed");
  await runtime.close();
  await runtime.close();
  expect(work).toHaveBeenCalledTimes(2);
  expect(browser).toHaveBeenCalledOnce();
});
