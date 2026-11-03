import type { IProjectService, ProjectTask, ProjectTree } from "#src/project/contract.js";
import type {
  PendingInteractionSummary,
  WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 手机项目树的实时待处理交互叠加。
 *
 * 3.16 手机经 RPC `project.readTree` 读任务列表；readTree 只读 SQLite，拿不到 sessions-index
 * 里的实时交互，手机列表因此无法显示「待处理」。这里在手机 attachment 的 project 服务上，
 * 用 WindowHostController 投影行（与桌面侧栏 activity 同源）给每个任务补上：
 * - `pendingInteractions`: { permissionCount, userInputCount }（RN 契约格式）
 * - `pendingInteraction`: `{ kind }` 轻量标记（KMP 现有 ProjectTreeTask 只判断该字段是否存在）；
 *   投影行只有计数、没有交互 id，因此不下发 interactionId，也不携带问题/命令等敏感内容
 * 交互增减时广播一次 `state:projects`，复用手机已有的「收到即重读」链路。
 */
export type WebRemoteProjectTask = Omit<ProjectTask, "pendingInteraction"> & {
  pendingInteractions?: PendingInteractionSummary;
  pendingInteraction?: ProjectTask["pendingInteraction"] | { kind: "permission" | "userInput" };
};

type TaskRows = () => readonly WindowHostControllerTaskRow[];

function taskKey(task: { workspacePath: string; workspaceIdentity?: string; taskId: string }) {
  return `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`;
}

/** 一行的待处理交互计数；没有或全为 0 时返回 undefined（手机不显示「待处理」）。 */
export function summarizeTaskRowPendingInteractions(
  row: Pick<WindowHostControllerTaskRow, "activity">,
): PendingInteractionSummary | undefined {
  const summary = row.activity?.pendingInteractions;
  if (!summary || summary.permissionCount + summary.userInputCount <= 0) return undefined;
  return { permissionCount: summary.permissionCount, userInputCount: summary.userInputCount };
}

export function overlayProjectTreeTaskActivity(
  tree: ProjectTree,
  rows: readonly WindowHostControllerTaskRow[],
): ProjectTree {
  if (rows.length === 0 || tree.tasks.length === 0) return tree;
  const byKey = new Map(rows.map((row) => [taskKey(row.address), row]));
  return {
    ...tree,
    // 仅线上扩展字段（RPC 原样序列化），桌面侧不消费，故在此收窄回 ProjectTree。
    tasks: tree.tasks.map((task): WebRemoteProjectTask => {
      const row = byKey.get(taskKey(task));
      const summary = row && summarizeTaskRowPendingInteractions(row);
      if (!row || !summary) return task;
      return {
        ...task,
        // 权限优先：与桌面侧栏「等待授权」优先展示一致。
        pendingInteraction: task.pendingInteraction ?? {
          kind: summary.permissionCount > 0 ? "permission" : "userInput",
        },
        pendingInteractions: summary,
      };
    }) as ProjectTree["tasks"],
  };
}

/** 只含有待处理交互的任务及计数；同签名不重复广播。 */
export function buildPendingInteractionSignature(
  rows: readonly WindowHostControllerTaskRow[],
): string {
  return rows
    .flatMap((row) => {
      const summary = summarizeTaskRowPendingInteractions(row);
      return summary
        ? [`${taskKey(row.address)}\0${summary.permissionCount}\0${summary.userInputCount}`]
        : [];
    })
    .sort()
    .join("\n");
}

export function decorateProjectServiceWithTaskActivity(
  base: IProjectService,
  readRows: TaskRows,
): IProjectService {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "readTree") {
        return async (params?: Parameters<IProjectService["readTree"]>[0]) =>
          overlayProjectTreeTaskActivity(await target.readTree(params), readRows());
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 按手机 attachment 引用计数启停交互变化监听：没有手机连接时不订阅投影、不额外广播，
 * 桌面侧栏行为与改动前完全一致。
 */
export function createWebRemoteProjectTreeActivityBridge(options: {
  readRows: TaskRows;
  subscribeRows: (onChange: () => void) => { dispose(): void };
  notifyProjectChange: () => void;
}) {
  let retained = 0;
  let subscription: { dispose(): void } | null = null;
  return {
    decorate: (base: IProjectService) =>
      decorateProjectServiceWithTaskActivity(base, options.readRows),
    retain(): { dispose(): void } {
      retained += 1;
      if (!subscription) {
        let last = buildPendingInteractionSignature(options.readRows());
        subscription = options.subscribeRows(() => {
          const next = buildPendingInteractionSignature(options.readRows());
          if (next === last) return;
          last = next;
          options.notifyProjectChange();
        });
      }
      let released = false;
      return {
        dispose() {
          if (released) return;
          released = true;
          retained -= 1;
          if (retained === 0) {
            subscription?.dispose();
            subscription = null;
          }
        },
      };
    },
  };
}
