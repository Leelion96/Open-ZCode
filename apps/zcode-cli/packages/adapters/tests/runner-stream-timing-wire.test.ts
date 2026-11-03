import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithModelInvocationContext,
  type ModelNetworkStatusEvent,
  type ModelStreamEvent,
} from "@zcode/contracts";
import { calculateOutputTps } from "@zcode/shared";
import { createProviderBusinessErrorFetch } from "../src/model/model-execution.js";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";

type Frame = Record<string, unknown>;
type ScheduledFrame = [number, Frame | Error];
const ORIGIN = 1_800_000_000_000;
const END_MS = 1000;
const OUTPUT_TOKENS = 70;

function installTransport(create: () => Response) {
  let count = 0;
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const result = create();
      waiters.get(++count)?.resolve();
      return result;
    }),
  );
  return (request = 1): Promise<void> => {
    if (count >= request) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    waiters.set(request, waiter);
    return waiter.promise;
  };
}

function response(frames: ScheduledFrame[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const [at, frame] of frames) {
          setTimeout(() => {
            if (frame instanceof Error) controller.error(frame);
            else controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          }, at);
        }
        if (!frames.some(([, frame]) => frame instanceof Error)) {
          setTimeout(() => controller.close(), END_MS);
        }
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function anthropicFrames(kind: "tool" | "text" | "reasoning", firstMs = 300): ScheduledFrame[] {
  const block =
    kind === "tool"
      ? { type: "tool_use", id: "call_read", name: "Read", input: {} }
      : kind === "reasoning"
        ? { type: "thinking", thinking: "" }
        : { type: "text", text: "" };
  const delta =
    kind === "tool"
      ? { type: "input_json_delta", partial_json: '{"path":"example.txt"}' }
      : kind === "reasoning"
        ? { type: "thinking_delta", thinking: "think" }
        : { type: "text_delta", text: "a" };
  return [
    [50, { type: "ping" }],
    [
      100,
      {
        type: "message_start",
        message: {
          id: "message",
          type: "message",
          role: "assistant",
          model: "model",
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
    [200, { type: "content_block_start", index: 0, content_block: block }],
    [
      250,
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          ...delta,
          ...(kind === "tool"
            ? { partial_json: "" }
            : kind === "reasoning"
              ? { thinking: "" }
              : { text: "" }),
        },
      },
    ],
    [firstMs, { type: "content_block_delta", index: 0, delta }],
    [900, { type: "content_block_stop", index: 0 }],
    [
      950,
      {
        type: "message_delta",
        delta: { stop_reason: kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: OUTPUT_TOKENS },
      },
    ],
    [END_MS, { type: "message_stop" }],
  ];
}

function harness(kind: "anthropic" | "openai-compatible" = "anthropic") {
  const status: ModelNetworkStatusEvent[] = [];
  const visible: Array<{ at: number; event: ModelStreamEvent }> = [];
  const adapter = new TestAiSdkModelAdapter({
    env: { ZCODE_RUNTIME_ENV: "test" },
    registry: new TestProviderConfigFixture({
      env: {},
      providers: {
        test: { kind, baseURL: "https://model.example.test/v1", apiKey: "fixture-key" },
      },
    }),
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    statusSink: {
      publish: (event) => {
        status.push(event);
      },
    },
  });
  const model = adapter.createModel({ providerId: "test", modelId: "model" });
  return {
    status,
    visible,
    async run() {
      const stream = runWithModelInvocationContext({ metadata: { querySource: "main_turn" } }, () =>
        model.streamText({
          messages: [{ role: "user", content: "read" }],
          tools: [
            {
              name: "Read",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
        }),
      );
      for await (const event of stream) visible.push({ at: Date.now() - ORIGIN, event });
    },
    completed() {
      const event = status.findLast((entry) => entry.type === "model_request_completed");
      expect(event?.type).toBe("model_request_completed");
      if (event?.type !== "model_request_completed") throw new Error("Missing completion");
      return event;
    },
  };
}

describe("provider receive timing before stream buffers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ORIGIN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["tool", "text", "reasoning"] as const)(
    "times %s at the first non-empty wire delta",
    async (kind) => {
      const started = installTransport(() => response(anthropicFrames(kind)));
      const run = harness();
      const done = run.run();
      await started();
      await vi.advanceTimersByTimeAsync(END_MS + 100);
      await done;
      const completed = run.completed();
      expect(completed.timeToFirstContentMs).toBe(300);
      expect(run.status.find((event) => event.type === "model_first_content")).toMatchObject({
        elapsedMs: 300,
        timestamp: new Date(ORIGIN + 300).toISOString(),
      });
      expect(completed.durationMs).toBe(END_MS);
      expect(
        calculateOutputTps(
          completed.usage?.outputTokens,
          completed.durationMs! - completed.timeToFirstContentMs!,
        ),
      ).toBe(100);
      if (kind === "tool" || kind === "text") {
        const first = run.visible.find(
          ({ event }) => event.type === (kind === "tool" ? "tool_input_delta" : "text_delta"),
        );
        expect(first?.at).toBe(900);
      }
    },
  );

  it("keeps the retry buffer and starts timing anew after a partial tool attempt fails", async () => {
    let attempt = 0;
    const started = installTransport(() => {
      attempt += 1;
      return response(
        attempt === 1
          ? [
              ...anthropicFrames("tool").filter(([at]) => at <= 300),
              [400, Object.assign(new Error("connection reset"), { code: "ECONNRESET" })],
            ]
          : anthropicFrames("tool", 500),
      );
    });
    const run = harness();
    const done = run.run();
    await started();
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(attempt).toBe(2);
    expect(run.completed().timeToFirstContentMs).toBe(500);
    expect(run.visible.filter(({ event }) => event.type === "tool_call")).toHaveLength(1);
    expect(
      new Set(
        run.status
          .filter((event) => event.type === "model_request_started")
          .map((event) => event.requestId),
      ).size,
    ).toBe(2);
  });

  it("isolates simultaneous requests with different first-content times", async () => {
    let call = 0;
    const started = installTransport(() =>
      response(anthropicFrames("tool", ++call === 1 ? 300 : 600)),
    );
    const run = harness();
    const done = Promise.all([run.run(), run.run()]);
    await started(2);
    await vi.advanceTimersByTimeAsync(1200);
    await done;
    expect(
      run.status
        .filter((event) => event.type === "model_request_completed")
        .map((event) => event.timeToFirstContentMs)
        .sort(),
    ).toEqual([300, 600]);
  });

  it("does not invent timing from empty frames or SDK synthetic start", async () => {
    const frames = anthropicFrames("text").filter(([at]) => at !== 300);
    const started = installTransport(() => response(frames));
    const run = harness();
    const done = run.run();
    await started();
    await vi.advanceTimersByTimeAsync(1200);
    await done;
    expect(run.completed().timeToFirstContentMs).toBeUndefined();
  });
  it.each(["text", "reasoning", "tool"] as const)(
    "times compatible %s output through the real SDK",
    async (kind) => {
      const chunk = (delta: Frame, finish_reason: string | null = null) => ({
        id: "chatcmpl-timing",
        object: "chat.completion.chunk",
        created: 1,
        model: "model",
        choices: [{ index: 0, delta, finish_reason }],
      });
      const delta =
        kind === "text"
          ? { content: "answer" }
          : kind === "reasoning"
            ? { reasoning_content: "think" }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"example.txt"}' },
                  },
                ],
              };
      const started = installTransport(() =>
        response([
          [100, chunk({ role: "assistant" })],
          [200, chunk({ content: "" })],
          [300, chunk(delta)],
          [900, chunk({}, kind === "tool" ? "tool_calls" : "stop")],
          [
            END_MS,
            {
              ...chunk({}),
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: OUTPUT_TOKENS, total_tokens: 80 },
            },
          ],
        ]),
      );
      const run = harness("openai-compatible");
      const done = run.run();
      await started();
      await vi.advanceTimersByTimeAsync(1200);
      await done;
      expect(run.completed()).toMatchObject({ timeToFirstContentMs: 300, durationMs: END_MS });
    },
  );

  it.each([
    "response.output_text.delta",
    "response.reasoning_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
  ])("observes %s before forwarding its SSE frame", async (type) => {
    const timing: { firstContentAt?: number } = {};
    const frames: ScheduledFrame[] = [
      [100, { type: "response.created" }],
      [200, { type, delta: "" }],
      [300, { type, delta: "x" }],
      [END_MS, { type: "response.completed" }],
    ];
    const fetch = createProviderBusinessErrorFetch({
      env: {},
      providerId: "test",
      providerKind: "openai",
      streamTiming: timing,
      fetch: async () => response(frames),
    });
    const result = await fetch("https://model.example.test/v1/responses");
    const body = result.text();
    await vi.advanceTimersByTimeAsync(1200);
    expect(timing.firstContentAt).toBe(ORIGIN + 300);
    expect(await body).toBe(
      frames.map(([, frame]) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    );
  });
});
