import { parseArgs } from "node:util";
import { runRegression } from "#regression/run";

const HELP =
  "用法：pnpm provider:regression --providers <本地 providers.json> --list <test-list.json> [--output <报告根目录>] [--dry-run]";
async function main() {
  const { values } = parseArgs({
    options: {
      providers: { type: "string" },
      list: { type: "string" },
      output: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (!values.providers || !values.list) throw new Error(HELP);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runRegression({
      providersFile: values.providers,
      listFile: values.list,
      outputDir: values.output,
      dryRun: values["dry-run"],
      signal: abort.signal,
      onProgress: (message) => process.stdout.write(message + "\n"),
    });
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
    process.stdout.write(counts + "\n");
    if (report.status === "cancelled") process.exitCode = 130;
    else if (
      !report.dryRun &&
      report.rows.some(
        (r) => r.status === "failed" || r.status === "untested" || r.status === "review",
      )
    )
      process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch(() => {
  // 配置解析错误可能含敏感输入，不把原始 Zod/网络异常打印到终端。
  process.stderr.write(
    "测试未完成：请检查配置、清单引用及报告目录权限；已保存的结果仍可生成部分报告。" +
      "\n" +
      HELP +
      "\n",
  );
  process.exitCode = 2;
});
