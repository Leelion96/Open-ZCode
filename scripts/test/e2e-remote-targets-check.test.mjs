import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkRemoteTargetSpecs } from "../check-e2e-remote-targets.mjs";

const exec = promisify(execFile);
const command = fileURLToPath(new URL("../check-e2e-remote-targets.mjs", import.meta.url));
const spec = "conversation-session/remote-fixture.test.ts";
const declaration = `run_case fixture "test/e2e/${spec}"\n`;

async function fixture(t, queue = declaration, inventory = JSON.stringify([spec])) {
  const root = await mkdtemp(join(tmpdir(), "remote-target-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queuePath = join(root, "harness/remote/run-all-remote.sh");
  const inventoryPath = join(root, "packages/desktop/scripts/e2e-remote-target-specs.json");
  for (const [path, content] of [
    [queuePath, queue],
    [inventoryPath, inventory],
  ]) {
    if (content === null) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { root, queuePath, inventoryPath };
}

test("私有队列缺失时开源树可独立检查", async (t) => {
  const { root } = await fixture(t, null, null);
  assert.match(await checkRemoteTargetSpecs(root), /skipped/);
});

test("私有目录存在但队列丢失时不能当作开源树跳过", async (t) => {
  const { root, queuePath } = await fixture(t, null, null);
  await mkdir(dirname(queuePath), { recursive: true });
  await assert.rejects(checkRemoteTargetSpecs(root), { code: "ENOENT" });
});

test("清单一致时通过且不改写输入", async (t) => {
  const { root, queuePath, inventoryPath } = await fixture(t);
  assert.match(await checkRemoteTargetSpecs(root), /matches/);
  assert.equal(await readFile(queuePath, "utf8"), declaration);
  assert.equal(await readFile(inventoryPath, "utf8"), JSON.stringify([spec]));
});

for (const [name, inventory] of [
  ["缺失", null],
  ["损坏", "{"],
  ["漂移", "[]"],
]) {
  test(`有队列时清单${name}失败`, async (t) => {
    const { root } = await fixture(t, declaration, inventory);
    await assert.rejects(checkRemoteTargetSpecs(root));
  });
}

test("只改队列时 CLI 非零退出，独立于 affected 选测", async (t) => {
  const { root, queuePath } = await fixture(t);
  await writeFile(queuePath, declaration + 'run_case added "test/e2e/added.test.ts"\n');
  await assert.rejects(exec(process.execPath, [command], { cwd: root }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /清单已漂移/);
    return true;
  });
});

test("默认推送入口必经清单检查", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["verify:pre-push"], /&& pnpm run check:e2e-remote-targets &&/);
  assert.equal(
    pkg.scripts["check:e2e-remote-targets"],
    "node scripts/check-e2e-remote-targets.mjs",
  );
});
