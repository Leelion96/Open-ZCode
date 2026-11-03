import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";

const CONNECT_REMOTE_ERROR_PREFIX = "[connect-remote] caught error: ";

export interface ConnectRemoteFailure {
  requestId?: string;
  message: string;
  code?: string;
}

/** 按时间顺序读取 Desktop main 日志里 connect-remote 失败的结构化错误。 */
export async function readConnectRemoteFailures(): Promise<ConnectRemoteFailure[]> {
  // E2E reporter 把 desktop 日志重定向到 worker 专属目录；未接入 reporter 时落在隔离 HOME。
  const logDir =
    process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() || join(resolveE2EStorageRoot(), "v2", "logs");
  const failures: ConnectRemoteFailure[] = [];
  const names = await readdir(logDir).catch(() => []);
  for (const name of names.filter((entry) => entry.endsWith(".log")).sort()) {
    for (const line of (await readFile(join(logDir, name), "utf8")).split("\n")) {
      const index = line.indexOf(CONNECT_REMOTE_ERROR_PREFIX);
      if (index < 0) continue;
      try {
        const payload = JSON.parse(line.slice(index + CONNECT_REMOTE_ERROR_PREFIX.length)) as {
          requestId?: unknown;
          message?: unknown;
          code?: unknown;
        };
        if (typeof payload.message !== "string") continue;
        failures.push({
          message: payload.message,
          ...(typeof payload.requestId === "string" ? { requestId: payload.requestId } : {}),
          ...(typeof payload.code === "string" ? { code: payload.code } : {}),
        });
      } catch {
        // 日志行被截断时跳过，只认完整的结构化错误。
      }
    }
  }
  return failures;
}

/** 读取 Desktop main 日志里最近一次 connect-remote 失败的原始错误。 */
export async function readLastConnectRemoteError(): Promise<string | null> {
  return (await readConnectRemoteFailures()).at(-1)?.message ?? null;
}

const REMOTE_WORKSPACE_UNRESPONSIVE_MESSAGE = "Remote workspace directory did not respond within";

/**
 * 统计远程项目目录 admission 无响应的失败次数。新建连接走 connect-remote，已有连接上的重试走
 * Host 的 bind 路径（“failed to prepare bound remote workspace”），两者都要计入。
 */
export async function countRemoteWorkspaceUnresponsiveFailures(): Promise<number> {
  const logDir =
    process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() || join(resolveE2EStorageRoot(), "v2", "logs");
  let count = 0;
  const names = await readdir(logDir).catch(() => []);
  for (const name of names.filter((entry) => entry.endsWith(".log")).sort()) {
    for (const line of (await readFile(join(logDir, name), "utf8")).split("\n")) {
      if (!line.includes(REMOTE_WORKSPACE_UNRESPONSIVE_MESSAGE)) continue;
      if (
        line.includes(CONNECT_REMOTE_ERROR_PREFIX) ||
        line.includes("failed to prepare bound remote workspace")
      )
        count += 1;
    }
  }
  return count;
}
