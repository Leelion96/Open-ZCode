import type { ProjectTaskRef } from "#src/project-storage/contract.js";

/**
 * 彻底删除项目数据时 Host 侧的行操作（规格：docs/superpowers/specs/2026-10-24-project-management.md
 * 「彻底删除数据」）。与 ProjectRepositoryContract 同一实例、同一 Host 范围；只删本 Host 自有的行。
 */
export interface ProjectDataRepositoryContract {
  /** 项目的全部任务（含已归档、已软删除），只读本 Host 的行；cwd 是会话绑定目录。 */
  readProjectTaskRefs(id: string): Array<ProjectTaskRef & { cwd: string }>;
  /**
   * 本 Host 全部未删除任务（`deleted=0`）的项目归属与 cwd（含未归类、尚无 CLI 事实的行），用于判断目录是否仍被使用。
   * 已软删除项目的任务也在内：移除项目只改项目行，任务行仍是 `deleted=0`。`deleted=1` 只表示会话本身已删除
   * （用户删除，或 markTasksDeleted 标记的已清理行），会话无法恢复，不再占用目录。
   */
  readTaskDirectories(): Array<{ projectId: string | null; cwd: string }>;
  /** 彻底删除数据后删除这些任务的 Host 行（tasks、分组成员、分组准入）；只删本 Host 的行。 */
  purgeTasks(tasks: readonly ProjectTaskRef[]): void;
  /**
   * 把 CLI 已彻底删除、但目录尚未删完的任务标为 CLI 已删除（`deleted=1, cli_deleted=1`，清掉删除交接位）：
   * 列表不再显示，行仍在，重试时还能按这些行找回它们的 cwd。只改本 Host 的行。
   */
  markTasksDeleted(tasks: readonly ProjectTaskRef[]): void;
  /** 已软删除且不再被任务、自动化、闲时任务引用时删除项目行（roots 级联）；返回是否删除。 */
  purgeProjectIfUnreferenced(id: string): boolean;
}
