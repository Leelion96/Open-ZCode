// 服务端内置工具（analyze_image）多轮回放：真实 GLM 流（脱敏 fixture）经 compat → AI SDK → Runtime，
// 验证下一次请求、持久化顺序和冷恢复回放。背景见 docs/design/v2/model/anthropic-stream-compat.md。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CompactTrigger,
  InMemorySessionEventStore,
  SessionEventType,
  createModelId,
  createModelProviderId,
  createRootTraceContext,
  createSessionId,
  type SessionId,
} from "@zcode/contracts";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseModelConfig,
  parseProviderConfig,
} from "@zcode/provider";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import { createTestModelProperties } from "./test-model-format.js";
import { AgentRuntime } from "../../core/src/runtime.js";
import { OUTPUT_TOKEN_CONTINUE_PROMPT } from "../../core/src/runtime/methods/turn-output-token-continuation.js";
import { PROVIDER_TOOL_INTERRUPTED_RESULT } from "../../core/src/runtime/provider-tool-rounds/contract.js";
import { MessageHistoryImpl } from "../../core/src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../../core/src/agent/session-history-hydrator.js";
import { compactActiveConversation } from "../../core/src/runtime/methods/compact-active.js";
import { buildProviderRequestMessages } from "../../core/src/runtime/helpers/provider-request-messages.js";
import { findLatestCommittedAssistantUsage } from "../../core/src/runtime/methods/turn-model-step-usage.js";

const MODEL_ID = createModelId("GLM-5.3");
const FIXTURE = join(import.meta.dirname, "fixtures", "provider-builtin-analyze-image.sse");
const TOOL_CALL_ID = "call_93e9e7ad911f4b1799a6c543";

type WireMessage = { role: string; content: unknown };
type WireBody = { messages: WireMessage[] };

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function plainReply(text: string): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_reply",
        type: "message",
        role: "assistant",
        model: "glm-5.3",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

function createRuntime(
  root: string,
  sessionID: SessionId,
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>,
  events: InMemorySessionEventStore,
) {
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      api: { type: "anthropic-messages", baseUrl: "https://builtin.invalid/v1" },
    }),
  );
  const model = createRegistryModelConfig(
    parseModelConfig({
      enabled: true,
      properties: createTestModelProperties(),
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: { max: 32_000, map: '{"max_tokens": maxOutputTokens}' },
      },
    }),
  );
  if (!provider.ok || !model.ok) throw new Error("Invalid model fixture config");
  const adapter = new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } });
  return new AgentRuntime(
    sessionID,
    {
      mode: "build",
      modelStreaming: "on",
      workingDirectory: root,
      modelSelection: {
        providerId: createModelProviderId("account:zai-individual-coding-plan"),
        modelId: MODEL_ID,
        options: { reasoningLevel: "disabled" },
      },
      memory: { enabled: false },
      compact: { enabled: false },
    },
    {
      sessionStore: store,
      eventStore: events,
      modelFactory: ({ selection }) =>
        adapter.createModel({
          providerId: selection.providerId,
          modelId: selection.modelId,
          providerConfig: provider.config,
          modelConfig: model.config,
          options: { maxOutputTokens: 32_000, ...selection.options },
        }),
    },
  );
}

function conversation(body: WireBody | undefined): WireMessage[] {
  // 去掉 system 和 cache_control 标记，只比较对话本身。
  return JSON.parse(
    JSON.stringify((body?.messages ?? []).filter((message) => message.role !== "system")),
    (key, value) => (key === "cache_control" ? undefined : value),
  );
}

