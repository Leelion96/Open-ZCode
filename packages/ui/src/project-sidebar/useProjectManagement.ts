import { useCallback, useRef, useState } from "react";
import type { RemoteProjectEntry, VirtualProject } from "@/project-sidebar/contract.js";
import {
  formatCountMessage,
  type ProjectManagementRow,
} from "@/project-sidebar/project-management-view.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { formatProjectError, projectKey } from "@/project-sidebar/view.js";
import { dismissToast, toast, updateToast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";

/** 本批成功移除的项；远程入口在移除前抓取，撤销时按原 projectId / roots / membership 重新登记。 */
interface RemovedProject {
  row: ProjectManagementRow;
  entry?: RemoteProjectEntry;
  membershipId?: string;
}
export interface ProjectManagementFailure {
  kind: "remove" | "undo" | "restore" | "purge";
  count: number;
  name: string;
  reason: string;
  retry(): Promise<void>;
}

/** 确认对话框里「同时删除 ZCode 数据」的测量汇总；只含本机候选。 */
export interface ProjectDataTotals {
  projects: number;
  sessions: number;
  sessionBytes: number;
  checkpointBytes: number;
  memoryBytes: number;
  totalBytes: number;
}
export interface ProjectRemovalOptions {
  /** 勾选删除数据时为确认时的测量总量；重试时可缺省（进度只按项目数推进）。 */
  deleteData?: { totalBytes?: number };
}

/** 数据只在本机删除：远程项目的数据在其设备上，入口移除也不涉及数据。 */
export const isProjectDataCandidate = (row: ProjectManagementRow) =>
  row.removal === "delete" && row.project.hostId === "local";

export function useProjectManagement() {
  const directory = useProjectDirectory();
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ProjectManagementFailure | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const latest = useRef(directory);
  latest.current = directory;
  // 横幅只展示原因本身，不带 "Error:" 前缀；已知错误码仍按项目文案翻译。
  const format = (cause: unknown) =>
    formatProjectError(cause instanceof Error ? cause.message : cause, intl.formatMessage);

  /**
   * 批次按发起顺序依次执行：不并发，也不丢弃。body 可返回结果回调，在本批刷新结束后执行（刷新失败也执行）。
   * Bugfix：原先批次在途时再发起的操作直接忽略。toast 点击后总会关闭，于是两种情况下点「撤销」
   * 都被静默吞掉、项目再也无法撤销：① 撤销 toast 在本批 refresh() 结束前弹出；② 上一批的 toast
   * 仍可见时用户又发起了新批次（远程移除可能持续数秒）。现在 toast 在本批结束后才弹，且后发的操作
   * 排队等待而不是被丢弃。排队的重复移除会因行已不在树中被跳过；撤销与恢复本身幂等。
   */
  const exclusive = (body: () => Promise<(() => void) | void>) => {
    pending.current++;
    setBusy(true);
    const run = queue.current.then(async () => {
      setFailure(null);
      let report: (() => void) | void = undefined;
      try {
        report = await body();
        await latest.current.refresh();
      } finally {
        if (--pending.current === 0) setBusy(false);
        report?.();
      }
    });
    queue.current = run.catch(() => {});
    return run;
  };
  const fail = (
    kind: ProjectManagementFailure["kind"],
    failed: { name: string; cause: unknown }[],
    retry: () => Promise<void>,
  ) => {
    if (!failed.length) return;
    setFailure({
      kind,
      count: failed.length,
      name: failed[0]!.name,
      reason: format(failed[0]!.cause),
      retry,
    });
  };

  /** 只读测量；旧 Agent 不支持、服务不可用时返回 null，对话框据此隐藏选项。 */
  // 稳定引用：对话框按「批次 + 测量函数」触发测量，函数每次渲染都变会反复重测。
  const measureData = useCallback(
    async (rows: readonly ProjectManagementRow[]): Promise<ProjectDataTotals | null> => {
      const ids = rows.filter(isProjectDataCandidate).map((row) => row.project.id);
      const service = latest.current.service;
      if (!ids.length || !service) return null;
      try {
        const { projects } = await service.measureProjectData(ids, "local");
        const sum = (pick: (entry: (typeof projects)[number]) => number) =>
          projects.reduce((total, entry) => total + pick(entry), 0);
        const totals = {
          projects: ids.length,
          sessions: sum((entry) => entry.sessions),
          sessionBytes: sum((entry) => entry.sessionBytes),
          checkpointBytes: sum((entry) => entry.checkpointBytes),
          memoryBytes: sum((entry) => entry.memoryBytes),
        };
        return {
          ...totals,
          totalBytes: totals.sessionBytes + totals.checkpointBytes + totals.memoryBytes,
        };
      } catch (cause) {
        logger.warn("[project-management] 测量项目数据失败", { count: ids.length, cause });
        return null;
      }
    },
    [],
  );

  /**
   * 逐个删除已移除本机项目的数据，期间显示常驻进度 toast。会话仍在运行而被保留、或有文件删不掉的
   * 项目算失败：它们保持软删除，可恢复，也可只重试这一步。
   */
  const purgeRows = async (rows: readonly ProjectManagementRow[], totalBytes?: number) => {
    const failed: { row: ProjectManagementRow; cause: unknown }[] = [];
    let freed = 0;
    let done = 0;
    const progress = () => ({
      value: totalBytes ? freed / totalBytes : done / rows.length,
      label: totalBytes
        ? intl.formatMessage(
            { id: "projectManagement.data.progressAmount" },
            { done: formatBytes(freed), total: formatBytes(totalBytes) },
          )
        : formatBytes(freed),
      tone: "destructive" as const,
    });
    const id = toast(formatCountMessage(intl, "projectManagement.data.progress", rows.length), {
      position: "bottom-center",
      dedupeKey: "project-management-data-progress",
      variant: "info",
      durationMs: 0,
      progress: progress(),
    });
    for (const row of rows) {
      try {
        if (!latest.current.service) throw new Error("project.service-unavailable");
        const result = await latest.current.service.deleteProjectData(row.project.id, "local");
        freed += result.freedBytes;
        if (result.runningSessions > 0) throw new Error("project.data-session-running");
        if (result.referencedSessions > 0) throw new Error("project.data-session-referenced");
        if (result.failed > 0) throw new Error("project.data-delete-failed");
      } catch (cause) {
        failed.push({ row, cause });
        logger.error("[project-management] 删除项目数据失败", {
          projectId: row.project.id,
          cause,
        });
      }
      done++;
      updateToast(id, { progress: progress() });
    }
    dismissToast(id);
    return { freed, failed };
  };

  const purge = (rows: readonly ProjectManagementRow[]) =>
    exclusive(async () => {
      const { freed, failed } = await purgeRows(rows);
      fail(
        "purge",
        failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
        () => purge(failed.map(({ row }) => row)),
      );
      const succeeded = rows.length - failed.length;
      if (!succeeded) return;
      return () =>
        resultToast(
          formatCountMessage(intl, "projectManagement.data.deletedToast", succeeded, {
            size: formatBytes(freed),
          }),
        );
    });

  const resultToast = (message: string) =>
    toast(message, {
      position: "bottom-center",
      dedupeKey: "project-management-result",
      variant: "success",
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "projectManagement.dismiss" }),
    });

  /** purgeAlso：已移除、只差数据删除的项目（上一批数据删除失败、随移除失败一起重试）。 */
  const remove = (
    rows: readonly ProjectManagementRow[],
    options: ProjectRemovalOptions = {},
    purgeAlso: readonly ProjectManagementRow[] = [],
  ) =>
    exclusive(async () => {
      // 固定确认时的身份集合；之后的刷新、搜索或重复点击不能扩充已经确认的批次。
      const candidates = [...new Map(rows.map((row) => [row.key, row])).values()];
      const removed: RemovedProject[] = [];
      const failed: { row: ProjectManagementRow; cause: unknown }[] = [];
      for (const row of candidates) {
        const current = latest.current;
        // 确认后已被别处删除或入口已变化的行直接跳过，不对新状态补发命令。
        const alive = current.tree.projects.some(
          (project) => projectKey(project) === row.key && !project.deleted,
        );
        const entryId = current.availability.get(row.key)?.entryId;
        if (!alive || (row.removal === "entry" && entryId !== row.entryId)) continue;
        try {
          if (row.removal === "delete") {
            if (!current.service) throw new Error("project.service-unavailable");
            await current.service.deleteProject(row.project.id, row.project.hostId);
            removed.push({ row });
          } else if (row.removal === "entry" && row.entryId) {
            if (!current.remoteService) throw new Error("remote-project.entry-not-found");
            const entry = current.directory.entries.find((item) => item.id === row.entryId);
            await current.remoteService.removeEntry(row.entryId);
            removed.push({
              row,
              ...(entry ? { entry } : {}),
              ...(row.host ? { membershipId: row.host.membershipId } : {}),
            });
          }
        } catch (cause) {
          failed.push({ row, cause });
          logger.error("[project-management] 移除项目失败", {
            projectId: row.project.id,
            hostId: row.project.hostId,
            removal: row.removal,
            cause,
          });
        }
      }
      if (options.deleteData) {
        const local = [
          ...removed.map(({ row }) => row).filter(isProjectDataCandidate),
          ...purgeAlso,
        ];
        // 项目先离开列表，数据删除在后台继续；刷新失败不阻断删除，本批结束时还会再刷新一次。
        if (local.length) await latest.current.refresh().catch(() => {});
        const purged = local.length
          ? await purgeRows(local, options.deleteData.totalBytes)
          : { freed: 0, failed: [] };
        const purgeFailed = purged.failed.map(({ row }) => row);
        // 修复原因：两个横幅曾先后写入同一个 failure，移除失败覆盖了数据删除失败，后者再无重试入口。
        // 移除失败的横幅优先，它的重试在同一批里连同这些数据删除失败的项目一起重跑。
        if (failed.length)
          fail(
            "remove",
            failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
            () =>
              remove(
                failed.map(({ row }) => row),
                { deleteData: {} },
                purgeFailed,
              ),
          );
        else
          fail(
            "purge",
            purged.failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
            () => purge(purgeFailed),
          );
        if (!removed.length) return;
        // 不带撤销：本机项目已无法恢复，只撤销远程入口会误导。
        return () =>
          resultToast(
            formatCountMessage(intl, "projectManagement.data.removedToast", removed.length, {
              size: formatBytes(purged.freed),
            }),
          );
      }
      fail(
        "remove",
        failed.map(({ row, cause }) => ({ name: row.project.name, cause })),
        () => remove(failed.map(({ row }) => row)),
      );
      if (!removed.length) return;
      return () =>
        toast(formatCountMessage(intl, "projectManagement.removedToast", removed.length), {
          position: "bottom-center",
          dedupeKey: "project-management-result",
          // 默认样式不渲染操作按钮；带撤销的结果使用 notice（info）样式。
          variant: "info",
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "projectManagement.dismiss" }),
          actionLabel: intl.formatMessage({ id: "projectManagement.undo" }),
          onAction: () => void undo(removed),
        });
    });

  const undo = (removed: readonly RemovedProject[]) =>
    exclusive(async () => {
      const failed: { item: RemovedProject; cause: unknown }[] = [];
      let restored = 0;
      for (const item of removed) {
        const { row, entry } = item;
        try {
          if (row.removal === "delete") {
            await latest.current.service!.restoreProject(row.project.id, row.project.hostId);
          } else {
            // 无 projectId 的旧入口没有远端身份，重新登记会变成另一个项目，只能报失败。
            if (!entry?.projectId || !latest.current.remoteService)
              throw new Error("project.undo-unavailable");
            await latest.current.remoteService.addEntry({
              hostId: entry.hostId,
              ...(item.membershipId ? { expectedMembershipId: item.membershipId } : {}),
              project: { projectId: entry.projectId, name: entry.name, roots: entry.roots },
            });
          }
          restored++;
        } catch (cause) {
          failed.push({ item, cause });
          logger.error("[project-management] 撤销移除失败", {
            projectId: row.project.id,
            hostId: row.project.hostId,
            cause,
          });
        }
      }
      if (restored) restoredToast(restored);
      fail(
        "undo",
        failed.map(({ item, cause }) => ({ name: item.row.project.name, cause })),
        () => undo(failed.map(({ item }) => item)),
      );
    });

  const restore = (project: VirtualProject) =>
    exclusive(async () => {
      try {
        await latest.current.service!.restoreProject(project.id, project.hostId);
        restoredToast(1);
      } catch (cause) {
        logger.error("[project-management] 恢复项目失败", { projectId: project.id, cause });
        fail("restore", [{ name: project.name, cause }], () => restore(project));
      }
    });

  const restoredToast = (count: number) =>
    toast(formatCountMessage(intl, "projectManagement.restoredToast", count), {
      position: "bottom-center",
      dedupeKey: "project-management-result",
    });

  return {
    ...directory,
    busy,
    failure,
    remove,
    restore,
    measureData,
    dismissFailure: () => setFailure(null),
  };
}
