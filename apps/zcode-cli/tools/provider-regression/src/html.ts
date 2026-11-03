import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { RegressionReport, RegressionRow } from "#contract";
import { atomicWrite } from "#regression/persistence";
import { median } from "#regression/report";

const count = z.number().int().nonnegative();
const metric = z.number().nonnegative().nullable();
const parallel = z.object({ models: count.positive(), cases: count.positive() });
const reportSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  runId: z.string().optional(),
  status: z.enum(["running", "completed", "cancelled", "error"]).optional(),
  startedAt: z.string(),
  updatedAt: z.string().optional(),
  endedAt: z.string().nullable().optional(),
  configHash: z.string(),
  listHash: z.string(),
  revision: count,
  dryRun: z.boolean(),
  execution: z
    .object({
      concurrency: parallel.extend({ providers: count.positive() }),
      targets: z.array(
        z.object({ providerId: z.string(), modelIds: z.array(z.string()), concurrency: parallel }),
      ),
    })
    .optional(),
  reasoningTask: z.object({
    id: z.string(),
    prompt: z.string(),
    maxOutputTokens: count.positive().nullable(),
    timeoutMs: count.positive(),
  }),
  rows: z.array(
    z.object({
      providerId: z.string(),
      modelId: z.string(),
      caseId: z.string(),
      reasoningLevel: z.string(),
      repetition: count.positive(),
      status: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "skipped",
        "untested",
        "cancelled",
        "review",
      ]),
      startedAt: z.string().nullable().optional(),
      endedAt: z.string().nullable().optional(),
      maxOutputTokens: count.positive().optional(),
      executionPath: z.enum(["session", "websearch-handler", "adapter-probe"]).optional(),
      requestCount: count.optional(),
      detail: z.string(),
      reasoningTokens: metric,
      reasoningCharacters: metric,
      firstTextMs: metric,
      durationMs: metric,
      finishReason: z.string().nullable(),
      answer: z.string(),
      requestParameters: z.array(z.record(z.string(), z.unknown())),
      parameterCheck: z.enum(["matched", "mismatch", "unobserved"]),
    }),
  ),
});