describe("provider built-in tool rounds", () => {
  it("replays a server-executed analyze_image as its own round, live and after cold resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-builtin-"));
    const sessionID = createSessionId("provider-builtin");
    const fixture = await readFile(FIXTURE, "utf8");
    const bodies: WireBody[] = [];
    let store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    const events = new InMemorySessionEventStore({ retention: "unbounded" });
    let runtime: AgentRuntime | undefined;
    try {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(await new Request(input, init).json());
        return bodies.length === 1
          ? new Response(fixture, { headers: { "content-type": "text/event-stream" } })
          : plainReply(`reply ${bodies.length}`);
      });

      runtime = createRuntime(root, sessionID, store, events);
      await runtime.executeTurn("识别 shot.png 里的文字");
      await runtime.executeTurn("再说一遍");

      // 下一次请求：服务端工具独立成一轮（方案 A），不再出现 markdown 渲染。
      const live = conversation(bodies[1]);
      expect(live.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ]);
      expect(live[1]!.content).toEqual([
        expect.objectContaining({ type: "thinking" }),
        { type: "text", text: "图片已上传为远程 URL，现在用视觉分析工具识别其中文字。" },
        expect.objectContaining({ type: "tool_use", id: TOOL_CALL_ID, name: "analyze_image" }),
      ]);
      expect(live[2]!.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: TOOL_CALL_ID,
          content: expect.stringContaining("Error 1302: request rate limit exceeded"),
        }),
      ]);
      expect(live[3]!.content).toEqual([
        { type: "text", text: expect.stringMatching(/^图片中的文字为/) },
      ]);
      expect(JSON.stringify(bodies[1])).not.toContain("**🌐");
      expect(JSON.stringify(bodies[1])).not.toContain("analyze_image_result_summary");

      // 持久化按流顺序：本轮正文 → 服务端工具卡片 → 下一轮正文。
      const assistant = (await store.messages({ sessionID })).find(
        (message) => message.info.role === "assistant",
      );
      const parts = assistant!.parts.filter(
        (part) => part.type !== "step-start" && part.type !== "step-finish",
      );
      expect(parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool", "text"]);
      expect(parts[2]).toMatchObject({
        type: "tool",
        callID: TOOL_CALL_ID,
        tool: "analyze_image",
        metadata: { providerExecuted: true },
        state: { status: "completed", output: expect.stringContaining("Order Console") },
      });

      // 实时卡片：Scheduled → Started → Result，结果是服务端返回的识别文本。
      const toolEvents = (await events.getEvents(sessionID)).filter(
        (event) =>
          (event.payload as { toolCallId?: string } | undefined)?.toolCallId === TOOL_CALL_ID &&
          event.type !== SessionEventType.ModelStreaming,
      );
      expect(toolEvents.map((event) => event.type)).toEqual([
        SessionEventType.ToolCallScheduled,
        SessionEventType.ToolCallStarted,
        SessionEventType.ToolCallResult,
      ]);

      // 冷恢复后回放出完全相同的对话。
      runtime.beginShutdown();
      store.close();
      store = await createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
      runtime = createRuntime(
        root,
        sessionID,
        store,
        new InMemorySessionEventStore({ retention: "unbounded" }),
      );
      await runtime.resumeFromStore();
      await runtime.executeTurn("第三句");
      const cold = conversation(bodies[2]);
      expect(cold.slice(0, live.length + 1)).toEqual([
        ...live,
        { role: "assistant", content: [{ type: "text", text: "reply 2" }] },
      ]);
    } finally {
      runtime?.beginShutdown();
      vi.unstubAllGlobals();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ─── 评审回归：终态判断、断流作废、缺少结果 ────────────────────────────────────

function fixtureFrames(fixture: string): string[] {
  return fixture.split("\n\n").filter((frame) => frame.trim().length > 0);
}

function frameData(frame: string): Record<string, unknown> | undefined {
  const line = frame.split("\n").find((candidate) => candidate.startsWith("data:"));
  return line ? (JSON.parse(line.slice("data:".length)) as Record<string, unknown>) : undefined;
}

function sseBody(frames: string[]): string {
  return frames.map((frame) => `${frame}\n\n`).join("");
}

function eventStream(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function openScenario(respond: (index: number, fixture: string, body: WireBody) => Response) {
  const root = await mkdtemp(join(tmpdir(), "zcode-provider-builtin-"));
  const sessionID = createSessionId("provider-builtin-regression");
  const fixture = await readFile(FIXTURE, "utf8");
  const bodies: WireBody[] = [];
  const dbPath = join(root, "session.sqlite");
  let store = await createSqliteSessionStore({ dbPath });
  const events = new InMemorySessionEventStore({ retention: "unbounded" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = (await new Request(input, init).json()) as WireBody;
    bodies.push(body);
    return respond(bodies.length - 1, fixture, body);
  });
  let runtime = createRuntime(root, sessionID, store, events);
  return {
    bodies,
    events,
    sessionID,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    async coldResume() {
      runtime.beginShutdown();
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      runtime = createRuntime(
        root,
        sessionID,
        store,
        new InMemorySessionEventStore({ retention: "unbounded" }),
      );
      await runtime.resumeFromStore();
    },
    async close() {
      runtime.beginShutdown();
      vi.unstubAllGlobals();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 再发一句拿 live history，冷恢复后再发一句拿冷恢复 history，两者必须一致。 */
async function expectColdResumeMatchesLive(scenario: Awaited<ReturnType<typeof openScenario>>) {
  await scenario.runtime.executeTurn("再说一遍");
  const live = conversation(scenario.bodies.at(-1));
  await scenario.coldResume();
  await scenario.runtime.executeTurn("第三句");
  const cold = conversation(scenario.bodies.at(-1));
  expect(cold.slice(0, live.length)).toEqual(live);
  return live;
}

describe("provider built-in tool rounds (review regressions)", () => {
  it("still continues a truncated answer after a server-executed tool round", async () => {
    const scenario = await openScenario((index, fixture) =>
      index === 0
        ? eventStream(fixture.replace(/"stop_reason": "end_turn"/u, '"stop_reason": "max_tokens"'))
        : plainReply(`reply ${index}`),
    );
    try {
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      // 服务端工具不算待执行调用：max_tokens 必须触发续写请求。
      expect(scenario.bodies).toHaveLength(2);
      const continuation = conversation(scenario.bodies[1]);
      expect(JSON.stringify(continuation.at(-1))).toContain(OUTPUT_TOKEN_CONTINUE_PROMPT);
      expect(continuation.some((message) => JSON.stringify(message).includes(TOOL_CALL_ID))).toBe(
        true,
      );
    } finally {
      await scenario.close();
    }
  });

  it("keeps a discarded stream attempt out of both live and cold-resumed history", async () => {
    const scenario = await openScenario((index, fixture) => {
      if (index !== 0) return plainReply(`reply ${index}`);
      // 服务端工具与结果已下发、最后一轮正文写到一半时断流（可重试）。
      const frames = fixtureFrames(fixture);
      const cut = frames.findIndex((frame) => {
        const data = frameData(frame);
        return data?.type === "content_block_delta" && data.index === 6;
      });
      const encoder = new TextEncoder();
      let delivered = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          // 先交付已收到的帧，等下游消费后再断流：源流出错时，下游 TransformStream 里尚未读取的数据会被丢弃。
          async pull(controller) {
            if (!delivered) {
              delivered = true;
              controller.enqueue(encoder.encode(sseBody(frames.slice(0, cut + 1))));
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
            // 与 Node 真实 socket 错误一致带 code，adapter 才会归类为网络断流。
            controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      const live = await expectColdResumeMatchesLive(scenario);
      // 作废的 attempt 不进任何 history：只剩重试后的回答。
      expect(JSON.stringify(live)).not.toContain(TOOL_CALL_ID);
      expect(live.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    } finally {
      await scenario.close();
    }
  });

  it("settles a server tool whose result never arrives as interrupted, live and cold", async () => {
    const scenario = await openScenario((index, fixture) => {
      if (index !== 0) return plainReply(`reply ${index}`);
      const frames = fixtureFrames(fixture).filter((frame) => {
        const data = frameData(frame);
        const block = data?.content_block as { type?: string } | undefined;
        return !(
          (data?.type === "content_block_start" && block?.type === "tool_result") ||
          (data?.type === "content_block_stop" && data.index === 5)
        );
      });
      return eventStream(sseBody(frames));
    });
    try {
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      const toolEvents = (await scenario.events.getEvents(scenario.sessionID)).filter(
        (event) =>
          (event.payload as { toolCallId?: string } | undefined)?.toolCallId === TOOL_CALL_ID &&
          event.type !== SessionEventType.ModelStreaming,
      );
      expect(toolEvents.map((event) => event.type)).toEqual([
        SessionEventType.ToolCallScheduled,
        SessionEventType.ToolCallStarted,
        SessionEventType.ToolCallResult,
      ]);
      expect(toolEvents[2]!.payload).toMatchObject({ result: { success: false } });

      const live = await expectColdResumeMatchesLive(scenario);
      expect(live[2]!.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: TOOL_CALL_ID,
          is_error: true,
          content: PROVIDER_TOOL_INTERRUPTED_RESULT,
        }),
      ]);
    } finally {
      await scenario.close();
    }
  });

  it("keeps one compact group per stored response, live and after cold resume", async () => {
    const scenario = await openScenario((_index, fixture, body) => {
      const text = JSON.stringify(body.messages);
      if (text.includes("create a detailed summary")) {
        return plainReply("<summary>older work summary</summary>");
      }
      return text.includes("识别 shot.png") && !text.includes(TOOL_CALL_ID)
        ? eventStream(fixture)
        : plainReply("earlier reply");
    });
    try {
      await scenario.runtime.executeTurn("old setup");
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      // 一条持久化 assistant 拆成了 round + 最后一轮；compact 保留最近一组时必须整条保留或整条摘要。
      await compactActiveConversation.call(
        scenario.runtime as never,
        undefined,
        createRootTraceContext({ sessionId: scenario.sessionID }),
        [],
        { trigger: CompactTrigger.Auto },
      );
      const project = (entries: ReturnType<MessageHistoryImpl["toRuntimeEntries"]>) =>
        buildProviderRequestMessages({
          entries,
          useMidConversationSystem: false,
          applyCacheControl: false,
        }).messages.filter((message) => message.toolCalls?.length || message.role === "tool");
      const live = project(
        (
          scenario.runtime as unknown as { messageHistory: MessageHistoryImpl }
        ).messageHistory.toRuntimeEntries(),
      );
      const restored = new MessageHistoryImpl();
      await hydrateMessageHistoryFromSession({
        history: restored,
        messages: await scenario.store.messages({ sessionID: scenario.sessionID }),
      });
      expect(project(restored.toRuntimeEntries())).toEqual(live);
      // 最近一组是整条服务端工具响应：调用与结果随最后一轮一起保留。
      expect(JSON.stringify(live)).toContain(TOOL_CALL_ID);
    } finally {
      await scenario.close();
    }
  });

  it("keeps two responses that reuse a server tool call id in separate compact groups", async () => {
    // 工具调用 id 只保证单次响应内配对：两次响应都用同一个 id 时，compact 分组仍必须按持久化消息分开。
    const scenario = await openScenario((_index, fixture, body) => {
      if (JSON.stringify(body.messages).includes("create a detailed summary")) {
        return plainReply("<summary>older work summary</summary>");
      }
      return JSON.stringify(body.messages.at(-1)).includes("识别")
        ? eventStream(fixture)
        : plainReply("earlier reply");
    });
    try {
      await scenario.runtime.executeTurn("old setup");
      await scenario.runtime.executeTurn("识别 shot.png 里的文字");
      await scenario.runtime.executeTurn("再识别一次 shot.png");
      await compactActiveConversation.call(
        scenario.runtime as never,
        undefined,
        createRootTraceContext({ sessionId: scenario.sessionID }),
        [],
        { trigger: CompactTrigger.Auto },
      );
      const project = (entries: ReturnType<MessageHistoryImpl["toRuntimeEntries"]>) =>
        buildProviderRequestMessages({
          entries,
          useMidConversationSystem: false,
          applyCacheControl: false,
        }).messages.filter((message) => message.toolCalls?.length || message.role === "tool");
      const live = project(
        (
          scenario.runtime as unknown as { messageHistory: MessageHistoryImpl }
        ).messageHistory.toRuntimeEntries(),
      );
      const restored = new MessageHistoryImpl();
      await hydrateMessageHistoryFromSession({
        history: restored,
        messages: await scenario.store.messages({ sessionID: scenario.sessionID }),
      });
      expect(project(restored.toRuntimeEntries())).toEqual(live);
      // 只保留最近一次响应：一次服务端调用加它的结果，而不是两次响应合并成的一组。
      expect(live.map((message) => message.role)).toEqual(["assistant", "tool"]);
    } finally {
      await scenario.close();
    }
  });

  it.each(["with", "without"] as const)(
    "does not anchor context usage on a server tool response %s trailing text, live and cold",
    async (trailing) => {
      // 服务端多轮请求的 usage 是合计（fixture 约 37k，单次上下文约一半），不能当估算锚点。
      const fixtureFor = (fixture: string) =>
        trailing === "with"
          ? fixture
          : sseBody(fixtureFrames(fixture).filter((frame) => frameData(frame)?.index !== 6));
      const scenario = await openScenario((_index, fixture, body) => {
        const text = JSON.stringify(body.messages);
        return text.includes("识别 shot.png") && !text.includes(TOOL_CALL_ID)
          ? eventStream(fixtureFor(fixture))
          : plainReply("earlier reply");
      });
      try {
        await scenario.runtime.executeTurn("old setup");
        await scenario.runtime.executeTurn("识别 shot.png 里的文字");
        const anchorOf = (entries: ReturnType<MessageHistoryImpl["toRuntimeEntries"]>) => {
          const anchor = findLatestCommittedAssistantUsage(entries);
          const entry = anchor ? entries[anchor.messageIndex] : undefined;
          return {
            baseline: anchor?.baseline,
            message: entry && "message" in entry ? entry.message.content : undefined,
          };
        };
        const live = anchorOf(
          (
            scenario.runtime as unknown as { messageHistory: MessageHistoryImpl }
          ).messageHistory.toRuntimeEntries(),
        );
        const restored = new MessageHistoryImpl();
        await hydrateMessageHistoryFromSession({
          history: restored,
          messages: await scenario.store.messages({ sessionID: scenario.sessionID }),
        });
        expect(anchorOf(restored.toRuntimeEntries())).toEqual(live);
        // 锚点仍是上一轮的真实 usage，而不是服务端合计。
        expect(JSON.stringify(live.message)).toContain("earlier reply");
        await expectColdResumeMatchesLive(scenario);
      } finally {
        await scenario.close();
      }
    },
  );
});
