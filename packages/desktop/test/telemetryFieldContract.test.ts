import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { auditTelemetryFields } from "../scripts/lib/telemetry-field-contract.mjs";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "telemetry-fields-"));
  roots.push(root);
  const git = (...args: string[]) =>
    exec("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  const save = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await git("init", "-b", "test");
  const contractPath = join(root, "fields.json");
  await save(
    "fields.json",
    JSON.stringify({
      version: 1,
      events: { agent_step: { required: ["status"], optional: ["provider_name"], additions: {} } },
    }),
  );
  await git("add", ".");
  await git("commit", "-m", "test: baseline");
  const records = [
    { element_name: "agent_step", event_extra_detail: { status: "success", ui_mode: "code" } },
    { element_name: "agent_step", event_extra_detail: { status: "success", ui_mode: "work" } },
  ];
  const run = (options = {}) =>
    auditTelemetryFields({
      repoRoot: root,
      contractPath,
      artifactDir: join(root, "artifacts"),
      records,
      ...options,
    });
  const introduce = async (document = "`agent_step` 增加 `ui_mode`，表示发送时的模式。") => {
    await save("packages/ui/src/telemetry.ts", 'export const detail = { ui_mode: "code" };\n');
    await save("docs/monitoring/events.md", document + "\n");
    await git("add", "packages", "docs");
    await git("commit", "-m", "feat: record interface mode");
    return (await git("rev-parse", "HEAD")).stdout.trim();
  };
  return { root, git, save, run, introduce, contractPath, records };
}

test("新增字段通过并去重告知；没有依据不更新，报告不包含字段值", async () => {
  const f = await fixture();
  const before = await readFile(f.contractPath, "utf8");
  const result = await f.run();
  assert.deepEqual(result.errors, []);
  assert.equal(result.additions.length, 1);
  assert.equal(result.additions[0].status, "unverified");
  assert.equal(await readFile(f.contractPath, "utf8"), before);
  const report = await readFile(join(f.root, "artifacts/telemetry-field-audit.json"), "utf8");
  assert.ok(report.includes("ui_mode"));
  assert.ok(!report.includes('"success"'));
});

test("同提交实现与对应事件 spec 自动归并，保留必填清单与依据，下次不重复告知", async () => {
  const f = await fixture();
  const commit = await f.introduce();
  const result = await f.run();
  assert.equal(result.additions[0].status, "merged");
  const saved = JSON.parse(await readFile(f.contractPath, "utf8"));
  assert.deepEqual(saved.events.agent_step.required, ["status"]);
  assert.equal(saved.events.agent_step.additions.ui_mode.commit, commit);
  assert.equal(saved.events.agent_step.additions.ui_mode.document, "docs/monitoring/events.md");
  assert.deepEqual((await f.run()).additions, []);
  // 自动归并是认可扩展，不把一次观察提升为每次必填。
  assert.deepEqual(
    (
      await f.run({
        records: [{ element_name: "agent_step", event_extra_detail: { status: "success" } }],
      })
    ).errors,
    [],
  );
});

test("已有必填字段缺失、改名或任意字段类型错误仍失败，失败时不归并", async () => {
  const f = await fixture();
  await f.introduce();
  for (const detail of [
    { state: "success", ui_mode: "code" },
    { status: null, ui_mode: "code" },
    { status: "success", ui_mode: 1 },
    { status: "success", provider_name: false, ui_mode: "code" },
  ]) {
    const result = await f.run({
      records: [{ element_name: "agent_step", event_extra_detail: detail }],
    });
    assert.ok(result.errors.length > 0);
    assert.ok(!result.additions.some((item) => item.status === "merged"));
  }
  assert.deepEqual(
    JSON.parse(await readFile(f.contractPath, "utf8")).events.agent_step.additions,
    {},
  );
});

test("无关事件 spec 不构成依据", async () => {
  const f = await fixture();
  await f.introduce("`app_launch` 增加 `ui_mode`。");
  assert.equal((await f.run()).additions[0].status, "unverified");
});

test("只有测试里出现字段不能证明生产实现", async () => {
  const f = await fixture();
  await f.save("packages/ui/test/telemetry.test.ts", 'const detail = { ui_mode: "code" };');
  await f.save("docs/monitoring/events.md", "`agent_step` 增加 `ui_mode`。");
  await f.git("add", ".");
  await f.git("commit", "-m", "test: fixture only");
  assert.equal((await f.run()).additions[0].status, "unverified");
});

test("生产文件里的注释或普通字符串不构成字段赋值证据", async () => {
  const f = await fixture();
  await f.save(
    "packages/ui/src/telemetry.ts",
    '// ui_mode: "code"\nexport const note = "ui_mode: code";',
  );
  await f.save("docs/monitoring/events.md", "`agent_step` 增加 `ui_mode`。");
  await f.git("add", ".");
  await f.git("commit", "-m", "docs: describe a future field");
  assert.equal((await f.run()).additions[0].status, "unverified");
});

test("其他分支和已经撤销的来源不得归并", async () => {
  const f = await fixture();
  await f.git("switch", "-c", "other");
  const commit = await f.introduce();
  await f.git("switch", "test");
  assert.equal((await f.run()).additions[0].status, "unverified");
  await f.git("cherry-pick", commit);
  await f.git("revert", "--no-edit", "HEAD");
  assert.equal((await f.run()).additions[0].status, "unverified");
});

test("只读模式报告已验证依据，不改合同", async () => {
  const f = await fixture();
  await f.introduce();
  assert.equal((await f.run({ sync: false })).additions[0].status, "verified");
  assert.deepEqual(
    JSON.parse(await readFile(f.contractPath, "utf8")).events.agent_step.additions,
    {},
  );
});

test("并发持锁时不覆盖，Git 不可用时仍允许新增并告知", async () => {
  const f = await fixture();
  await f.introduce();
  await writeFile(f.contractPath + ".lock", "another run");
  assert.equal((await f.run()).additions[0].status, "deferred");
  await rm(join(f.root, ".git"), { recursive: true, force: true });
  assert.equal((await f.run()).additions[0].status, "unverified");
});
