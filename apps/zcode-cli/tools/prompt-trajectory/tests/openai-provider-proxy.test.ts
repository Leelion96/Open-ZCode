import { deepStrictEqual, equal } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MessageLedger } from "../src/message-ledger.js";
import {
  startOpenAiProviderProxy,
  type OpenAiProviderProxy,
} from "../src/openai-provider-proxy.js";
import type { TrajectoryJsonlEntry } from "../src/types.js";

const UNUSED_UPSTREAM = "http://127.0.0.1:9/v1";
const SSE_DONE = "data: [DONE]";

function chatCompletion(message: Record<string, unknown>, finishReason = "stop") {
  return {
    id: "mock-response",
    object: "chat.completion",
    created: 0,
    model: "mock-model",
    choices: [
      { index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function requestBody(extra: Record<string, unknown> = {}) {
  return { model: "mock-model", messages: [{ role: "user", content: "hello proxy" }], ...extra };
}

function sseEvents(text: string): string[] {
  return text.split("\n\n").filter((event) => event.length > 0);
}

describe("prompt trajectory OpenAI provider proxy", () => {
  let dir: string;
  let ledgerPath: string;
  let ledger: MessageLedger;
  let proxy: OpenAiProviderProxy | undefined;
  let upstream: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zcode-prompt-trajectory-proxy-test-"));
    ledgerPath = join(dir, "trajectory.jsonl");
    ledger = await MessageLedger.open(ledgerPath);
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
    await ledger.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  const post = (body: string | Record<string, unknown>) =>
    fetch(`${proxy!.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const recordedAssistantMessages = async () => {
    await ledger.close();
    const entries = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryJsonlEntry);
    return entries.flatMap((entry) =>
      entry.kind === "message" && entry.messageIndex === undefined ? [entry.message] : [],
    );
  };

  it("answers a streaming request with SSE chunks equivalent to the chat.completion mock", async () => {
    proxy = await startOpenAiProviderProxy({
      ledger,
      mockResponses: [chatCompletion({ content: "streamed answer" })],
      upstreamBaseURL: UNUSED_UPSTREAM,
    });

    const response = await post(requestBody({ stream: true }));

    equal(response.status, 200);
    equal(response.headers.get("content-type"), "text/event-stream");
    const events = sseEvents(await response.text());
    equal(events.at(-1), SSE_DONE);
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event.replace(/^data: /u, "")));
    // 第一片带完整内容，最后一片只带结束原因和 usage；SDK 按流式解析即可拿到同一条回复。
    deepStrictEqual(chunks[0].choices, [
      {
        index: 0,
        delta: { role: "assistant", content: "streamed answer" },
        finish_reason: null,
      },
    ]);
    deepStrictEqual(chunks[1].choices, [{ index: 0, delta: {}, finish_reason: "stop" }]);
    deepStrictEqual(chunks[1].usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    equal(chunks.length, 2);
    deepStrictEqual(await recordedAssistantMessages(), [
      { role: "assistant", content: "streamed answer" },
    ]);
  });

  it("keeps each tool call with its index in the streamed chunk", async () => {
    const toolCall = {
      id: "call_read",
      type: "function",
      function: { name: "Read", arguments: '{"file_path":"a.ts"}' },
    };
    proxy = await startOpenAiProviderProxy({
      ledger,
      mockResponses: [chatCompletion({ content: "", tool_calls: [toolCall] }, "tool_calls")],
      upstreamBaseURL: UNUSED_UPSTREAM,
    });

    const response = await post(requestBody({ stream: true }));
    const [first, last] = sseEvents(await response.text())
      .slice(0, -1)
      .map((event) => JSON.parse(event.replace(/^data: /u, "")));

    deepStrictEqual(first.choices[0].delta.tool_calls, [{ index: 0, ...toolCall }]);
    equal(last.choices[0].finish_reason, "tool_calls");
  });

  it("answers a non-streaming request with the mock as JSON", async () => {
    const mock = chatCompletion({ content: "json answer" });
    proxy = await startOpenAiProviderProxy({
      ledger,
      mockResponses: [mock],
      upstreamBaseURL: UNUSED_UPSTREAM,
    });

    const response = await post(requestBody());

    equal(response.status, 200);
    equal(response.headers.get("content-type"), "application/json");
    deepStrictEqual(await response.json(), mock);
  });

  it("returns 400 when no mock matches, and 502 for other proxy failures", async () => {
    proxy = await startOpenAiProviderProxy({
      ledger,
      mockResponses: [
        {
          match: { messageIncludes: "NEVER_IN_REQUEST" },
          response: chatCompletion({ content: "x" }),
        },
      ],
      upstreamBaseURL: UNUSED_UPSTREAM,
    });

    // 没有匹配的 mock 是 fixture 断言失败，按 400 返回，不让 provider 当作上游故障重试。
    const missing = await post(requestBody());
    equal(missing.status, 400);
    deepStrictEqual(await missing.json(), { error: "Missing mock OpenAI response for request 1." });

    // 对照：请求体不是 JSON 属于代理自身失败，仍是 502。
    const invalid = await post("not json");
    equal(invalid.status, 502);
  });

  it("passes an upstream event stream through when its content type has mixed case and parameters", async () => {
    const streamed = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hello "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      SSE_DONE,
    ]
      .map((event) => `${event}\n\n`)
      .join("");
    upstream = createServer((_request, response) => {
      response.setHeader("Content-Type", "Text/Event-Stream; charset=utf-8");
      response.end(streamed);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    proxy = await startOpenAiProviderProxy({
      ledger,
      upstreamBaseURL: `http://127.0.0.1:${port}/v1`,
    });

    const response = await post(requestBody({ stream: true }));

    equal(await response.text(), streamed);
    // 按事件流拼出整条回复写进 ledger；当成 JSON 解析会得到空值，什么也不记。
    deepStrictEqual(await recordedAssistantMessages(), [
      { role: "assistant", content: "Hello world" },
    ]);
  });
});
