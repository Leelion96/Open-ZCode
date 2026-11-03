/**
 * cli-session-data 标准调用示例：一个不加载任何会话的最小宿主（管理面进程的情形）。
 */
import type { SessionDataFilesPort } from "@zcode/adapters/storage";
import type { SessionDataHost } from "./contract.js";

export function createExampleSessionDataHost(files: SessionDataFilesPort): SessionDataHost {
  return {
    store: {
      // 每个会话没有后代；库里不存在的根按自身 ID 处理。
      listOwnedSessionTrees: async (ids) => new Map(ids.map((id) => [id, [id]])),
      listArtifactReferrers: async () => new Map(),
      purgeSessions: async () => {},
    },
    files,
    residency: () => null,
    release: async () => {},
    forgetIndexed: () => {},
  };
}
