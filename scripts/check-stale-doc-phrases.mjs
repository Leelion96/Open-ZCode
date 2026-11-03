#!/usr/bin/env node
// 规则改了以后，旧说法常留在别的文档里（同一条规则在多处复述）。这里登记已作废的说法，
// 在当前事实文档里出现即失败。历史计划与重构记录保留当时的写法，不检查。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_ROOTS = ["docs", "apps/zcode-cli/docs"];
const EXCLUDED_PREFIXES = ["docs/plans/", "docs/v4-refactor/"];

const STALE_PHRASES = [
  {
    pattern: /drain (exactly|at most) one guide|one guided drain|最多一条进入同一 turn/i,
    rule: "同一边界一次取出全部已等待的 guide（turn-steering.md「Drain 边界」）",
  },
  {
    pattern: /triggerInputId/,
    rule: "工作段按 guided user 的 triggerEntityId 切分",
  },
  {
    pattern: /hook additional context 拼/i,
    rule: "工具 Hook 文本是批次后的 tool_hook_context 附件，不拼进 tool result（hooks.md「聚合规则」）",
  },
];

async function listMarkdownFiles(dir) {
  const entries = await readdir(join(REPO_ROOT, dir), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${dir}/${entry.name}`;
      if (EXCLUDED_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix))) return [];
      if (entry.isDirectory()) return listMarkdownFiles(path);
      return entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat();
}

const files = (await Promise.all(SCAN_ROOTS.map(listMarkdownFiles))).flat();
const findings = [];
for (const file of files) {
  const lines = (await readFile(join(REPO_ROOT, file), "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const { pattern, rule } of STALE_PHRASES) {
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${line.trim()}\n  -> ${rule}`);
    }
  });
}

if (findings.length > 0) {
  console.error(`Stale doc phrases found (${findings.length}):\n${findings.join("\n")}`);
  process.exit(1);
}
console.log(`No stale doc phrases in ${files.length} files.`);
