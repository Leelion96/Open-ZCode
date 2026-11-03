import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveGitSnapshot } from "../src/context/git-snapshot.js";

const execFile = promisify(execFileCallback);

// 用真实 git 验证加固确实生效：仓库配置里的 fsmonitor 不再被 ZCode 自己执行，
// 继承来的 GIT_DIR 不再把快照指向另一个仓库。
async function gitAvailable(): Promise<boolean> {
  try {
    await execFile("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, env: env ?? process.env });
  return stdout.trim();
}

const runnable = process.platform !== "win32" && (await gitAvailable());

describe.skipIf(!runnable)("automatic git hardening with a real git", () => {
  let root: string;
  let repo: string;
  let otherRepo: string;
  let marker: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-hardening-")));
    repo = join(root, "repo");
    otherRepo = join(root, "other");
    marker = join(root, "fsmonitor-ran");
    for (const [directory, branch] of [
      [repo, "alpha"],
      [otherRepo, "beta"],
    ] as const) {
      await mkdir(directory, { recursive: true });
      await git(directory, ["init", "-q"]);
      await git(directory, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    }
    const script = join(root, "fsmonitor.sh");
    await writeFile(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    await chmod(script, 0o755);
    await writeFile(join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["config", "core.fsmonitor", script]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not run the repository's fsmonitor program", async (context) => {
    await rm(marker, { force: true });
    // 对照：不加固的 git status 会执行仓库配置的 fsmonitor。不执行时这个 git 测不了，跳过。
    await git(repo, ["status", "--short"]).catch(() => "");
    if (!existsSync(marker)) context.skip();
    await rm(marker, { force: true });

    const snapshot = await resolveGitSnapshot(repo);
    expect(snapshot).toMatchObject({ isGitRepository: true, gitBranch: "alpha" });
    expect(snapshot.gitStatusLines).toEqual(["A  a.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("reads the working directory's repository even when GIT_DIR is inherited", async () => {
    const inherited = { ...process.env, GIT_DIR: join(otherRepo, ".git") };
    // 对照：带着继承的 GIT_DIR，裸 git 读的是另一个仓库。
    expect(await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], inherited)).toBe("beta");
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = inherited.GIT_DIR;
    try {
      expect((await resolveGitSnapshot(repo)).gitBranch).toBe("alpha");
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});
