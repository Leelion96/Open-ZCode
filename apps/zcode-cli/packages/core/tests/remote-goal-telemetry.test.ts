import { beforeEach, expect, it, vi } from "vitest";
import { runActiveTargetContinuationLoop } from "../src/runtime/methods/target-continuation-loop.js";
import { executeTargetContinuationCommand } from "../src/runtime/methods/target.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { TELEMETRY_INPUT_ORIGIN_ATTRIBUTE } from "../src/runtime/methods/input-intent-persistence.js";
vi.mock("../src/runtime/methods/target.js", () => ({ executeTargetContinuationCommand: vi.fn() }));
it("goal 首轮 intent 清理后，后续自动轮仍保留手机因果来源", async () => {
  const execute = vi.mocked(executeTargetContinuationCommand);
  execute
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce(null);
  const traceContext = { traceId: "trace", spanId: "span", attributes: {} };
  await runActiveTargetContinuationLoop.call(
    { runtimeCommandQueue: { hasPending: () => false }, config: {} } as AgentRuntimeInternal,
    {
      inputId: "mobile-command",
      trigger: "user-prompt",
      traceContext: traceContext as never,
      intent: { inputOrigin: "mobile" } as never,
    },
  );
  expect(execute).toHaveBeenCalledTimes(3);
  for (const [options] of execute.mock.calls)
    expect(options.traceContext?.attributes).toMatchObject({
      [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: "mobile",
    });
  expect(execute.mock.calls[1][0].intent).toBeUndefined();
  expect(traceContext.attributes).toEqual({});
});

vi.mock("../src/runtime/methods/background-notifications.js", () => ({
  persistBackgroundTaskNotificationBatch: vi.fn(async () => ({
    messageId: "batch-message",
    text: "batch",
  })),
  shouldSuppressTaskNotificationRuntimeCommand: () => false,
}));
vi.mock("../src/runtime/off-peak/runtime.js", () => ({ refreshOffPeakWork: vi.fn() }));

beforeEach(() => vi.mocked(executeTargetContinuationCommand).mockReset());

it.each([
  ["desktop", "mobile"],
  [undefined, "mobile"],
  ["mobile", "desktop"],
  ["mobile", undefined],
  ["desktop", "desktop"],
])("后台合批 %s / %s 的来源贯穿后续两轮 goal", async (first, second) => {
  const { createRuntimeCommandQueue } = await import("../src/runtime/command-queue.js");
  const { drainRuntimeCommandQueue } =
    await import("../src/runtime/methods/runtime-command-queue.js");
  const queue = createRuntimeCommandQueue();
  const traces = [first, second].map((origin, index) => ({
    traceId: "batch-trace",
    spanId: `span-${index}`,
    attributes: origin ? { [TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]: origin } : {},
  }));
  const originalTraces = structuredClone(traces);
  traces.forEach((traceContext, index) =>
    queue.enqueue({
      id: `notification-${index}`,
      mode: "task-notification",
      priority: "next",
      createdAt: new Date(),
      source: "background_task",
      text: "notification",
      traceContext,
    } as never),
  );
  const execute = vi.mocked(executeTargetContinuationCommand);
  execute
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce(null);
  const executeTurnCommand = vi
    .fn<AgentRuntimeInternal["executeTurnCommand"]>()
    .mockResolvedValue({} as never);
  await drainRuntimeCommandQueue.call({
    runtimeCommandQueue: queue,
    config: {},
    executeTurnCommand,
  } as unknown as AgentRuntimeInternal);
  const expectedOrigin = [first, second].includes("mobile") ? "mobile" : "desktop";
  expect(executeTurnCommand).toHaveBeenCalledOnce();
  const batchOptions = executeTurnCommand.mock.calls[0]?.[2] as
    | { traceContext: { attributes: Record<string, string> } }
    | undefined;
  expect(batchOptions?.traceContext.attributes[TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]).toBe(
    expectedOrigin,
  );
  expect(execute).toHaveBeenCalledTimes(3);
  for (const [options] of execute.mock.calls) {
    expect(options.traceContext?.attributes?.[TELEMETRY_INPUT_ORIGIN_ATTRIBUTE]).toBe(
      expectedOrigin,
    );
  }
  expect(traces).toEqual(originalTraces);
});
