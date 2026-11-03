import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { format } from "oxfmt";

const exec = promisify(execFile);
const DEFAULT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEFAULT_CONTRACT = fileURLToPath(
  new URL(
    "../../test/e2e/fixtures/telemetry/agent-step-message-scope-fields.json",
    import.meta.url,
  ),
);
const fieldName = /^[a-z][a-z0-9_]*$/u;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function loadContract(path) {
  const contract = JSON.parse(await readFile(path, "utf8"));
  if (contract.version !== 1 || !isRecord(contract.events)) throw new Error("非法埋点字段合同");
  for (const [event, rule] of Object.entries(contract.events)) {
    if (
      !fieldName.test(event) ||
      !isRecord(rule) ||
      !Array.isArray(rule.required) ||
      !Array.isArray(rule.optional) ||
      !isRecord(rule.additions) ||
      ![...rule.required, ...rule.optional, ...Object.keys(rule.additions)].every(
        (key) => typeof key === "string" && fieldName.test(key),
      )
    )
      throw new Error("非法埋点字段合同: " + event);
  }
  return contract;
}

function inspect(records, contract) {
  const errors = [];
  const additions = new Map();
  for (const [index, record] of records.entries()) {
    const event = record?.element_name;
    if (!Object.hasOwn(contract.events, event)) {
      errors.push("UNKNOWN_EVENT: record[" + index + "]");
      continue;
    }
    const rule = contract.events[event];
    const detail = record.event_extra_detail;
    if (!isRecord(detail)) {
      errors.push("TYPE_MISMATCH: " + event + ".event_extra_detail");
      continue;
    }
    for (const key of rule.required) {
      if (!Object.hasOwn(detail, key)) errors.push("MISSING_FIELD: " + event + "." + key);
    }
    const known = new Set([...rule.required, ...rule.optional, ...Object.keys(rule.additions)]);
    for (const [key, value] of Object.entries(detail)) {
      if (typeof value !== "string") errors.push("TYPE_MISMATCH: " + event + "." + key);
      if (!known.has(key))
        additions.set(event + "." + key, { event, field: key, status: "unverified" });
    }
  }
  return { errors: [...new Set(errors)].sort(), additions: [...additions.values()] };
}

const addedLines = (diff) =>
  diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

function addedLineNumbers(diff) {
  const result = new Set();
  let line = 0;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) line = Number(hunk[1]);
    else if (text.startsWith("+") && !text.startsWith("+++")) result.add(line++);
    else if (text.startsWith(" ")) line++;
  }
  return result;
}

function definitionLines(text, path, field) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    // 读取语法节点，避免注释、字符串、类型声明中的同名字段被当成生产赋值。
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === field
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

async function findEvidence(repoRoot, event, field) {
  // 字段名只作数据，不拼 shell；无法识别的动态 key 保留告知，不尝试猜测来源。
  if (!fieldName.test(field)) return undefined;
  const git = async (...args) =>
    (
      await exec("git", args, {
        cwd: repoRoot,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const hasField = (text) => new RegExp("\\b" + field + "\\b").test(text);
  const documentsEvent = (text) =>
    text
      .split(/\n\s*\n/u)
      .some(
        (paragraph) => hasField(paragraph) && new RegExp("\\b" + event + "\\b").test(paragraph),
      );
  const commits = (
    await git(
      "log",
      "HEAD",
      "--no-merges",
      "--format=%H",
      "-30",
      "-G",
      field,
      "--",
      "packages/*/src",
      "docs/monitoring",
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const paths = (await git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit))
      .trim()
      .split("\n");
    let source;
    let document;
    for (const path of paths) {
      const production =
        /^packages\/[^/]+\/src\/.+\.[cm]?[jt]sx?$/u.test(path) &&
        !/(?:^|\/)(?:test|tests|__tests__)(?:\/)|\.(?:test|spec)\./u.test(path);
      const spec = path.startsWith("docs/monitoring/") && path.endsWith(".md");
      if (!production && !spec) continue;
      const diff = await git("show", "--format=", "--unified=0", commit, "--", path);
      const added = addedLines(diff);
      if (!hasField(added)) continue;
      let current;
      try {
        current = await readFile(join(repoRoot, path), "utf8");
      } catch {
        continue;
      }
      if (production && definitionLines(current, path, field).length) {
        const changedLines = addedLineNumbers(diff);
        const original = await git("show", commit + ":" + path);
        if (definitionLines(original, path, field).some((line) => changedLines.has(line)))
          source ??= path;
      }
      if (
        spec &&
        documentsEvent(added) &&
        documentsEvent(await git("show", commit + ":" + path)) &&
        documentsEvent(current)
      )
        document ??= path;
    }
    if (source && document) return { commit, source, document };
  }
  return undefined;
}

async function mergeVerified(contractPath, candidates) {
  const verified = candidates.filter((entry) => entry.status === "verified");
  if (!verified.length) return;
  let lock;
  let temporary;
  try {
    // 只持锁重读后合并自己的新增项；并发运行不等待、不覆盖别人的归并结果。
    lock = await open(contractPath + ".lock", "wx");
    const contract = await loadContract(contractPath);
    for (const entry of verified) {
      const rule = contract.events[entry.event];
      if (
        !rule.required.includes(entry.field) &&
        !rule.optional.includes(entry.field) &&
        !Object.hasOwn(rule.additions, entry.field)
      )
        rule.additions[entry.field] = entry.evidence;
    }
    temporary = contractPath + "." + randomUUID() + ".tmp";
    const formatted = await format(contractPath, JSON.stringify(contract));
    if (formatted.errors.length) throw new Error("字段合同格式化失败");
    await writeFile(temporary, formatted.code);
    await rename(temporary, contractPath);
    for (const entry of verified) entry.status = "merged";
  } catch (error) {
    for (const entry of verified) {
      entry.status = "deferred";
      entry.reason = "合同未写入: " + (error.code ?? error.name);
    }
  } finally {
    if (temporary) await rm(temporary, { force: true });
    if (lock) {
      await lock.close();
      await rm(contractPath + ".lock", { force: true });
    }
  }
}

/**
 * 日常回归允许字段扩展；双版本严格 comparator 独立保留。
 * 调用方应先通过事件数量、消息关联等业务断言，避免把失败样本自动纳入合同。
 */
export async function auditTelemetryFields({
  records,
  contractPath = DEFAULT_CONTRACT,
  repoRoot = DEFAULT_ROOT,
  artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR,
  sync = process.env.ZCODE_E2E_TELEMETRY_FIELD_SYNC !== "0",
}) {
  const result = inspect(records, await loadContract(contractPath));
  if (!result.errors.length) {
    for (const entry of result.additions) {
      try {
        entry.evidence = await findEvidence(repoRoot, entry.event, entry.field);
        if (entry.evidence) entry.status = "verified";
        else entry.reason = "未找到同提交的生产字段赋值与对应事件 spec";
      } catch {
        entry.reason = "Git 历史不可用或查询失败";
      }
    }
    if (sync) await mergeVerified(contractPath, result.additions);
  }
  for (const entry of result.additions) {
    console.warn(
      "[telemetry-fields] 新增字段 " +
        entry.event +
        "." +
        entry.field +
        " [" +
        entry.status +
        "] " +
        (entry.evidence?.commit ?? entry.reason ?? "合同校验失败，未归并"),
    );
  }
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      join(artifactDir, "telemetry-field-audit.json"),
      JSON.stringify({ version: 1, ...result }, null, 2) + "\n",
    );
  }
  return result;
}
