import { spawn } from "node:child_process";
import { connect } from "node:net";

// 远端容器操作 helper：本机 Docker runner 与服务器 runner 都注入 ZCODE_E2E_SSH_CONTAINER，
// 用例用这些 helper 读写容器内文件、注入权限故障、模拟设备离线/恢复，不区分运行宿主。
// 默认以 dev 用户执行（远端 zcode-server 的运行用户），这样权限故障对产品真实生效。

export interface RemoteContainerExecOptions {
  /** 容器内用户，默认 dev；需要 root 时传 "0"。 */
  user?: string;
  /** 经 stdin 传入的内容。 */
  input?: string;
}

export interface RemoteContainerExecResult {
  stdout: string;
  stderr: string;
}

/** 读取 runner 注入的容器名；缺失时说明需要用本机 Docker runner 或服务器队列运行。 */
export function readRemoteDockerContainer(caseMarker: string): string {
  const container = process.env.ZCODE_E2E_SSH_CONTAINER?.trim();
  if (!container) {
    throw new Error(
      `${caseMarker}: 缺少 ZCODE_E2E_SSH_CONTAINER；请用本机 Docker 远端 runner 或服务器队列运行`,
    );
  }
  return container;
}

function runDocker(args: string[], input?: string): Promise<RemoteContainerExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(`docker ${args.join(" ").slice(0, 200)} 退出码 ${code}: ${stderr.trim()}`),
        );
    });
  });
}

/** 在容器内执行命令（argv 形式，不经 shell 拼接）。非零退出码抛错。 */
export function execInRemoteContainer(
  container: string,
  command: string[],
  options: RemoteContainerExecOptions = {},
): Promise<RemoteContainerExecResult> {
  return runDocker(
    [
      "exec",
      ...(options.input === undefined ? [] : ["--interactive"]),
      "--user",
      options.user ?? "dev",
      container,
      ...command,
    ],
    options.input,
  );
}

export async function readRemoteContainerFile(container: string, path: string): Promise<string> {
  return (await execInRemoteContainer(container, ["cat", "--", path])).stdout;
}

/** 写入容器内文件（自动创建父目录），用于预置远端已有内容。 */
export async function writeRemoteContainerFile(
  container: string,
  path: string,
  content: string,
): Promise<void> {
  await execInRemoteContainer(
    container,
    ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path],
    { input: content },
  );
}

/** 目录内的条目名（含隐藏项，已排序）；目录不存在时抛错。 */
export async function listRemoteContainerDirectory(
  container: string,
  path: string,
): Promise<string[]> {
  const { stdout } = await execInRemoteContainer(container, ["ls", "-A1", "--", path]);
  return stdout.split("\n").filter(Boolean).sort();
}

export async function remoteContainerPathExists(container: string, path: string): Promise<boolean> {
  try {
    await execInRemoteContainer(container, ["test", "-e", path]);
    return true;
  } catch {
    return false;
  }
}

/** 修改权限，例如 `chmodRemoteContainerPath(c, "a-w", dir)` 制造写失败；用例结束要恢复。 */
export async function chmodRemoteContainerPath(
  container: string,
  mode: string,
  path: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await execInRemoteContainer(container, [
    "chmod",
    ...(options.recursive ? ["-R"] : []),
    mode,
    "--",
    path,
  ]);
}

/** 让设备离线：停止容器（sshd 与远端 zcode-server 一起停止，容器内文件保留）。 */
export async function takeRemoteDeviceOffline(container: string): Promise<void> {
  await runDocker(["stop", "--time", "2", container]);
}

/**
 * 让设备恢复：启动容器并等待 sshd 发出握手横幅。runner 把端口固定写进 -p，
 * 容器 stop/start 后主机端口不变，用例可以继续使用原来的 ZCODE_E2E_SSH_PORT。
 */
export async function bringRemoteDeviceOnline(
  container: string,
  target: { host: string; port: number; timeoutMs?: number },
): Promise<void> {
  await runDocker(["start", container]);
  const deadline = Date.now() + (target.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (await readSshBanner(target.host, target.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`远端容器 ${container} 重新启动后 sshd 未就绪：${target.host}:${target.port}`);
}

function readSshBanner(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("data", (chunk) => finish(chunk.toString().startsWith("SSH-")));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