export function parseReport(value: unknown): RegressionReport {
  return reportSchema.parse(value);
}
const escape = (value: unknown) =>
  String(value ?? "未提供")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const labels: Record<RegressionRow["status"], string> = {
  pending: "未完成（排队）",
  running: "未完成（执行中）",
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  untested: "未执行",
  cancelled: "已取消",
  review: "待复核",
};
function summary(rows: RegressionRow[]) {
  return Object.entries(labels)
    .map(([status, label]) => `${label} ${rows.filter((r) => r.status === status).length}`)
    .join(" · ");
}
function table(headers: string[], rows: unknown[][]) {
  return `<div class="scroll"><table><thead><tr>${headers.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((v) => `<td>${escape(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderHtmlReport(report: RegressionReport): string {
  const groups = new Map<string, Map<string, RegressionRow[]>>();
  for (const row of report.rows) {
    let models = groups.get(row.providerId);
    if (!models) {
      models = new Map();
      groups.set(row.providerId, models);
    }
    const rows = models.get(row.modelId) ?? [];
    rows.push(row);
    models.set(row.modelId, rows);
  }
  const terminal = report.rows.filter(
    (r) => r.status !== "pending" && r.status !== "running",
  ).length;
  const runStatus =
    report.status === "running"
      ? "未收尾（可能仍在运行，也可能已中断）"
      : report.status === "completed"
        ? "本轮已结束（通过情况见用例结果）"
        : report.status === "cancelled"
          ? "本轮已取消"
          : report.status === "error"
            ? "运行错误"
            : "未记录（旧版结果）";
  const content = [...groups]
    .map(([provider, models]) => {
      const target = report.execution?.targets.find((t) => t.providerId === provider);
      return `<section><h2>${escape(provider)}</h2><p>模型并行：${escape(target?.concurrency.models ?? "未记录")} · 每模型用例并行：${escape(target?.concurrency.cases ?? "未记录")}</p>${[
        ...models,
      ]
        .map(([model, rows]) => {
          const reasoning = rows.filter((r) => r.caseId === "REASON-001");
          const levels = [...new Set(reasoning.map((r) => r.reasoningLevel))];
          return `<article><h3>${escape(model)}</h3><p>${escape(summary(rows))}</p>
        ${table(
          [
            "用例",
            "档位",
            "次序",
            "结果",
            "执行路径",
            "请求次数",
            "输出预算",
            "思考 token",
            "思考字符",
            "首正文 ms",
            "总 ms",
            "结束原因",
            "参数核验",
          ],
          rows.map((r) => [
            r.caseId,
            r.reasoningLevel,
            r.repetition,
            labels[r.status],
            r.executionPath ?? "未记录",
            r.requestCount ?? "未记录",
            r.executionPath === "session"
              ? "产品动态预算（见请求参数）"
              : (r.maxOutputTokens ?? "未记录"),
            r.reasoningTokens,
            r.reasoningCharacters,
            r.firstTextMs,
            r.durationMs,
            r.finishReason,
            r.parameterCheck,
          ]),
        )}
        ${
          reasoning.length
            ? `<h4>同题思考档位比较</h4><p>单次结果见上表；下表仅汇总通过样本的中位数，样本数为 1 时就是该次观测。截断、失败或未完成项不参与汇总；未知指标不补零。</p>${table(
                [
                  "档位",
                  "通过 / 总数",
                  "思考 token（样本数）",
                  "思考字符（样本数）",
                  "首正文 ms",
                  "总 ms",
                ],
                levels.map((level) => {
                  const all = reasoning.filter((r) => r.reasoningLevel === level);
                  const passed = all.filter((r) => r.status === "passed");
                  const stat = (key: "reasoningTokens" | "reasoningCharacters") =>
                    `${median(passed.map((r) => r[key])) ?? "未提供"} (${passed.filter((r) => r[key] !== null).length})`;
                  return [
                    level,
                    `${passed.length} / ${all.length}`,
                    stat("reasoningTokens"),
                    stat("reasoningCharacters"),
                    median(passed.map((r) => r.firstTextMs)),
                    median(passed.map((r) => r.durationMs)),
                  ];
                }),
              )}`
            : ""
        }
        ${rows.map((r) => `<details><summary>${escape(`${r.caseId} / ${r.reasoningLevel} / ${r.repetition} · ${labels[r.status]}`)}</summary><p>${escape(r.detail)}</p><p>开始：${escape(r.startedAt ?? "未记录")} · 结束：${escape(r.endedAt ?? "未记录")}</p><h4>请求参数</h4><pre>${escape(JSON.stringify(r.requestParameters, null, 2))}</pre><h4>最终回答</h4><pre>${escape(r.answer || "尚无最终回答")}</pre></details>`).join("")}
      </article>`;
        })
        .join("")}</section>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Provider 模型回归报告</title><style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.6;background:light-dark(#f6f7f9,#151719);color:light-dark(#19212c,#e6e9ee)}
    body{max-width:1400px;margin:auto;padding:24px}h1,h2,h3{line-height:1.3}section,header{background:light-dark(#fff,#21252a);border:1px solid light-dark(#d8dee6,#414953);border-radius:12px;padding:24px;margin-bottom:24px}article{border-top:1px solid light-dark(#d8dee6,#414953);padding:16px 0}p,summary,pre{overflow-wrap:anywhere}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px;text-align:left;border-bottom:1px solid light-dark(#d8dee6,#414953);white-space:nowrap}th{background:light-dark(#eef1f5,#30363d)}details{border:1px solid light-dark(#d8dee6,#414953);border-radius:6px;padding:12px;margin:12px 0}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;font-family:ui-monospace,monospace}progress{width:100%;accent-color:#5389e8}@media(max-width:600px){body{padding:10px}section,header{padding:14px}}@media print{body{max-width:none}.scroll{overflow:visible}th,td{white-space:normal}}
    </style></head><body><header><h1>Provider 模型回归报告</h1><p>session：ZCode 会话；websearch-handler：产品搜索；adapter-probe：底层专项。待复核不等于适配失败；专项失败不直接代表 App 故障。</p><p>${escape(runStatus)} · ${report.dryRun ? "仅预览，未调用模型" : "实际执行"}</p><p>已有结果 ${terminal} / ${report.rows.length}</p><progress aria-label="已记录结果进度" max="${Math.max(1, report.rows.length)}" value="${terminal}"></progress><p>${escape(summary(report.rows))}</p><p>运行：${escape(report.runId ?? "未记录")}<br>开始：${escape(report.startedAt)}<br>快照：${escape(report.updatedAt ?? "未记录")}<br>结束：${escape(report.endedAt ?? "未记录")}<br>revision：${report.revision}<br>配置指纹：${escape(report.configHash)}<br>清单指纹：${escape(report.listHash)}</p><p>全局并行配置：${escape(report.execution ? JSON.stringify(report.execution.concurrency) : "未记录")}</p><p>测试输出预算：${escape(report.reasoningTask.maxOutputTokens ?? "使用各模型配置上限")} · 单项超时：${report.reasoningTask.timeoutMs} ms</p><details><summary>思考题：${escape(report.reasoningTask.id)}</summary><pre>${escape(report.reasoningTask.prompt)}</pre></details><p>架构题通过仅表示请求、参数和非空回答通过；设计质量待人工评审。长度不要求单调增长，并行耗时仅作本轮观测，不作为严格性能基准。未完成状态不能据此判断进程是否仍在运行。不保存思考正文。</p></header>${content}</body></html>`;
}

export async function generateHtmlReport(input: string, output?: string): Promise<string> {
  const destination = resolve(output ?? join(dirname(resolve(input)), "report.html"));
  if (destination === resolve(input)) throw new Error("HTML 输出不能覆盖 JSON 输入");
  const report = parseReport(JSON.parse(await readFile(input, "utf8")));
  await atomicWrite(destination, renderHtmlReport(report));
  return destination;
}
