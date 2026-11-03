import { spawn } from "node:child_process";

export function gitAddedFilesSince(cwd, { since, ref = "HEAD" }) {
  // Git 会给纯日期补上当前时刻和宿主时区，导致相同 ref 的准入集合随执行时间漂移。
  // 纯日期统一取 UTC 零点；显式时间戳沿用调用方给定的边界。
  const boundary = /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00Z` : since;
  return gitFileNames(cwd, [
    "log",
    "--diff-filter=A",
    "--name-only",
    "-z",
    "--format=",
    `--since=${boundary}`,
    ref,
  ]);
}

export function gitFileNames(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const files = [];
    let pending = "";
    let stderr = "";
    // CI 持久缓存曾让 execFile 的 1 MiB 输出缓冲区溢出；流式消费路径，NUL 分隔避免转义和空白损坏。
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const names = (pending + chunk).split("\0");
      pending = names.pop() ?? "";
      for (const name of names) if (name) files.push(name);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (${signal ?? code}): ${stderr.trim()}`));
        return;
      }
      if (pending) files.push(pending);
      resolve(files);
    });
  });
}
