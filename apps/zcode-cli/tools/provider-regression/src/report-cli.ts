import { parseArgs } from "node:util";
import { generateHtmlReport } from "#regression/html";

const HELP = "用法：pnpm provider:regression:report --input <report.json> [--output <report.html>]";
async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (!values.input) throw new Error(HELP);
  const path = await generateHtmlReport(values.input, values.output);
  process.stdout.write(`HTML 报告：${path}\n`);
}
main().catch(() => {
  process.stderr.write("报告转换失败：请检查 JSON 格式、版本和输出文件权限。\n" + HELP + "\n");
  process.exitCode = 2;
});
