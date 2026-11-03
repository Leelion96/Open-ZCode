import type { IFileService } from "@zcode/services";
import {
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS,
} from "@zcode/shared";

interface RemoteWorkspaceIdentityInput {
  workspacePath: string;
  stableWorkspaceIdentity: string;
  legacyRouteHint?: string;
  signal?: AbortSignal;
}

// Bug 原因（ZCT-2113660144497782784）：截止只结束 Desktop 的等待，远端那次 readdir 仍占着 Core 的一个
// libuv 线程。用户每次重试都再发一次，4 次后 Core 线程池占满，同设备所有文件操作都不再返回。
// 修复：同一连接、同一路径上一次读取还没返回时复用它，不再发新的远端调用；返回后立即删除，不缓存结果。
// 远端 File Service 对物理连接唯一，按它的实例区分连接。
const inFlightDirectoryReads = new WeakMap<object, Map<string, Promise<unknown>>>();

function readWorkspaceDirectory(
  fileService: Pick<IFileService, "readdir">,
  workspacePath: string,
): Promise<unknown> {
  const byPath = inFlightDirectoryReads.get(fileService) ?? new Map<string, Promise<unknown>>();
  inFlightDirectoryReads.set(fileService, byPath);
  const pending = byPath.get(workspacePath);
  if (pending) return pending;
  const read = fileService.readdir({ path: `${workspacePath}/.` });
  byPath.set(workspacePath, read);
  const clear = () => {
    if (byPath.get(workspacePath) === read) byPath.delete(workspacePath);
  };
  read.then(clear, clear);
  return read;
}

// Bug 原因（R8）：远端对项目目录的文件系统调用可能永久不返回（例如 macOS 等待文件夹访问授权、
// 网络盘无响应）。这段 RPC 等待过去没有截止时间，连接一直停在“启动并检查兼容性”。
// 截止后只结束本次等待并报出卡在哪一步；远端那次调用不会因此结束，Source 连接保持在线。
export async function prepareRemoteWorkspaceIdentity(
  fileService: Pick<IFileService, "readdir">,
  input: RemoteWorkspaceIdentityInput,
  bindWorkspaceIdentity?: (input: RemoteWorkspaceIdentityInput) => Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? REMOTE_WORKSPACE_PREPARATION_TIMEOUT_MS;
  // Bug 原因：截止过去只让等待失败，不取消本次 admission。Host 的 bind 路径失败时不会 abort
  // 调用方信号，远端读目录在截止后返回，仍会继续登记身份。截止必须 abort 本次 admission。
  const deadlineController = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadlineController.signal])
    : deadlineController.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(
        new Error(
          `Remote workspace directory did not respond within ${Math.round(timeoutMs / 1000)} seconds: ${input.workspacePath}`,
        ),
        { code: REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE, retryable: true },
      );
      deadlineController.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([
      prepareWorkspace(fileService, { ...input, signal }, bindWorkspaceIdentity),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function prepareWorkspace(
  fileService: Pick<IFileService, "readdir">,
  input: RemoteWorkspaceIdentityInput,
  bindWorkspaceIdentity?: (input: RemoteWorkspaceIdentityInput) => Promise<void>,
): Promise<void> {
  input.signal?.throwIfAborted();
  const unavailable = () =>
    Object.assign(
      new Error(
        `Remote workspace directory is missing, is not a directory, or cannot be accessed: ${input.workspacePath}`,
      ),
      { code: REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE, retryable: false },
    );
  // 叶目录收回权限后 stat 仍会成功，身份映射也保存在目录之外，不能据此放行。
  // 复用远端 readdir 验证读取权限；保留末尾 /. 让远端同时检查目标目录的遍历权限。
  // 不用 path.join 归一化掉 /.，也不使用控制端的平台路径规则或本地文件系统。
  try {
    await readWorkspaceDirectory(fileService, input.workspacePath);
  } catch (error) {
    input.signal?.throwIfAborted();
    // 符号链接循环也属于目录不可用；透传 ELOOP 会跳过 Renderer 的 Host ready 通知，
    // 导致同一 Source 的其他项目无法继续恢复。
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
    ) {
      throw unavailable();
    }
    // 网络/协议错误保持原语义，不能据此判断远端目录已被删除。
    throw error;
  }
  input.signal?.throwIfAborted();
  await bindWorkspaceIdentity?.(input);
  input.signal?.throwIfAborted();
}
