import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeContextSourceAdapter } from "../src/context/index.js";

interface GitResponse {
  code: number;
  // 没有 git 退出码的失败：timeout 被 kill、signal 取消、git 无法启动。
  failure?: "timeout" | "abort" | "spawn";
  stdout?: string;
  stderr?: string;
}

interface GitCall {
  // 去掉开头的 `-c` 加固参数后的命令；rawArgs 是实际传给 git 的完整参数。
  args: string[];
  command: string;
  rawArgs: string[];
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    signal?: AbortSignal;
    timeout?: number;
    windowsHide?: boolean;
  };
}

const { execFileMock, gitCalls, heldGitArgs, holdGitCommands, resetGitMock, setGitResponse } =
  vi.hoisted(() => {
    const calls: GitCall[] = [];
    const responses = new Map<string, GitResponse>();
    // 设置后，git 命令先记进 held，等放行后才执行，用来证明快照命令是并行发出的。
    let gate: Promise<void> | undefined;
    const held: string[][] = [];
    const commandKey = (args: string[]) => args.join("\0");
    const withoutLeadingConfig = (args: string[]) => {
      let index = 0;
      while (args[index] === "-c" && index + 1 < args.length) index += 2;
      return args.slice(index);
    };
    const runGitMock = (command: string, rawArgs: string[], options: GitCall["options"]) => {
      const args = withoutLeadingConfig(rawArgs);
      calls.push({ args, command, options, rawArgs: [...rawArgs] });
      const response = responses.get(commandKey(args)) ?? { code: 1, stdout: "", stderr: "" };
      const stdout = response.stdout ?? "";
      const stderr = response.stderr ?? "";
      if (response.failure) {
        throw execFailure(response.failure);
      }
      if (response.code === 0) {
        return { stdout, stderr };
      }

      const error = new Error(`git exited with ${response.code}`) as Error & {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      error.code = response.code;
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    };
    const mock = vi.fn(
      (
        command: string,
        args: string[],
        options: GitCall["options"],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        try {
          const result = runGitMock(command, args, options);
          callback(null, result.stdout, result.stderr);
        } catch (error) {
          const execError = error as Error & { stderr?: string; stdout?: string };
          callback(execError, execError.stdout ?? "", execError.stderr ?? "");
        }
      },
    );
    // 与 Node execFile 的失败形状一致：timeout 时 killed 且 code 为 null；取消时是 AbortError；
    // 无法启动时 code 是字符串。
    const execFailure = (failure: NonNullable<GitResponse["failure"]>) => {
      if (failure === "abort") {
        return Object.assign(new Error("The operation was aborted"), {
          code: "ABORT_ERR",
          name: "AbortError",
        });
      }
      if (failure === "spawn") {
        return Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      }
      return Object.assign(new Error("Command failed: git"), {
        code: null,
        killed: true,
        signal: "SIGTERM",
      });
    };
    const customPromisify = Symbol.for("nodejs.util.promisify.custom");
    Object.defineProperty(mock, customPromisify, {
      value: async (command: string, args: string[], options: GitCall["options"]) => {
        if (gate) {
          held.push(withoutLeadingConfig(args));
          await gate;
        }
        return runGitMock(command, args, options);
      },
    });

    return {
      execFileMock: mock,
      gitCalls: calls,
      heldGitArgs: held,
      holdGitCommands: () => {
        let release!: () => void;
        gate = new Promise<void>((resolveGate) => {
          release = resolveGate;
        });
        return () => {
          gate = undefined;
          release();
        };
      },
      resetGitMock: () => {
        calls.length = 0;
        mock.mockClear();
        responses.clear();
        gate = undefined;
        held.length = 0;
      },
      setGitResponse: (args: string[], response: GitResponse) => {
        responses.set(commandKey(args), response);
      },
    };
  });

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

// 记录对 `.git` 的 stat，用来证明一次 context 解析只向上查找一遍。
const { gitEntryStats } = vi.hoisted(() => ({ gitEntryStats: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = ((path: Parameters<typeof actual.stat>[0], options?: { bigint?: false }) => {
    if (String(path).endsWith(".git")) gitEntryStats.push(String(path));
    return actual.stat(path, options);
  }) as typeof actual.stat;
  return { ...actual, stat };
});

const SNAPSHOT_COMMANDS = [
  ["symbolic-ref", "--short", "-q", "HEAD"],
  ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
  ["config", "user.name"],
  ["--no-optional-locks", "status", "--short", "--ignore-submodules=dirty"],
  ["--no-optional-locks", "log", "--oneline", "-n", "5"],
];
const STATUS_COMMAND = SNAPSHOT_COMMANDS[3]!;
const GIT_EXECUTABLE_NAME = process.platform === "win32" ? "git.exe" : "git";

let root: string;
let repoDirectory: string;
let nestedDirectory: string;
let worktreeDirectory: string;
let outsideDirectory: string;
// PATH 上的假 git；execFile 已被替换，它不会真的运行。
let gitBinDirectory: string;
let gitOnPath: string;
let originalPath: string | undefined;
// 临时目录的上级里有 .git 时（例如 TMPDIR 指向某个仓库内部），"不在仓库"的结论不成立。
let outsideIsReliable: boolean;

function hasGitAncestor(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return true;
    if (dirname(current) === current) return false;
  }
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zcode-git-snapshot-")));
  repoDirectory = join(root, "repo");
  nestedDirectory = join(repoDirectory, "src", "deep");
  worktreeDirectory = join(root, "worktree");
  outsideDirectory = join(root, "outside");
  await mkdir(join(repoDirectory, ".git"), { recursive: true });
  await mkdir(nestedDirectory, { recursive: true });
  await mkdir(worktreeDirectory, { recursive: true });
  // worktree / submodule 的 .git 是指向 gitdir 的文件。
  await writeFile(join(worktreeDirectory, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
  await mkdir(outsideDirectory, { recursive: true });
  outsideIsReliable = !hasGitAncestor(root);
  gitBinDirectory = join(root, "bin");
  await mkdir(gitBinDirectory, { recursive: true });
  gitOnPath = join(gitBinDirectory, GIT_EXECUTABLE_NAME);
  // 工作目录里也放一个同名程序：Windows 对裸名会先找 cwd，自动 git 不能用到它。
  for (const path of [gitOnPath, join(repoDirectory, GIT_EXECUTABLE_NAME)]) {
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
  originalPath = process.env.PATH;
  process.env.PATH = gitBinDirectory;
});

afterAll(async () => {
  // 原来没有 PATH 时删掉，不能赋 undefined：process.env 会把它存成字符串 "undefined"。
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
});

describe("resolveGitSnapshot command semantics", () => {
  beforeEach(() => {
    resetGitMock();
  });

  it("falls back to HEAD when HEAD is detached", async () => {
    setGitResponse(["symbolic-ref", "--short", "-q", "HEAD"], { code: 1 });
    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    expect((await resolveGitSnapshot(repoDirectory)).gitBranch).toBe("HEAD");
  });

  it("decides repository membership from .git without starting git", async () => {
    const adapter = createNodeContextSourceAdapter({ env: { SHELL: "/bin/zsh" } });
    for (const directory of [repoDirectory, nestedDirectory, worktreeDirectory]) {
      expect(await adapter.resolveEnvironment({ workingDirectory: directory })).toMatchObject({
        cwd: directory,
        shell: "zsh",
        isGitRepository: true,
      });
    }
    if (outsideIsReliable) {
      expect(
        await adapter.resolveEnvironment({
          workingDirectory: outsideDirectory,
          effectiveShellDisplayName: "bash",
        }),
      ).toMatchObject({ cwd: outsideDirectory, shell: "bash", isGitRepository: false });
    }
    // 修复原因：原来用 git rev-parse 判定，超时、取消、没装 git 都没有结论；现在只看文件系统。
    expect(gitCalls).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "follows a symlinked directory and ignores a dangling .git link",
    async () => {
      const linked = join(root, "repo-link");
      const dangling = join(root, "dangling");
      await symlink(repoDirectory, linked, "dir");
      await mkdir(dangling, { recursive: true });
      await symlink(join(root, "missing-git-dir"), join(dangling, ".git"));
      const { resolveIsGitRepository } = await import("../src/context/git-snapshot.js");
      expect(await resolveIsGitRepository(linked)).toBe(true);
      if (outsideIsReliable) expect(await resolveIsGitRepository(dangling)).toBe(false);
    },
  );

  // 修复原因：原来从打开时的路径（链接本身的位置）逐级向上找 .git，git 却在链接指向的真实位置运行，
  // 两边结论相反：指向仓库子目录的链接被判为"不是仓库"；仓库里指向外部的链接被判为仓库，
  // git 命令全部失败，模型看到默认值拼成的假快照。现在是否仓库按真实路径判断，与 git 一致；
  // 项目根、AGENTS.md 查找和给模型看的路径仍用打开时的路径。junction 在 Windows 上不需要权限。
  it("decides membership from the real path of a link while paths keep the opened form", async (context) => {
    // 临时目录的上级里有 .git 时，"不是仓库"的两种结论都不成立。
    if (!outsideIsReliable) context.skip();
    const home = join(root, "link-home");
    const mono = join(root, "link-mono");
    const intoRepo = join(home, "pkg");
    const outOfRepo = join(mono, "data-link");
    await mkdir(join(mono, ".git"), { recursive: true });
    await mkdir(join(mono, "packages", "pkg"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(mono, "AGENTS.md"), "mono rule\n");
    await symlink(join(mono, "packages", "pkg"), intoRepo, "junction");
    await symlink(outsideDirectory, outOfRepo, "junction");
    const adapter = createNodeContextSourceAdapter({
      env: { SHELL: "/bin/zsh", HOME: home, USERPROFILE: home },
    });
    const { resolveIsGitRepository } = await import("../src/context/git-snapshot.js");

    // 链接指向仓库子目录：是仓库；git 命令在打开时的路径下运行，cwd 也保持原样。
    expect(await resolveIsGitRepository(intoRepo)).toBe(true);
    expect(await adapter.resolveEnvironment({ workingDirectory: intoRepo })).toMatchObject({
      cwd: intoRepo,
      isGitRepository: true,
    });
    expect(await adapter.resolveGitContext({ workingDirectory: intoRepo })).toMatchObject({
      isGitRepository: true,
    });
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(new Set(gitCalls.map((call) => call.options.cwd))).toEqual(new Set([intoRepo]));
    const intoSnapshot = await adapter.resolveContextSources({ workingDirectory: intoRepo });
    expect(intoSnapshot.workingDirectory).toBe(intoRepo);
    expect(intoSnapshot.envInfo).toMatchObject({ cwd: intoRepo, isGitRepository: true });

    // 仓库里指向外部的链接：不是仓库，不启动 git；项目根仍按打开时的路径找到 mono 的 AGENTS.md。
    resetGitMock();
    expect(await resolveIsGitRepository(outOfRepo)).toBe(false);
    expect(await adapter.resolveEnvironment({ workingDirectory: outOfRepo })).toMatchObject({
      cwd: outOfRepo,
      isGitRepository: false,
    });
    expect(await adapter.resolveGitContext({ workingDirectory: outOfRepo })).toEqual({
      isGitRepository: false,
      gitStatus: "not_repo",
    });
    const outSnapshot = await adapter.resolveContextSources({
      workingDirectory: outOfRepo,
      userInstructions: { workingDirectory: outOfRepo },
    });
    expect(outSnapshot.envInfo).toMatchObject({
      cwd: outOfRepo,
      isGitRepository: false,
      gitStatus: "not_repo",
    });
    expect(outSnapshot.userInstructions?.filePath).toBe(join(mono, "AGENTS.md"));
    expect(gitCalls).toEqual([]);

    // 真实路径读不到（目录已删除）时按打开时的路径判断，不抛错。
    expect(await resolveIsGitRepository(join(mono, "deleted"))).toBe(true);
  });

  it("reads a fresh Git context for the working directory without host facts", async () => {
    const adapter = createNodeContextSourceAdapter({ env: { SHELL: "/bin/zsh" } });
    setGitResponse(["symbolic-ref", "--short", "-q", "HEAD"], { code: 0, stdout: "feature\n" });
    setGitResponse(STATUS_COMMAND, { code: 0, stdout: " M a.ts\n" });
    const context = await adapter.resolveGitContext({ workingDirectory: repoDirectory });
    expect(context).toMatchObject({
      isGitRepository: true,
      gitBranch: "feature",
      gitStatus: "dirty",
      gitStatusLines: ["M a.ts"],
    });
    expect(context).not.toHaveProperty("shell");
    expect(gitCalls.every(({ options }) => options.cwd === repoDirectory)).toBe(true);
  });

  it("keeps the local three second timeout for every git snapshot command", async () => {
    setGitResponse(["symbolic-ref", "--short", "-q", "HEAD"], { code: 0, stdout: "feature\n" });
    setGitResponse(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      code: 0,
      stdout: "origin/main\n",
    });
    setGitResponse(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], {
      code: 0,
    });
    setGitResponse(["config", "user.name"], { code: 0, stdout: "ZCode Tester\n" });
    setGitResponse(STATUS_COMMAND, {
      code: 0,
      stdout: " M tracked.txt\n",
    });
    setGitResponse(["--no-optional-locks", "log", "--oneline", "-n", "5"], {
      code: 0,
      stdout: "abc123 first commit\n",
    });

    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    const snapshot = await resolveGitSnapshot(repoDirectory);

    expect(snapshot.isGitRepository).toBe(true);
    expect(gitCalls).not.toHaveLength(0);
    expect(gitCalls.every((call) => call.command === gitOnPath)).toBe(true);
    expect(gitCalls.every((call) => call.options.cwd === repoDirectory)).toBe(true);
    expect(gitCalls.every((call) => call.options.maxBuffer === 1024 * 1024)).toBe(true);
    expect(gitCalls.every((call) => call.options.timeout === 3000)).toBe(true);
    expect(gitCalls.every((call) => call.options.windowsHide === true)).toBe(true);
  });

  it("starts the snapshot commands in parallel and keeps the result unchanged", async () => {
    setGitResponse(["symbolic-ref", "--short", "-q", "HEAD"], { code: 0, stdout: "feature\n" });
    setGitResponse(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      code: 0,
      stdout: "origin/trunk\n",
    });
    setGitResponse(["show-ref", "--verify", "--quiet", "refs/remotes/origin/trunk"], { code: 0 });
    setGitResponse(["config", "user.name"], { code: 0, stdout: "ZCode Tester\n" });
    setGitResponse(STATUS_COMMAND, { code: 0, stdout: " M a.ts\n" });
    setGitResponse(["--no-optional-locks", "log", "--oneline", "-n", "5"], {
      code: 0,
      stdout: "abc123 first\ndef456 second\n",
    });
    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    const release = holdGitCommands();
    const pending = resolveGitSnapshot(repoDirectory);
    // 修复原因：串行执行时，git 卡住的仓库每条命令都要等满 3 秒。
    await vi.waitFor(() => expect(heldGitArgs).toHaveLength(SNAPSHOT_COMMANDS.length));
    expect(heldGitArgs).toEqual(expect.arrayContaining(SNAPSHOT_COMMANDS));
    release();
    expect(await pending).toEqual({
      isGitRepository: true,
      gitBranch: "feature",
      gitMainBranch: "trunk",
      gitUser: "ZCode Tester",
      gitStatus: "dirty",
      gitStatusLines: ["M a.ts"],
      recentCommits: ["abc123 first", "def456 second"],
    });
  });

  it("drops stdout from failed optional git commands and keeps the snapshot usable", async () => {
    setGitResponse(["symbolic-ref", "--short", "-q", "HEAD"], { code: 0, stdout: "feature\n" });
    setGitResponse(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      code: 1,
      stdout: "origin/should-not-leak\n",
    });
    setGitResponse(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], {
      code: 1,
    });
    setGitResponse(["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"], {
      code: 1,
    });
    setGitResponse(["config", "user.name"], { code: 1, stdout: "Leaked User\n" });
    setGitResponse(STATUS_COMMAND, {
      code: 128,
      stdout: " M leaked.txt\n",
    });
    setGitResponse(["--no-optional-locks", "log", "--oneline", "-n", "5"], {
      code: 128,
      stdout: "abc123 leaked commit\n",
    });

    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    const snapshot = await resolveGitSnapshot(repoDirectory);

    expect(snapshot).toMatchObject({
      isGitRepository: true,
      gitBranch: "feature",
      gitMainBranch: "main",
      gitStatus: "clean",
      gitStatusLines: [],
      recentCommits: [],
    });
    expect(snapshot.gitUser).toBeUndefined();
  });

  it("walks up for .git once when resolving context sources", async () => {
    const adapter = createNodeContextSourceAdapter({ env: {} });
    gitEntryStats.length = 0;
    const snapshot = await adapter.resolveContextSources({ workingDirectory: nestedDirectory });
    expect(snapshot.envInfo).toMatchObject({ isGitRepository: true });
    // 项目根与是否在仓库用同一次查找：deep → src → repo，各 stat 一次。
    expect(gitEntryStats).toEqual([
      join(nestedDirectory, ".git"),
      join(repoDirectory, "src", ".git"),
      join(repoDirectory, ".git"),
    ]);
  });

  it("reports a directory without .git as a non-repository and starts no git", async () => {
    if (!outsideIsReliable) return;
    const adapter = createNodeContextSourceAdapter({ env: {} });
    expect(await adapter.resolveGitContext({ workingDirectory: outsideDirectory })).toEqual({
      isGitRepository: false,
      gitStatus: "not_repo",
    });
    expect(gitCalls).toEqual([]);
  });

  it.each([
    ["a timeout", { code: 0, failure: "timeout" }],
    ["an abort", { code: 0, failure: "abort" }],
    ["a missing git", { code: 0, failure: "spawn" }],
  ] as const)(
    "still reports a repository when every git command fails with %s",
    async (_label, response) => {
      const adapter = createNodeContextSourceAdapter({ env: {} });
      for (const args of SNAPSHOT_COMMANDS) setGitResponse(args, response);
      // 修复原因：git 卡住或没装时原来被记成"不是仓库"，Environment 与之后的 gitStatus 互相矛盾。
      expect(await adapter.resolveGitContext({ workingDirectory: repoDirectory })).toEqual({
        isGitRepository: true,
        gitBranch: "HEAD",
        gitMainBranch: "main",
        gitStatus: "clean",
        gitStatusLines: [],
        recentCommits: [],
      });
      const snapshot = await adapter.resolveContextSources({ workingDirectory: repoDirectory });
      expect(snapshot.envInfo).toMatchObject({ isGitRepository: true, gitStatus: "clean" });
    },
  );

  // 修复原因：自动 git 用裸名 `git` 执行，Windows 对裸名先查 cwd，工作区里的 git.exe 会被运行。
  // 现在先按 PATH 找到绝对路径再执行，查找不加工作目录。
  it("runs git by the absolute path found on PATH, never a git in the working directory", async () => {
    setGitResponse(["symbolic-ref", "--short", "-q", "HEAD"], { code: 0, stdout: "feature\n" });
    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    await resolveGitSnapshot(repoDirectory);
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(new Set(gitCalls.map((call) => call.command))).toEqual(new Set([gitOnPath]));
  });

  // 修复原因：自动 git 不是工具调用，不经过权限判定；仓库 `.git/config` 里的 fsmonitor、hooks 等
  // 会让 ZCode 自己执行仓库里的程序。每条命令都带同一组覆盖，并镜像到 GIT_CONFIG_COUNT。
  it("starts every automatic git command with the hardening overrides", async () => {
    const nullDevice = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
    const hooks = [
      "applypatch-msg",
      "pre-applypatch",
      "post-applypatch",
      "pre-commit",
      "pre-merge-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "pre-rebase",
      "post-checkout",
      "post-merge",
      "pre-push",
      "pre-receive",
      "update",
      "proc-receive",
      "post-receive",
      "post-update",
      "reference-transaction",
      "push-to-checkout",
      "pre-auto-gc",
      "post-rewrite",
      "sendemail-validate",
      "fsmonitor-watchman",
      "p4-changelist",
      "p4-prepare-changelist",
      "p4-post-changelist",
      "p4-pre-submit",
      "post-index-change",
    ];
    const pairs = [
      ["core.fsmonitor", ""],
      ["core.hooksPath", nullDevice],
      ["core.askPass", ""],
      ["protocol.ext.allow", "never"],
      ["submodule.recurse", "false"],
      ["log.showSignature", "false"],
      ["format.pretty", "medium"],
      ["gc.auto", "0"],
      ["maintenance.auto", "false"],
      ...hooks.map((hook) => [`hook.${hook}.enabled`, "false"]),
    ];
    const prefix = pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    await resolveGitSnapshot(repoDirectory);
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const call of gitCalls) {
      expect(call.rawArgs).toEqual([...prefix, ...call.args]);
      const env = call.options.env ?? {};
      expect(env.GIT_CONFIG_COUNT).toBe(String(pairs.length));
      pairs.forEach(([key, value], index) => {
        expect(env[`GIT_CONFIG_KEY_${index}`]).toBe(key);
        expect(env[`GIT_CONFIG_VALUE_${index}`]).toBe(value);
      });
    }
    expect(gitCalls.map((call) => call.args)).toContainEqual(STATUS_COMMAND);
  });

  it("drops inherited repository selectors and sets the automatic git environment", async () => {
    const saved = { ...process.env };
    // 继承来的 GIT_DIR 等会让 git 读另一个仓库；大小写不同的写法也要去掉。
    process.env.GIT_DIR = join(outsideDirectory, ".git");
    process.env.GIT_WORK_TREE = outsideDirectory;
    process.env.git_index_file = join(outsideDirectory, "index");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.pager";
    process.env.GIT_CONFIG_VALUE_0 = "evil";
    process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=evil'";
    process.env.ZCODE_GIT_SNAPSHOT_KEEP = "kept";
    delete process.env.GIT_PROXY_COMMAND;
    process.env.PATH = [gitBinDirectory, "relative-bin", ""].join(delimiter);
    try {
      const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
      await resolveGitSnapshot(repoDirectory);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const { options } of gitCalls) {
      const env = options.env ?? {};
      for (const key of ["GIT_DIR", "GIT_WORK_TREE", "git_index_file"]) {
        expect(env).not.toHaveProperty(key);
      }
      expect(env).toMatchObject({
        GIT_ALLOW_PROTOCOL: "/",
        GIT_CONFIG_PARAMETERS:
          "'alias.remote-none=version' 'alias.remote-none.command=version' 'alias.remote-/.command=version' 'fetch.bundleURI=' 'help.autocorrect=0'",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_PROXY_COMMAND: "",
        GIT_SSH_COMMAND: "false",
        GIT_TERMINAL_PROMPT: "0",
        ZCODE_GIT_SNAPSHOT_KEEP: "kept",
      });
      // 继承的 GIT_CONFIG_KEY_0 被换成加固的第一项，计数从 0 开始。
      expect(env.GIT_CONFIG_KEY_0).toBe("core.fsmonitor");
      if (process.platform !== "win32") {
        // 名为 PATH 的变量只留以 `/` 开头的条目。
        expect(env.PATH).toBe(gitBinDirectory);
      }
    }
  });

  it("passes the request signal to every git command", async () => {
    const adapter = createNodeContextSourceAdapter({ env: {} });
    const controller = new AbortController();
    setGitResponse(["symbolic-ref", "--short", "-q", "HEAD"], { code: 0, stdout: "feature\n" });
    await adapter.resolveGitContext(
      { workingDirectory: repoDirectory },
      { signal: controller.signal },
    );
    expect(gitCalls.length).toBeGreaterThan(2);
    expect(gitCalls.every(({ options }) => options.signal === controller.signal)).toBe(true);
  });
});

