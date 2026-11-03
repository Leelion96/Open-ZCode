import { createServer, request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startE2ENetworkCaptureProxy } from "./e2e/helpers/network-capture-proxy.js";
import { startUpstreamReplayServer } from "#e2e/helpers/upstream-replay-server";

it("GLM-5.2 的标题夹具接纳明确关闭思考的实际请求字段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "glm52-title-replay-"));
  const upstream = await startUpstreamReplayServer({
    artifactPath: join(dir, "capture.json"),
    fixturePaths: [
      join(
        import.meta.dirname,
        "e2e/fixtures/upstream/conversation-session/conversation-session-glm52-reasoning-request-shape.json",
      ),
    ],
  });
  try {
    const response = await fetch(`${upstream.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "GLM-5.2",
        thinking: { type: "disabled" },
        enable_thinking: false,
        reasoning_effort: "none",
        messages: [
          { role: "system", content: "Generate a concise title for this coding session." },
          { role: "user", content: "E2E_GLM52_REASONING_MAX" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const title = await response.json();
    expect(title.object).toBe("chat.completion");
    expect(JSON.parse(title.choices[0].message.content).title).toBeTruthy();
  } finally {
    await upstream.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it("Goal 时间线的新目标未完成后有可取消的正常续跑响应", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-timeline-replay-"));
  const upstream = await startUpstreamReplayServer({
    artifactPath: join(dir, "capture.json"),
    fixturePaths: [
      join(
        import.meta.dirname,
        "e2e/fixtures/upstream/conversation-session/conversation-session-goal-timeline.json",
      ),
    ],
  });
  try {
    for (const prompt of [
      "E2E_GOAL_TIMELINE_REPRO_A Continue working toward the active session goal",
      "E2E_GOAL_TIMELINE_REPRO_A Completion verifier result: Reason: 第一轮只有九个汉字。 写出恰好十个汉字的科幻小说",
      "E2E_GOAL_TIMELINE_REPRO_B Continue working toward the active session goal",
    ]) {
      const prior = await fetch(`${upstream.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      expect(prior.status).toBe(200);
      await prior.text();
    }
    const response = await fetch(`${upstream.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        stream: true,
        messages: [
          {
            role: "user",
            content:
              "E2E_GOAL_TIMELINE_REPRO_B Continue working toward the active session goal. Completion verifier result: Reason: 没有交付 10w 字小说。 Next action: 继续写 10w 字小说。",
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const gates = await fetch(`${upstream.baseUrl}/__e2e__/gates`).then((res) => res.json());
    expect(gates).toContain("upstream-goal-timeline-new-target-continuation");
    await response.body?.cancel();
  } finally {
    await upstream.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it("模型回归目录的标题不得命中包含同一 E2E marker 的正文 fixture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-title-replay-"));
  const upstream = await startUpstreamReplayServer({
    artifactPath: join(dir, "capture.json"),
    fixturePaths: [
      join(
        import.meta.dirname,
        "e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-regression-gaps.json",
      ),
    ],
  });
  try {
    const response = await fetch(`${upstream.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          {
            role: "user",
            content:
              'Generate a concise title for E2E_CATALOG_WORKSPACE_A: Reply with exactly "upstream-e2e-ok"',
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const title = await response.json();
    expect(title.type).toBe("message");
    expect(JSON.parse(title.content[0].text).title).toBeTruthy();
  } finally {
    await upstream.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it("SR87 账号请求通过 case-local matcher，R95C 首发与标题分别返回 SSE 和 JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-sr87-replay-"));
  const upstream = await startUpstreamReplayServer({
    artifactPath: join(dir, "upstream.json"),
    fixturePaths: [
      join(
        import.meta.dirname,
        "e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-effective-selection.json",
      ),
    ],
  });
  let proxy: Awaited<ReturnType<typeof startE2ENetworkCaptureProxy>> | undefined;
  try {
    proxy = await startE2ENetworkCaptureProxy({
      artifactPath: join(dir, "proxy.json"),
      caDir: join(dir, "ca"),
      requestRedirects: [
        {
          host: "model.example.test",
          path: "/api/anthropic/v1/messages",
          targetUrl: `${upstream.baseUrl}/messages`,
        },
      ],
      responseMocks: [
        {
          host: "model.example.test",
          path: "/api/anthropic/v1/messages",
          body: "wrong-static-response",
        },
      ],
    });
    const address = new URL(proxy.proxyUrl);
    const replies = await Promise.all(
      [true, false].map(async (stream) => {
        const response = await new Promise<import("node:http").IncomingMessage>(
          (resolve, reject) => {
            const req = request(
              {
                hostname: address.hostname,
                port: address.port,
                path: "http://model.example.test/api/anthropic/v1/messages",
                method: "POST",
                headers: { host: "model.example.test", "content-type": "application/json" },
              },
              resolve,
            );
            req.on("error", reject);
            req.end(
              JSON.stringify({
                model: "GLM-5.2",
                stream,
                messages: [
                  {
                    role: "user",
                    content: stream
                      ? "E2E_R95C_SEND: Reply briefly."
                      : "Generate a concise title for E2E_R95C_SEND",
                  },
                ],
              }),
            );
          },
        );
        let body = "";
        for await (const chunk of response) body += String(chunk);
        return { status: response.statusCode, type: response.headers["content-type"], body };
      }),
    );
    expect(replies.map((response) => response.status)).toEqual([200, 200]);
    expect(replies[0]!.type).toContain("text/event-stream");
    expect(replies[0]!.body).toContain("coding-plan-e2e-ok");
    expect(replies[1]!.type).toContain("application/json");
    const title = JSON.parse(replies[1]!.body);
    expect(title.type).toBe("message");
    expect(JSON.parse(title.content[0].text).title).toBeTruthy();
  } finally {
    await proxy?.stop();
    await upstream.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it("同一模型端点区分普通 JSON 标题与流式正文，并保存真实响应类型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-response-type-"));
  const artifactPath = join(dir, "capture.json");
  const proxy = await startE2ENetworkCaptureProxy({
    artifactPath,
    caDir: join(dir, "ca"),
    responseMocks: [
      {
        host: "model.example.test",
        path: "/messages",
        headers: (body: string) => ({
          "content-type":
            JSON.parse(body).stream === true ? "text/event-stream" : "application/json",
        }),
        body: (body) =>
          JSON.parse(body).stream === true ? "data: reply\n\n" : '{"title":"Fixture"}',
      },
    ],
  });
  let stopped = false;
  try {
    const proxyAddress = new URL(proxy.proxyUrl);
    for (const stream of [false, true]) {
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = request(
          {
            hostname: proxyAddress.hostname,
            port: proxyAddress.port,
            path: "http://model.example.test/messages",
            method: "POST",
            headers: { host: "model.example.test", "content-type": "application/json" },
          },
          resolve,
        );
        req.on("error", reject);
        req.end(JSON.stringify({ stream }));
      });
      let body = "";
      for await (const chunk of response) body += String(chunk);
      expect(response.headers["content-type"]).toBe(
        stream ? "text/event-stream" : "application/json",
      );
      expect(body).toBe(stream ? "data: reply\n\n" : '{"title":"Fixture"}');
    }
    await proxy.stop();
    stopped = true;
    const capture = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(
      capture.records.map(
        (record: { responseHeaders: Record<string, string> }) =>
          record.responseHeaders["content-type"],
      ),
    ).toEqual(["application/json", "text/event-stream"]);
  } finally {
    if (!stopped) await proxy.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it("账号数据面转发到受控回放时保留首块、请求体和原地址证据", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-account-replay-"));
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = "";
  let path = "";
  const upstream = createServer(async (req, res) => {
    path = req.url ?? "";
    for await (const chunk of req) received += String(chunk);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("first\n");
    await gate;
    res.end("last\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture 未绑定端口");
  const artifactPath = join(dir, "capture.json");
  const proxy = await startE2ENetworkCaptureProxy({
    artifactPath,
    caDir: join(dir, "ca"),
    requestRedirects: [
      {
        host: "127.0.0.1:9",
        path: "/api/anthropic/v1/messages",
        targetUrl: `http://127.0.0.1:${address.port}/messages`,
      },
    ],
    responseMocks: [
      { host: "127.0.0.1:9", path: "/api/anthropic/v1/messages", body: "wrong-fallback" },
    ],
  });
  let stopped = false;
  try {
    const proxyAddress = new URL(proxy.proxyUrl);
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          hostname: proxyAddress.hostname,
          port: proxyAddress.port,
          path: "http://127.0.0.1:9/api/anthropic/v1/messages",
          method: "POST",
          headers: { host: "127.0.0.1:9", "content-type": "application/json" },
        },
        resolve,
      );
      req.on("error", reject);
      req.end(JSON.stringify({ messages: [{ role: "user", content: "queue marker" }] }));
    });
    const chunks = response[Symbol.asyncIterator]();
    expect(String((await chunks.next()).value)).toBe("first\n");
    expect(path).toBe("/messages");
    expect(JSON.parse(received).messages[0].content).toBe("queue marker");
    release();
    expect(String((await chunks.next()).value)).toBe("last\n");
    expect((await chunks.next()).done).toBe(true);
    await proxy.stop();
    stopped = true;
    const capture = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(capture.records).toEqual([
      expect.objectContaining({
        host: "127.0.0.1:9",
        path: "/api/anthropic/v1/messages",
        status: "complete",
        responseTextPreview: "first\nlast\n",
        requestJson: JSON.parse(received),
      }),
    ]);
  } finally {
    release();
    if (!stopped) await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
