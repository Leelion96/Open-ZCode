import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { fixture, chatResponse } from "#test/fixture";
import { runRegression } from "#public";
import { generateHtmlReport } from "#regression/html";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

describe("result persistence failures", () => {
  it("快照写入失败保留旧 JSON，并停止后续请求", async () => {
    const f = await fixture();
    const rename = fs.rename;
    let writes = 0;
    let calls = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      // 初始计划、首次 running 均成功；首次结果写入模拟磁盘故障。
      if (++writes === 3) throw new Error("simulated disk failure");
      return rename(...args);
    });
    try {
      await expect(
        runRegression({
          ...f.options,
          transport: async () => {
            calls++;
            return chatResponse();
          },
        }),
      ).rejects.toThrow("simulated disk failure");
      expect(calls).toBe(1);
      const [run] = await fs.readdir(f.options.outputDir);
      const path = join(f.options.outputDir, run, "report.json");
      const snapshot = JSON.parse(await fs.readFile(path, "utf8"));
      expect(snapshot.rows).toHaveLength(6);
      expect(snapshot.rows[0].status).toBe("running");
      expect(await fs.readdir(join(f.options.outputDir, run))).toEqual(["report.json"]);
      spy.mockRestore();
      expect(await generateHtmlReport(path)).toBe(join(f.options.outputDir, run, "report.html"));
    } finally {
      spy.mockRestore();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  });

  it("并发中写盘失败会取消另一个在途请求，而不继续消耗模型调用", async () => {
    const f = await fixture();
    const rename = fs.rename;
    let writes = 0;
    let calls = 0;
    let cancelled = false;
    let release!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (++writes === 4) throw new Error("disk failure during concurrent calls");
      return rename(...args);
    });
    try {
      await fs.writeFile(
        f.options.listFile,
        JSON.stringify({ ...f.list, concurrency: { cases: 2 } }),
      );
      await expect(
        runRegression({
          ...f.options,
          transport: async (_url, init) => {
            if (++calls === 1) {
              await secondStarted;
              return chatResponse();
            }
            release();
            return new Promise<Response>((_resolve, reject) => {
              const cancel = () => {
                cancelled = true;
                reject(new Error("aborted"));
              };
              if (init?.signal?.aborted) cancel();
              else init?.signal?.addEventListener("abort", cancel, { once: true });
            });
          },
        }),
      ).rejects.toThrow("disk failure");
      expect(calls).toBe(2);
      expect(cancelled).toBe(true);
    } finally {
      spy.mockRestore();
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  });

  it("强杀实际 CLI 后，已完成结果和完整计划仍可独立转换 HTML", async () => {
    const f = await fixture();
    let calls = 0;
    let reached!: () => void;
    const secondRequest = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const server = createServer((_req, res) => {
      if (++calls === 1) {
        void chatResponse()
          .text()
          .then((body) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(body);
          });
      } else {
        reached();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const cfg = JSON.parse(await fs.readFile(f.options.providersFile, "utf8"));
    cfg.providerRules[0].config.api = {
      type: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    };
    await fs.writeFile(f.options.providersFile, JSON.stringify(cfg));
    await fs.writeFile(f.options.listFile, JSON.stringify({ ...f.list, timeoutMs: 30000 }));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "--providers",
        f.options.providersFile,
        "--list",
        f.options.listFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    const exit = once(child, "exit");
    try {
      await Promise.race([
        secondRequest,
        exit.then(() => {
          throw new Error(`CLI exited early: ${output}`);
        }),
      ]);
      child.kill("SIGKILL");
      await exit;
      const root = join(f.dir, "reports");
      const [run] = await fs.readdir(root);
      const input = join(root, run, "report.json");
      const report = JSON.parse(await fs.readFile(input, "utf8"));
      expect(report.status).toBe("running");
      expect(report.rows.map((r: { status: string }) => r.status)).toEqual([
        "passed",
        "running",
        ...Array(4).fill("pending"),
      ]);
      expect(report.rows[0].answer).not.toBe("");
      expect(calls).toBe(2);
      const html = await generateHtmlReport(input);
      expect(await fs.readFile(html, "utf8")).toContain("未收尾");
      await expect(generateHtmlReport(input, input)).rejects.toThrow("不能覆盖");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fs.rm(f.dir, { recursive: true, force: true });
    }
  }, 30000);
});