// 自动 git 的 PATH 只留绝对路径条目，按平台拆分。
describe("automatic git PATH", () => {
  // 修复原因：桌面 host 在 Windows 上以大写 PATH 启动 Agent，原来按 ":" 拆、只留 "/" 开头，
  // Windows 条目全部被丢掉，git 找不到 git-lfs 等外部程序。
  it("keeps drive and UNC entries on Windows for a key of any letter case", async () => {
    const { automaticGitEnv } = await import("../src/context/git-snapshot.js");
    const windowsPath =
      'C:\\Windows\\system32;.;tools;\\rooted;"C:\\Program Files\\Git LFS";\\\\server\\share\\bin;;D:';
    const kept = "C:\\Windows\\system32;C:\\Program Files\\Git LFS;\\\\server\\share\\bin";
    expect(automaticGitEnv({ PATH: windowsPath }, "win32").PATH).toBe(kept);
    const lowerCase = automaticGitEnv({ Path: windowsPath }, "win32");
    expect(lowerCase.Path).toBe(kept);
    expect(lowerCase).not.toHaveProperty("PATH");
    expect(automaticGitEnv({ PATH: ".;tools" }, "win32").PATH).toBe("\\\\.\\NUL");
  });

  it("keeps the POSIX rule for the variable named exactly PATH", async () => {
    const { automaticGitEnv } = await import("../src/context/git-snapshot.js");
    expect(automaticGitEnv({ PATH: "/usr/bin:relative::/opt/x" }, "linux").PATH).toBe(
      "/usr/bin:/opt/x",
    );
    expect(automaticGitEnv({ PATH: "relative" }, "darwin").PATH).toBe("/dev/null");
    expect(automaticGitEnv({ Path: "relative" }, "linux").Path).toBe("relative");
  });
});

