import type {
  IProjectService,
  IRemoteProjectService,
  ProjectTree,
} from "@/project-sidebar/contract.js";
import { mergeProjectTrees, resolveEntryProject } from "@/project-sidebar/view.js";

/** Host 入口列表是可见集合的权威；网络结果不能恢复已移除的成员实例。 */
export async function readProjectSidebarTree(input: {
  projectService: IProjectService;
  remoteProjectService?: IRemoteProjectService;
}) {
  const before = (await input.remoteProjectService?.readDirectory()) ?? { hosts: [], entries: [] };
  const [local, results] = await Promise.all([
    input.projectService.readTree({ includeDeleted: true, includeDeletedTasks: true }),
    Promise.allSettled(
      before.hosts.map((host) =>
        input.projectService.readTree({
          hostId: host.id,
          includeDeleted: true,
          includeDeletedTasks: true,
        }),
      ),
    ),
  ]);
  const remote = new Map<string, ProjectTree>();
  const errors = new Map<string, string>();
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const host = before.hosts[index]!;
    if (result.status === "fulfilled") remote.set(host.id, result.value);
    // Bug 原因：读取开始时 Host 未在线，readTree 必然被 route 拒绝（host-offline）；
    // 若读取期间连接完成，这条拒绝会与读取后目录的 online 配对，被展示成“连接失败”。
    // 只记录读取开始时已在线的失败；结束时是否在线由诊断再判断。
    else if (host.connectionStatus === "online") errors.set(host.id, String(result.reason));
  }
  for (const entry of before.entries) {
    const tree = remote.get(entry.hostId);
    const project = tree && resolveEntryProject(entry, tree);
    if (project && input.remoteProjectService)
      await input.remoteProjectService.refreshEntry({
        entryId: entry.id,
        expectedLastSyncedAt: entry.lastSyncedAt,
        project: {
          projectId: project.id,
          name: project.name,
          roots: project.roots,
          deleted: project.deleted,
        },
      });
  }
  const directory = (await input.remoteProjectService?.readDirectory()) ?? before;
  for (const [hostId] of remote) {
    const original = before.hosts.find((host) => host.id === hostId);
    if (
      !directory.hosts.some(
        (host) => host.id === hostId && host.membershipId === original?.membershipId,
      )
    )
      remote.delete(hostId);
  }
  return { ...mergeProjectTrees(local, directory, remote), directory, errors };
}
