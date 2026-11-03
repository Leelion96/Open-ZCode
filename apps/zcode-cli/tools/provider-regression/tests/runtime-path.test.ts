import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runRegression } from "#public";
import { selectCases } from "#regression/cases";
import { fixture, chatResponse } from "#test/fixture";

describe("product runtime regression", () => {
  it("重复工具编号归并成一次真实工具闭环", () => {
    expect(selectCases(["TOOL-001", "TOOL-002"]).map((c) => c.id)).toEqual(["TOOL-001"]);
    expect(selectCases(["TOOL-002"]).map((c) => c.id)).toEqual(["TOOL-001"]);
  });
  it("文本用例走产品会话，仅发送流式请求并使用产品来源头", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, caseIds: ["TEXT-001"], timeoutMs: 30000 }),
      );
      const requests: Record<string, unknown>[] = [];
      const report = await runRegression({
        ...f.options,
        transport: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          requests.push(body);
          expect(new Headers(init?.headers).get("x-title")).toBe("Z Code@electron");
          expect(new Headers(init?.headers).get("x-zcode-app-version")).toMatch(/^\d+\.\d+\.\d+/);
          expect(body.stream).toBe(true);
          expect(body.messages.some((m: { role: string }) => m.role === "system")).toBe(true);
          return chatResponse();
        },
      });
      expect(report.rows[0].status, report.rows[0].detail).toBe("passed");
      expect(report.rows[0].executionPath).toBe("session");
      expect(report.rows[0].maxOutputTokens).toBeUndefined();
      expect(requests).toHaveLength(1);
      const persisted = await readFile(f.options.listFile, "utf8");
      expect(persisted).toContain("TEXT-001");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});

it("搜索复用产品 handler 的低档位与流式请求，摘要无结构化来源仍成功", async () => {
  const f = await fixture("anthropic-messages");
  try {
    const path = join(f.dir, "builtin.json");
    const builtin = JSON.parse(await readFile(path, "utf8"));
    builtin.config.modelConfigRules.modelRules[0].config.properties.supportsNativeWebSearch = true;
    await writeFile(path, JSON.stringify(builtin));
    await writeFile(f.options.listFile, JSON.stringify({ ...f.list, caseIds: ["WEB-001"] }));
    const report = await runRegression({
      ...f.options,
      transport: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.stream).toBe(true);
        expect(body.reasoning_effort).toBe("low");
        expect(body.max_tokens).toBe(4096);
        const events = [
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "model-a",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "IANA example domain summary" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    expect(report.rows[0].status, report.rows[0].detail).toBe("passed");
    expect(report.rows[0].executionPath).toBe("websearch-handler");
    expect(report.rows[0].reasoningLevel).toBe("low");
    expect(report.rows[0].maxOutputTokens).toBe(4096);
    expect(report.rows[0].detail).toContain("0 项");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

it("无效 PDF 沿产品附件降级，不将无效文件直接送到供应商", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "builtin.json");
    const builtin = JSON.parse(await readFile(path, "utf8"));
    builtin.config.modelConfigRules.modelRules[0].config.properties.inputFormat.supportsPdf = true;
    await writeFile(path, JSON.stringify(builtin));
    await writeFile(join(f.dir, "invalid.pdf"), "not a PDF");
    await writeFile(
      f.options.listFile,
      JSON.stringify({
        ...f.list,
        caseIds: ["PDF-001"],
        timeoutMs: 30000,
        fixtures: {
          pdf: {
            path: "invalid.pdf",
            mediaType: "application/pdf",
            prompt: "读附件",
            expected: "value",
          },
        },
      }),
    );
    let calls = 0;
    const report = await runRegression({
      ...f.options,
      transport: async (_url, init) => {
        calls++;
        expect(String(init?.body)).not.toContain(Buffer.from("not a PDF").toString("base64"));
        expect(String(init?.body)).not.toContain('"file_data"');
        return chatResponse();
      },
    });
    expect(report.rows[0].status).toBe("review");
    expect(calls).toBe(1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

it("1 pass 保留产品瞬态错误重试，报告记录实际请求次数", async () => {
  const f = await fixture();
  vi.stubEnv("ZCODE_MODEL_RETRY_BASE_DELAY_MS", "0");
  try {
    await writeFile(
      f.options.listFile,
      JSON.stringify({ ...f.list, repetitions: 1, timeoutMs: 30000 }),
    );
    let calls = 0;
    const report = await runRegression({
      ...f.options,
      transport: async () => {
        calls++;
        return calls === 1 ? new Response("unavailable", { status: 503 }) : chatResponse();
      },
    });
    expect(report.rows.every((row) => row.status === "passed")).toBe(true);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.map((row) => row.requestCount)).toEqual([2, 1]);
  } finally {
    vi.unstubAllEnvs();
    await rm(f.dir, { recursive: true, force: true });
  }
});

it.each([true, false])(
  "MCS 两轮使用产品历史并累计指标，第二轮有思考=%s",
  async (secondReasoning) => {
    const f = await fixture();
    let clock = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      await writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, caseIds: ["SYSTEM-001"], repetitions: 1, timeoutMs: 30000 }),
      );
      let calls = 0;
      const report = await runRegression({
        ...f.options,
        transport: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const token = ++calls === 1 ? "OLD" : "BLUE-42";
          if (calls === 2) clock = 10000;
          expect(body.stream).toBe(true);
          const messages = body.messages as { role: string; content: unknown }[];
          const last = messages.at(-1)!;
          expect(last.role).toBe("system");
          expect(JSON.stringify(last.content)).toContain(token);
          expect(messages.at(-2)?.role).toBe("user");
          if (calls === 2)
            expect(
              messages.some(
                (m) => m.role === "assistant" && JSON.stringify(m.content).includes("OLD"),
              ),
            ).toBe(true);
          const response = chatResponse();
          const text = await response.text();
          const lines = text.split("\n").map((line) => {
            if (!line.startsWith("data: {")) return line;
            const chunk = JSON.parse(line.slice(6));
            if (chunk.choices[0].delta.content) chunk.choices[0].delta.content = token;
            if (calls === 2 && !secondReasoning) delete chunk.choices[0].delta.reasoning_content;
            return `data: ${JSON.stringify(chunk)}`;
          });
          return new Response(lines.join("\n"), { headers: response.headers });
        },
      });
      expect(report.rows[0].status, report.rows[0].detail).toBe("passed");
      expect(report.rows[0].executionPath).toBe("session");
      expect(report.rows[0].requestCount).toBe(2);
      expect(calls).toBe(2);
      expect(report.rows[0].reasoningCharacters).toBe(secondReasoning ? 6 : 3);
      expect(report.rows[0].firstTextMs).toBe(0);
    } finally {
      now.mockRestore();
      await rm(f.dir, { recursive: true, force: true });
    }
  },
);

