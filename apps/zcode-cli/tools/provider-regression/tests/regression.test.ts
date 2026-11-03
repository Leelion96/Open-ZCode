import { describe, expect, it } from "vitest";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runRegression } from "#public";
import { renderReport } from "#regression/report";
import { readModelRequestBody } from "#regression/usage";
import { fixture, chatResponse, secret, architectureAnswer } from "#test/fixture";

describe("provider regression", () => {
  it("只解析模型请求，字节体与 Request 观测不消费原请求", async () => {
    const body = { model: "model-a", messages: [], max_tokens: 8192 };
    const json = JSON.stringify(body);
    const bytes = new TextEncoder().encode(json);
    const url = "https://provider.example.com/v1/messages";
    for (const input of [json, bytes, bytes.buffer]) {
      expect(await readModelRequestBody(url, { method: "POST", body: input })).toEqual(body);
    }
    const request = new Request(url, { method: "POST", body: json });
    expect(await readModelRequestBody(request)).toEqual(body);
    expect(await request.json()).toEqual(body);
    expect(
      await readModelRequestBody(url, { method: "POST", body: JSON.stringify({ apiKey: secret }) }),
    ).toBeUndefined();
    expect(await readModelRequestBody(url, { method: "GET" })).toBeUndefined();
    expect(
      await readModelRequestBody(url, {
        method: "POST",
        body: JSON.stringify({ model: "model-a" }),
      }),
    ).toBeUndefined();
    expect(
      await readModelRequestBody(url, {
        method: "POST",
        body: JSON.stringify({ model: "model-a", input: [] }),
      }),
    ).toEqual({ model: "model-a", input: [] });
  });

  it("省略 repetitions 时每个档位只运行一次", async () => {
    const f = await fixture();
    try {
      const { repetitions: _repetitions, ...list } = f.list;
      await writeFile(f.options.listFile, JSON.stringify(list));
      let calls = 0;
      const report = await runRegression({
        ...f.options,
        transport: async () => {
          calls++;
          return chatResponse();
        },
      });
      expect(calls).toBe(2);
      expect(report.rows.map((row) => [row.reasoningLevel, row.repetition])).toEqual([
        ["low", 1],
        ["high", 1],
      ]);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("并行实例有独立会话，入口所需会话头沿现有 Adapter 生成", async () => {
    const f = await fixture();
    const sessions: (string | null)[] = [];
    try {
      const providers = JSON.parse(await readFile(f.options.providersFile, "utf8"));
      providers.providerRules[0].config.api = {
        type: "openai-chat-completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
      };
      await writeFile(f.options.providersFile, JSON.stringify(providers));
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, repetitions: 1, concurrency: { cases: 2 } }),
      );
      const report = await runRegression({
        ...f.options,
        transport: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const session = headers.get("x-session-id");
          sessions.push(session);
          expect(session).toBeTruthy();
          expect(headers.get("x-opencode-session")).toBe(session);
          return chatResponse();
        },
      });
      expect(report.rows.every((row) => row.status === "passed")).toBe(true);
      expect(sessions).toHaveLength(2);
      expect(new Set(sessions).size).toBe(2);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("同题逐档重复，真实 Adapter 参数、缺失 usage 与中位数不混淆", async () => {
    const f = await fixture();
    const bodies: Record<string, unknown>[] = [];
    try {
      const transport: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return chatResponse(bodies.length === 1 ? 0 : undefined);
      };
      const report = await runRegression({ ...f.options, transport });
      expect(report.rows).toHaveLength(6);
      expect(
        report.rows.every((r) => r.status === "passed" && r.parameterCheck === "matched"),
      ).toBe(true);
      expect(new Set(bodies.map((b) => JSON.stringify(b.messages))).size).toBe(1);
      expect(bodies.map((b) => b.reasoning_effort)).toEqual([
        "low",
        "high",
        "low",
        "high",
        "low",
        "high",
      ]);
      expect(report.rows[0].reasoningTokens).toBe(0);
      expect(report.rows[1].reasoningTokens).toBeNull();
      expect(report.rows[0].reasoningCharacters).toBe(3);
      const saved = await readFile(join(f.dir, "report", report.runId!, "report.json"), "utf8");
      expect(saved).not.toContain(secret);
      expect(saved).not.toContain("思考😀");
      expect(renderReport(report)).toContain("中位数");
      expect(report.reasoningTask.id).toBe("task-platform-v1");
      expect(report.reasoningTask.prompt).toContain("跨地域");
      expect(report.reasoningTask.maxOutputTokens).toBe(1024);
      expect(report.rows[0].answer).toBe(architectureAnswer);
      expect(report.rows[0].detail).toContain("设计质量待人工评审");
      expect(renderReport(report)).toContain(
        architectureAnswer
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      expect(JSON.stringify(bodies[0].messages)).toContain("外部接口");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("架构题只验证传输完成与非空回答，不评判内容或标题", async () => {
    const f = await fixture();
    try {
      for (const answer of ["80", architectureAnswer.replace("## 4. 故障推演", "缺失章节"), ""]) {
        const report = await runRegression({
          ...f.options,
          transport: async () =>
            new Response(
              (await chatResponse().text()).replace(
                JSON.stringify(architectureAnswer),
                JSON.stringify(answer),
              ),
              {
                headers: { "content-type": "text/event-stream" },
              },
            ),
        });
        expect(report.rows.every((r) => r.status === (answer ? "passed" : "failed"))).toBe(true);
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it.each(["17 × 19 = 323", "已完成回答", ""])(
    "文本使用产品流式会话，不评判最终文风：%s",
    async (answer) => {
      const f = await fixture();
      try {
        await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["TEXT-001"] }));
        const report = await runRegression({
          ...f.options,
          transport: async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            if (body.stream)
              return new Response(
                (await chatResponse().text()).replace(
                  JSON.stringify(architectureAnswer),
                  JSON.stringify(answer),
                ),
                { headers: { "content-type": "text/event-stream" } },
              );
            return new Response(
              JSON.stringify({
                id: "text",
                object: "chat.completion",
                created: 1,
                model: "model-a",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: answer },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        });
        expect(report.rows[0].status).toBe(answer ? "passed" : "failed");
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    },
  );
  it.each(["当前口令是 blue-42。", "BLUE-420"])(
    "输入标记允许解释但不接受不同标记：%s",
    async (answer) => {
      const f = await fixture();
      try {
        await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["SYSTEM-001"] }));
        const report = await runRegression({
          ...f.options,
          transport: async () =>
            new Response(
              (await chatResponse().text()).replace(
                JSON.stringify(architectureAnswer),
                JSON.stringify(answer),
              ),
              { headers: { "content-type": "text/event-stream" } },
            ),
        });
        expect(report.rows[0].status).toBe(answer === "BLUE-420" ? "review" : "passed");
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    },
  );
  it("失败继续下一项且报告移除错误回显的 Key", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const report = await runRegression({
        ...f.options,
        transport: async () => {
          if (++calls === 1) throw new Error(secret);
          return chatResponse();
        },
      });
      expect(calls).toBe(6);
      expect(report.rows[0].status).toBe("failed");
      expect(report.rows[1].status).toBe("passed");
      expect(JSON.stringify(report)).not.toContain(secret);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("预览不调用网络，不适用与缺 Key 保留为不同状态", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, caseIds: ["IMAGE-001", "REASON-001"] }),
      );
      const cfg = JSON.parse(await readFile(f.options.providersFile, "utf8"));
      cfg.providerRules[0].config.access.apiKey = "";
      await writeFile(f.options.providersFile, JSON.stringify(cfg));
      const r = await runRegression({
        ...f.options,
        dryRun: true,
        transport: async () => {
          throw new Error("must not call");
        },
      });
      expect(r.rows.find((x) => x.caseId === "IMAGE-001")?.status).toBe("skipped");
      expect(
        r.rows.filter((x) => x.caseId === "REASON-001").every((x) => x.status === "untested"),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("未知用例和不存在的模型在发请求前报错", async () => {
    const f = await fixture();
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["WRONG"] }));
      await expect(runRegression(f.options)).rejects.toThrow();
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, targets: [{ providerId: "test-a", modelIds: ["wrong"] }] }),
      );
      await expect(runRegression(f.options)).rejects.toThrow();
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it.each(["stop", "length", "error"])("输出预算只检查传参和合法结束：%s", async (finish) => {
    const f = await fixture();
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["OUTPUT-001"] }));
      const report = await runRegression({
        ...f.options,
        transport: async () => chatResponse(0, finish),
      });
      expect(report.rows[0].status).toBe(finish === "error" ? "failed" : "passed");
      if (finish === "stop") expect(report.rows[0].detail).toContain("未观察到截断");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("截断不算成功", async () => {
    const f = await fixture();
    try {
      const r = await runRegression({
        ...f.options,
        transport: async () => chatResponse(20, "length"),
      });
      expect(r.rows.every((x) => x.status === "failed")).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("新档位自动展开，媒体用例按 property 选择", async () => {
    const f = await fixture();
    try {
      const path = join(f.dir, "builtin.json");
      const data = JSON.parse(await readFile(path, "utf8"));
      data.config.modelConfigRules.modelRules[0].config.optionSpecs.reasoningLevel.values.push(
        "max",
      );
      await writeFile(path, JSON.stringify(data));
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["*"] }));
      const r = await runRegression({ ...f.options, dryRun: true });
      expect(r.rows.filter((x) => x.caseId === "REASON-001")).toHaveLength(9);
      expect(r.rows.find((x) => x.caseId === "IMAGE-001")?.status).toBe("skipped");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it.each(["323", "17 × 19 = 323", "两项工具结果已收到", ""])(
    "工具闭环验证传输，不评判最终文风：%s",
    async (answer) => {
      const f = await fixture();
      const bodies: any[] = [];
      const sessions: (string | null)[] = [];
      try {
        await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["TOOL-001"] }));
        const r = await runRegression({
          ...f.options,
          transport: async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            bodies.push(body);
            sessions.push(new Headers(init?.headers).get("x-session-id"));
            const count = bodies.length;
            const message =
              count < 3
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `call-${count}`,
                        type: "function",
                        function: {
                          name: "lookup_regression_value",
                          arguments: JSON.stringify({
                            query: { id: count === 1 ? "left" : "right" },
                          }),
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: answer };
            expect(body.stream).toBe(true);
            const delta = {
              ...message,
              ...(message.tool_calls
                ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }
                : {}),
            };
            return new Response(
              [
                { choices: [{ index: 0, delta, finish_reason: null }] },
                {
                  choices: [
                    { index: 0, delta: {}, finish_reason: count < 3 ? "tool_calls" : "stop" },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 20 },
                },
              ]
                .map(
                  (payload) =>
                    `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "model-a", ...payload })}\n\n`,
                )
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        });
        expect(r.rows[0].status, r.rows[0].detail).toBe(answer ? "passed" : "failed");
        if (answer) expect(bodies).toHaveLength(3);
        else expect(bodies.length).toBeGreaterThanOrEqual(3);
        expect(sessions.every(Boolean)).toBe(true);
        expect(new Set(sessions).size).toBe(1);
        expect(
          bodies[2].messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id),
        ).toEqual(["call-1", "call-2"]);
      } finally {
        await rm(f.dir, { recursive: true, force: true });
      }
    },
  );
  it("超时传入实际请求，后续用例仍有结果", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, timeoutMs: 100, repetitions: 1 }),
      );
      const r = await runRegression({
        ...f.options,
        transport: async (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) reject(new Error("aborted"));
            else
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
          }),
      });
      expect(r.rows).toHaveLength(2);
      expect(r.rows.every((x) => x.status === "failed" && x.detail.includes("超时"))).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("取消后停止发新请求，并保留未测项目", async () => {
    const f = await fixture();
    const abort = new AbortController();
    let calls = 0;
    try {
      const r = await runRegression({
        ...f.options,
        signal: abort.signal,
        transport: async () => {
          calls++;
          abort.abort();
          throw new Error("aborted");
        },
      });
      expect(calls).toBe(1);
      expect(r.rows.slice(1).every((x) => x.status === "untested")).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("Messages 路径保留可见思考长度，原始 usage 缺失不补零", async () => {
    const f = await fixture("anthropic-messages");
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, repetitions: 1 }));
      const r = await runRegression({
        ...f.options,
        transport: async () => {
          const events = [
            {
              type: "message_start",
              message: {
                id: "m1",
                type: "message",
                role: "assistant",
                model: "model-a",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "thinking" },
            },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "text_delta", text: architectureAnswer },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 20 },
            },
            { type: "message_stop" },
          ];
          return new Response(
            events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      expect(
        r.rows.every(
          (x) => x.status === "passed" && x.reasoningTokens === null && x.reasoningCharacters === 8,
        ),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("Responses 路径读取原始思考 usage，不把文本长度当 token", async () => {
    const f = await fixture("openai-responses");
    try {
      await writeFile(f.options.listFile, JSON.stringify({ ...f.list, repetitions: 1 }));
      const r = await runRegression({
        ...f.options,
        transport: async () => {
          const events = [
            { type: "response.created", response: { id: "r1", created_at: 1, model: "model-a" } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "m1" },
            },
            { type: "response.output_text.delta", item_id: "m1", delta: architectureAnswer },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "message", id: "m1" },
            },
            {
              type: "response.completed",
              response: {
                usage: {
                  input_tokens: 10,
                  output_tokens: 25,
                  output_tokens_details: { reasoning_tokens: 20 },
                },
              },
            },
          ];
          return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      expect(
        r.rows.every(
          (x) =>
            x.status === "passed" && x.reasoningTokens === 20 && x.reasoningCharacters === null,
        ),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("单个档位 Map 求值失败不会中断整轮", async () => {
    const f = await fixture();
    try {
      const path = join(f.dir, "builtin.json");
      const release = JSON.parse(await readFile(path, "utf8"));
      release.config.modelConfigRules.modelRules[0].config.optionSpecs.reasoningLevel.map =
        'reasoningLevel == "low" ? {"reasoning_effort": "low"} : {"invalid": 1 / 0}';
      await writeFile(path, JSON.stringify(release));
      const r = await runRegression({ ...f.options, transport: async () => chatResponse() });
      expect(r.rows).toHaveLength(6);
      expect(
        r.rows.filter((x) => x.reasoningLevel === "low").every((x) => x.status === "passed"),
      ).toBe(true);
      expect(
        r.rows.filter((x) => x.reasoningLevel === "high").every((x) => x.status === "failed"),
      ).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
  it("响应回显包含 JSON 转义字符的 Key 也必须脱敏", async () => {
    const f = await fixture();
    const key = 'private-"-key';
    try {
      const cfg = JSON.parse(await readFile(f.options.providersFile, "utf8"));
      cfg.providerRules[0].config.access.apiKey = key;
      await writeFile(f.options.providersFile, JSON.stringify(cfg));
      const r = await runRegression({
        ...f.options,
        transport: async () =>
          new Response(
            (await chatResponse().text()).replace(
              JSON.stringify(architectureAnswer),
              JSON.stringify(key),
            ),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      });
      expect(r.rows.every((x) => !x.answer.includes(key))).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
