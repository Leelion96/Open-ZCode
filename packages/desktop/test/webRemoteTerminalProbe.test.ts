import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildTerminalProbeCommand } from "#e2e/helpers/web-remote-terminal-probe";

const run = promisify(execFile);

describe("MRO04 按终端目标选择探针", () => {
  it("本地探针通过 Node 输出真实父进程、目录和标记，不要求 POSIX shell", async () => {
    const command = buildTerminalProbeCommand("LOCAL", "local");
    // 本地 PowerShell 与 POSIX shell 共用 Node CLI；提取实际脚本执行，不复制探针逻辑。
    const script = command.match(/^node -e "([^"]+)"$/u)?.[1];
    expect(script).toBeTruthy();
    expect(command).not.toContain("E2E_MRO04_LOCAL");
    const { stdout } = await run(process.execPath, ["-e", script!]);
    expect(stdout.trim().split(/\r?\n/u)).toEqual([
      `PTY_OWNER=${process.pid}`,
      process.cwd(),
      "E2E_MRO04_LOCAL",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "Linux SSH 探针无需远端 Node，输出 shell PID、目录和标记",
    async () => {
      const command = buildTerminalProbeCommand("SSH", "linux-ssh");
      expect(command).not.toContain("E2E_MRO04_SSH");
      expect(command).not.toContain("node");
      const { stdout } = await run("/bin/sh", ["-c", command]);
      const [pid, cwd, marker] = stdout.trim().split(/\r?\n/u);
      expect(pid).toMatch(/^PTY_OWNER=[1-9]\d*$/u);
      expect(cwd).toBe(process.cwd());
      expect(marker).toBe("E2E_MRO04_SSH");
    },
  );
});