it.each([
  ["pdf", "PDF-001", "supportsPdf", 8 * 1024 * 1024, true],
  ["pdf", "PDF-001", "supportsPdf", 8 * 1024 * 1024 + 1, false],
  ["image", "IMAGE-001", "supportsImage", 8 * 1024 * 1024 + 1, false],
  ["video", "VIDEO-001", "supportsVideo", 8 * 1024 * 1024 + 1, false],
] as const)(
  "素材边界：%s / %s / %s / %i 字节 / 可读取=%s",
  async (kind, caseId, property, size, accepted) => {
    const f = await fixture();
    try {
      const path = join(f.dir, "builtin.json");
      const builtin = JSON.parse(await readFile(path, "utf8"));
      builtin.config.modelConfigRules.modelRules[0].config.properties.inputFormat[property] = true;
      await writeFile(path, JSON.stringify(builtin));
      await writeFile(join(f.dir, "media.bin"), Buffer.alloc(size));
      await writeFile(
        f.options.listFile,
        JSON.stringify({
          ...f.list,
          caseIds: [caseId],
          timeoutMs: 30000,
          fixtures: {
            [kind]: {
              path: "media.bin",
              mediaType:
                kind === "pdf" ? "application/pdf" : `${kind}/${kind === "image" ? "png" : "mp4"}`,
              prompt: "读附件",
              expected: "marker",
            },
          },
        }),
      );
      const transport = vi.fn(async () => chatResponse());
      const report = await runRegression({ ...f.options, transport });
      if (accepted) {
        // 边界内的无效 PDF 仍交给产品附件链降级，测试器不另造附件处理。
        expect(transport).toHaveBeenCalledTimes(1);
        expect(report.rows[0].detail).not.toContain("8 MiB");
      } else {
        expect(transport).not.toHaveBeenCalled();
        expect(report.rows[0].status).toBe("failed");
        expect(report.rows[0].detail).toContain("8 MiB");
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  },
);