describe("automatic git executable lookup", () => {
  beforeEach(() => {
    resetGitMock();
  });

  it("searches only PATH entries on Windows and skips scripts Node cannot start", async () => {
    const { findExecutableOnPath } = await import("../src/context/git-snapshot.js");
    const executables = new Set([
      "C:\\proj\\git.exe",
      "C:\\tools\\git.cmd",
      "C:\\Git\\cmd\\git.exe",
    ]);
    expect(
      await findExecutableOnPath(
        "git",
        { Path: "C:\\tools;;C:\\Git\\cmd", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        {
          cwd: "C:\\proj",
          platform: "win32",
          isExecutableFile: async (path) => executables.has(path),
        },
      ),
    ).toBe("C:\\Git\\cmd\\git.exe");
  });

  it("removes the quotes of a Windows entry and tries .com then .exe without PATHEXT", async () => {
    const { findExecutableOnPath } = await import("../src/context/git-snapshot.js");
    const executables = new Set([
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\both\\git.com",
      "C:\\both\\git.exe",
    ]);
    const lookup = (Path: string) =>
      findExecutableOnPath(
        "git",
        // PATHEXT 里没有 .EXE / .COM 也照样找到，与 Node 按裸名启动时相同。
        { Path, PATHEXT: ".CMD" },
        {
          cwd: "C:\\proj",
          platform: "win32",
          isExecutableFile: async (path) => executables.has(path),
        },
      );
    expect(await lookup('"C:\\Program Files\\Git\\cmd";C:\\both')).toBe(
      "C:\\Program Files\\Git\\cmd\\git.exe",
    );
    expect(await lookup("C:\\both")).toBe("C:\\both\\git.com");
  });

  it("skips empty PATH entries on POSIX and returns undefined when nothing is found", async () => {
    const { findExecutableOnPath } = await import("../src/context/git-snapshot.js");
    const executables = new Set(["/work/git", "/usr/bin/git"]);
    const lookup = (PATH: string) =>
      findExecutableOnPath(
        "git",
        { PATH },
        {
          cwd: "/work",
          platform: "linux",
          isExecutableFile: async (path) => executables.has(path),
        },
      );
    expect(await lookup(":/opt/empty:/usr/bin")).toBe("/usr/bin/git");
    expect(await lookup("/opt/empty")).toBeUndefined();
  });

  it("starts no git when PATH has none and looks again on the next read", async () => {
    vi.resetModules();
    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    process.env.PATH = outsideDirectory;
    try {
      expect(await resolveGitSnapshot(repoDirectory)).toEqual({
        isGitRepository: true,
        gitBranch: "HEAD",
        gitMainBranch: "main",
        gitStatus: "clean",
        gitStatusLines: [],
        recentCommits: [],
      });
      expect(gitCalls).toEqual([]);
    } finally {
      process.env.PATH = gitBinDirectory;
    }
    await resolveGitSnapshot(repoDirectory);
    expect(new Set(gitCalls.map((call) => call.command))).toEqual(new Set([gitOnPath]));
  });

  // 进程目录读不到（例如已被删除）时只跳过相对条目，绝对条目上的 git 照常找到并运行。
  it("still finds git on an absolute entry when the process directory cannot be read", async () => {
    vi.resetModules();
    const { findExecutableOnPath, resolveGitSnapshot } =
      await import("../src/context/git-snapshot.js");
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), {
        code: "ENOENT",
      });
    });
    const checked: string[] = [];
    try {
      expect(
        await findExecutableOnPath(
          "git",
          { PATH: "relbin:/usr/bin" },
          {
            platform: "linux",
            isExecutableFile: async (path) => {
              checked.push(path);
              return path === "/usr/bin/git";
            },
          },
        ),
      ).toBe("/usr/bin/git");
      await resolveGitSnapshot(repoDirectory);
    } finally {
      cwd.mockRestore();
    }
    expect(checked).toEqual(["/usr/bin/git"]);
    expect(new Set(gitCalls.map((call) => call.command))).toEqual(new Set([gitOnPath]));
  });
});
