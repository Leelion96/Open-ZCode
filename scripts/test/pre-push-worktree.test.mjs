import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkPushWorktree } from "../check-push-worktree.mjs";

const exec = promisify(execFile);
const zero = "0".repeat(40);
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "push-worktree-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const git = async (...args) =>
    (
      await exec(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, env },
      )
    ).stdout.trim();
  await git("init");
  await writeFile(join(cwd, "tracked"), "before");
  await git("add", ".");
  await git("-c", "core.hooksPath=", "commit", "-m", "fixture");
  const first = await git("rev-parse", "HEAD");
  await git("-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "head");
  const head = await git("rev-parse", "HEAD");
  const entry = (sha = head) => `refs/heads/main ${sha} refs/heads/main ${first}`;
  return { cwd, env, git, first, head, entry };
}

test("clean current HEAD and deletion refs pass without a unit test baseline", async (t) => {
  const f = await fixture(t);
  for (const input of ["", f.entry(), f.entry(zero), `${f.entry()}\n${f.entry(zero)}`])
    await checkPushWorktree(f.cwd, { ...f.env, ZCODE_PRE_PUSH_STDIN: input });
});

for (const state of ["untracked", "unstaged", "staged"]) {
  test(`rejects ${state} work without modifying the index or files`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.cwd, state === "untracked" ? "new" : "tracked"), "after");
    if (state === "staged") await f.git("add", "tracked");
    const before = await f.git("status", "--porcelain");
    await assert.rejects(checkPushWorktree(f.cwd, f.env), /不干净/);
    assert.equal(await f.git("status", "--porcelain"), before);
  });
}

test("rejects malformed refs and every non-HEAD target in a multi-ref push", async (t) => {
  const f = await fixture(t);
  for (const input of [f.entry(f.first), `${f.entry()}\n${f.entry(f.first)}`])
    await assert.rejects(
      checkPushWorktree(f.cwd, { ...f.env, ZCODE_PRE_PUSH_STDIN: input }),
      /HEAD/,
    );
  for (const input of ["bad input", "refs/heads/main nope refs/heads/main nope"])
    await assert.rejects(
      checkPushWorktree(f.cwd, { ...f.env, ZCODE_PRE_PUSH_STDIN: input }),
      /无效/,
    );
});

// 附注标签的对象 SHA 与 commit 不同；发布工具同时推送分支和标签时必须按目标 commit 校验。
test("accepts annotated HEAD tags in multi-ref pushes and rejects tags of older commits", async (t) => {
  const f = await fixture(t);
  await f.git("-c", "tag.gpgsign=false", "tag", "-a", "head-tag", "-m", "head", f.head);
  await f.git("-c", "tag.gpgsign=false", "tag", "-a", "old-tag", "-m", "old", f.first);
  const tagEntry = async (name) =>
    `refs/tags/${name} ${await f.git("rev-parse", name)} refs/tags/${name} ${zero}`;
  await checkPushWorktree(f.cwd, {
    ...f.env,
    ZCODE_PRE_PUSH_STDIN: `${f.entry()}\n${await tagEntry("head-tag")}`,
  });
  await assert.rejects(
    checkPushWorktree(f.cwd, { ...f.env, ZCODE_PRE_PUSH_STDIN: await tagEntry("old-tag") }),
    /HEAD/,
  );
});
