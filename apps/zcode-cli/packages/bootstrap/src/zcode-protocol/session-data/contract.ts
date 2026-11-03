// cli-session-data 对外契约：v4/storage/sessionData/* 执行面依赖的窄宿主接口。
// 规格：docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」。
import type { SessionStorePort } from "@zcode/contracts";
import type { SessionDataFilesPort } from "@zcode/adapters/storage";

export interface SessionDataHost {
  store: Required<
    Pick<SessionStorePort, "listOwnedSessionTrees" | "listArtifactReferrers" | "purgeSessions">
  >;
  files: SessionDataFilesPort;
  /** 本进程已加载的会话是否在忙；未加载返回 null。 */
  residency(sessionId: string): "busy" | "idle" | null;
  /** 释放已加载的空闲会话的运行态；不发布 session.removed（删除成功前会话仍是存活事实）。 */
  release(sessionId: string): Promise<void>;
  /** 从本进程所有 sessions-index 投影中移除；会话未加载时也要做，防止下次快照复活。 */
  forgetIndexed(sessionId: string): void;
}
