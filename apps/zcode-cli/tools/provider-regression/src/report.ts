import type { RegressionReport } from "#contract";

export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) result = result.split(secret).join("[REDACTED]");
  // 通用 Key 前缀只在词边界匹配，避免误删 task-platform 等普通标识中的 sk-。
  return result
    .replace(/\bsk-[\w-]+/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"\\]+/gi, "$1[REDACTED]");
}
export function median(values: (number | null)[]): number | null {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const cell = (value: unknown) =>
  String(value ?? "未提供")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
export function renderReport(report: RegressionReport): string {
  const counts = [
    "passed",
    "review",
    "failed",
    "skipped",
    "untested",
    "cancelled",
    "pending",
    "running",
  ]
    .map((s) => `${s}: ${report.rows.filter((r) => r.status === s).length}`)
    .join(" · ");
  const lines = [
    "# Provider 回归报告",
    "",
    `时间：${report.startedAt} · revision ${report.revision} · ${report.dryRun ? "仅预览" : "实际执行"}`,
    `配置指纹：${report.configHash}`,
    `清单指纹：${report.listHash}`,
    "",
    counts,
    "执行路径：session = ZCode 会话；websearch-handler = 产品搜索；adapter-probe = 底层专项。review = 待复核；专项失败不直接代表 App 故障。",
    "",
    `思考题：${report.reasoningTask.id} · 配置输出预算：${report.reasoningTask.maxOutputTokens ?? "模型上限"} token（实际受模型上限约束） · 超时：${report.reasoningTask.timeoutMs} ms`,
    "",
    report.reasoningTask.prompt
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    "",
    "架构题通过仅表示调用、参数和非空回答通过，设计质量待人工评审。",
    "",
    "| Provider | 模型 | 用例 | 档位 | 次数 | 结果 | 执行路径 | 请求次数 | 思考 token | 可见思考字符 | 首正文 ms | 总 ms | 参数核验 | 说明 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of report.rows)
    lines.push(
      `| ${[r.providerId, r.modelId, r.caseId, r.reasoningLevel, r.repetition, r.status, r.executionPath, r.requestCount, r.reasoningTokens, r.reasoningCharacters, r.firstTextMs, r.durationMs, r.parameterCheck, r.detail].map(cell).join(" | ")} |`,
    );
  lines.push(
    "",
    "## 同题逐档比较（中位数）",
    "",
    "只使用通过且有该指标的样本；未提供不补零。可见文本可能是摘要，长度差异不是档位生效的唯一判据。",
    "",
    "| Provider | 模型 | 档位 | 通过/总数 | 思考 token（样本数） | 字符（样本数） | 首正文 ms | 总 ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  const groups = new Map<string, typeof report.rows>();
  for (const r of report.rows.filter((r) => r.caseId === "REASON-001")) {
    const key = JSON.stringify([r.providerId, r.modelId, r.reasoningLevel]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const passed = rows.filter((r) => r.status === "passed");
    const first = rows[0];
    const stat = (key: "reasoningTokens" | "reasoningCharacters") =>
      `${cell(median(passed.map((r) => r[key])))} (${passed.filter((r) => r[key] !== null).length})`;
    lines.push(
      `| ${[first.providerId, first.modelId, first.reasoningLevel, `${passed.length}/${rows.length}`, stat("reasoningTokens"), stat("reasoningCharacters"), median(passed.map((r) => r.firstTextMs)), median(passed.map((r) => r.durationMs))].map(cell).join(" | ")} |`,
    );
  }
  lines.push("", "## 架构题最终回答（供人工评审）", "");
  for (const r of report.rows.filter((r) => r.caseId === "REASON-001" && r.answer)) {
    lines.push(
      `### ${cell(r.providerId)} / ${cell(r.modelId)} / ${cell(r.reasoningLevel)} / 第 ${r.repetition} 次`,
      "",
      r.answer
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
      "",
    );
  }
  lines.push("", "不保存思考正文。此结果只覆盖列出的模型和用例，未验证上下文及输出容量上界。", "");
  return lines.join("\n");
}
