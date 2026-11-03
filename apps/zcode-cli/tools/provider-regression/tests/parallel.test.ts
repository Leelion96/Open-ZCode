import { describe, expect, it } from "vitest";
import { readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { runRegression } from "#public";
import { fixture, chatResponse, secret } from "#test/fixture";
import { renderHtmlReport, parseReport } from "#regression/html";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function saved(root: string) {
  const runs = await readdir(root);
  expect(runs).toHaveLength(1);
  return JSON.parse(await readFile(join(root, runs[0], "report.json"), "utf8"));
}

describe("parallel regression and durable reports", () => {
  it("三级并行同时生效，Provider 覆盖逐字段继承，实例只执行一次", async () => {
    const f = await fixture();
    try {
      const cfg = JSON.parse(await readFile(f.options.providersFile, "utf8"));
      cfg.providerRules = ["a", "b", "c"].map((id) => ({
        ...cfg.providerRules[0],
        providerId: id,
        config: {
          ...cfg.providerRules[0].config,
          api: { type: "openai-chat-completions", baseUrl: `https://${id}.example.com/v1` },
        },
      }));
      await writeFile(f.options.providersFile, JSON.stringify(cfg));
      const builtinPath = join(f.dir, "builtin.json");
      const builtin = JSON.parse(await readFile(builtinPath, "utf8"));
      builtin.config.providerConfigRules.templateRules[0].config.builtinModelIds = [
        "model-a",
        "model-b",
      ];
      await writeFile(builtinPath, JSON.stringify(builtin));
      await writeFile(
        f.options.listFile,
        JSON.stringify({
          ...f.list,
          repetitions: 1,
          concurrency: { providers: 2, models: 2, cases: 2 },
          targets: [
            { providerId: "a", modelIds: ["*"], concurrency: { models: 1, cases: 1 } },
            { providerId: "b", modelIds: ["*"], concurrency: { cases: 2 } },
            { providerId: "c", modelIds: ["*"] },
          ],
        }),
      );
      const gate = deferred();
      const ready = deferred();
      const active = new Map<string, number>();
      const seen = new Set<string>();
      let count = 0;
      const running = runRegression({
        ...f.options,
        transport: async (url, init) => {
          const provider = new URL(String(url)).hostname.split(".")[0];
          const body = JSON.parse(String(init?.body));
          const key = `${provider}/${body.model}`;
          const identity = `${key}/${body.reasoning_effort}`;
          expect(seen.has(identity)).toBe(false);
          seen.add(identity);
          active.set(key, (active.get(key) ?? 0) + 1);
          expect(new Set([...active.keys()].map((k) => k.split("/")[0])).size).toBeLessThanOrEqual(
            2,
          );
          expect(
            [...active.keys()].filter((k) => k.startsWith(provider + "/")).length,
          ).toBeLessThanOrEqual(provider === "a" ? 1 : 2);
          expect(active.get(key)).toBeLessThanOrEqual(provider === "a" ? 1 : 2);
          if (++count === 5) ready.resolve();
          await gate.promise;
          await setImmediate();
          const remaining = active.get(key)! - 1;
          if (remaining) active.set(key, remaining);
          else active.delete(key);
          return chatResponse();
        },
      });
      await Promise.race([
        ready.promise,
        running.then(() => {
          throw new Error("expected concurrent requests");
        }),
      ]);
      expect(count).toBe(5);
      gate.resolve();
      const report = await running;
      expect(report.rows).toHaveLength(12);
      expect(report.rows.every((r) => r.status === "passed")).toBe(true);
      expect(count).toBe(12);
      expect(report.execution?.targets[1].concurrency).toEqual({ models: 2, cases: 2 });
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("开始前已有全计划，逐项保存，取消保留成功项并区分在途与未启动", async () => {
    const f = await fixture();
    const abort = new AbortController();
    let calls = 0;
    try {
      const report = await runRegression({
        ...f.options,
        signal: abort.signal,
        transport: async () => {
          const snapshot = await saved(f.options.outputDir);
          expect(snapshot.rows).toHaveLength(6);
          if (++calls === 1) {
            expect(snapshot.rows.map((r: { status: string }) => r.status)).toEqual([
              "running",
              ...Array(5).fill("pending"),
            ]);
            return chatResponse();
          }
          expect(snapshot.rows[0].status).toBe("passed");
          expect(snapshot.rows[1].status).toBe("running");
          expect(JSON.stringify(snapshot)).not.toContain(secret);
          abort.abort();
          throw new Error("aborted");
        },
      });
      expect(calls).toBe(2);
      expect(report.status).toBe("cancelled");
      expect(report.rows.map((r) => r.status)).toEqual([
        "passed",
        "cancelled",
        ...Array(4).fill("untested"),
      ]);
      expect((await saved(f.options.outputDir)).rows).toEqual(report.rows);
      if (process.platform !== "win32") {
        expect(
          (await stat(join(f.options.outputDir, report.runId!, "report.json"))).mode & 0o777,
        ).toBe(0o600);
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("默认预算使用模型上限，显式大预算不受旧 32768 上限限制", async () => {
    const f = await fixture();
    try {
      const builtinPath = join(f.dir, "builtin.json");
      const builtin = JSON.parse(await readFile(builtinPath, "utf8"));
      builtin.config.modelConfigRules.modelRules[0].config.optionSpecs.maxOutputTokens.max = 524288;
      await writeFile(builtinPath, JSON.stringify(builtin));
      for (const budget of [undefined, 100000, 600000]) {
        await writeFile(
          f.options.listFile,
          JSON.stringify({ ...f.list, repetitions: 1, maxOutputTokens: budget }),
        );
        const report = await runRegression({
          ...f.options,
          transport: async (_url, init) => {
            expect(JSON.parse(String(init?.body)).max_tokens).toBe(
              Math.min(budget ?? 524288, 524288),
            );
            return chatResponse();
          },
        });
        expect(report.rows.every((r) => r.status === "passed")).toBe(true);
        expect(report.rows[0].maxOutputTokens).toBe(Math.min(budget ?? 524288, 524288));
      }
      expect(await readdir(f.options.outputDir)).toHaveLength(3);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("输出限制用例仍使用小预算，普通用例使用模型预算", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.options.listFile,
        JSON.stringify({
          ...f.list,
          repetitions: 1,
          caseIds: ["OUTPUT-001"],
          maxOutputTokens: undefined,
        }),
      );
      const report = await runRegression({
        ...f.options,
        transport: async (_url, init) => {
          expect(JSON.parse(String(init?.body)).max_tokens).toBe(1024);
          return chatResponse(undefined, "length");
        },
      });
      expect(report.rows[0].status).toBe("passed");
      expect(report.rows[0].maxOutputTokens).toBe(1024);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("拒绝重复 Provider 与非法并行数，在请求前失败", async () => {
    const f = await fixture();
    try {
      for (const change of [
        { targets: [...f.list.targets, ...f.list.targets] },
        { concurrency: { cases: 0 } },
        { concurrency: { models: 1.5 } },
        { targets: [{ ...f.list.targets[0], concurrency: { providers: 2 } }] },
      ]) {
        await writeFile(f.options.listFile, JSON.stringify({ ...f.list, ...change }));
        await expect(runRegression(f.options)).rejects.toThrow();
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  it("离线 HTML 保留分组、失败和未完成状态，旧报告可读且不执行外部 HTML", async () => {
    const f = await fixture();
    try {
      const report = await runRegression({ ...f.options, dryRun: true });
      report.rows[0].answer = '<script>alert("x")</script><img src="https://example.com/track">';
      report.rows[0].status = "running";
      report.rows[1].status = "failed";
      report.rows[1].finishReason = "length";
      const html = renderHtmlReport(parseReport(JSON.parse(JSON.stringify(report))));
      expect(html).toContain("test-a");
      expect(html).toContain("model-a");
      expect(html).toContain("未完成");
      expect(html).toContain("length");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img src=");
      expect(html).not.toContain(secret);
      const { schemaVersion: _v, runId: _id, status: _s, execution: _e, ...legacy } = report;
      expect(renderHtmlReport(parseReport(legacy))).toContain("未记录");
      expect(() => parseReport({ rows: [{}] })).toThrow();
      expect(() => parseReport({ ...report, schemaVersion: 99 })).toThrow();
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
