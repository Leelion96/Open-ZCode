/**
 * cli-session-data-files 标准调用示例：内存版端口，语义与 Node 实现一致（remove 返回删除前大小，重复删除得 0）。
 */
import type { SessionDataFilesPort } from "./contract.js";

export function createExampleSessionDataFiles(
  sessions: Record<string, number>,
  memory: Record<string, number> = {},
): SessionDataFilesPort {
  const take = (store: Record<string, number>, key: string) => {
    const bytes = store[key] ?? 0;
    delete store[key];
    return bytes;
  };
  return {
    measureSession: async (sessionId) => sessions[sessionId] ?? 0,
    removeSession: async (sessionId) => take(sessions, sessionId),
    measureMemory: async ({ workspacePath }) => memory[workspacePath] ?? 0,
    removeMemory: async ({ workspacePath }) => take(memory, workspacePath),
  };
}
