import type {
  IProjectService,
  IRemoteProjectService,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";

/**
 * 同一设备在途的未指定目录连接。Host 把这类 connect 按设备复用为同一 logical session，
 * Renderer 也必须按 hostId 合并，才能让所有等待者共享同一个结果与释放责任。
 */
interface HostConnectionFlight {
  readonly sessionId: Promise<string>;
  waiters: number;
  claimed: boolean;
}

const hostConnectionFlights = new Map<string, HostConnectionFlight>();

function joinHostConnectionFlight(
  hostId: string,
  connect: () => Promise<string>,
): HostConnectionFlight {
  const current = hostConnectionFlights.get(hostId);
  if (current) {
    current.waiters += 1;
    return current;
  }
  const flight: HostConnectionFlight = { sessionId: connect(), waiters: 1, claimed: false };
  hostConnectionFlights.set(hostId, flight);
  return flight;
}

/** 不接管就退出；返回 true 表示自己是最后一个等待者且无人接管，需要释放这次连接。 */
function leaveHostConnectionFlight(hostId: string, flight: HostConnectionFlight): boolean {
  flight.waiters -= 1;
  if (flight.waiters > 0 || flight.claimed) return false;
  if (hostConnectionFlights.get(hostId) === flight) hostConnectionFlights.delete(hostId);
  return true;
}

/** 开始绑定目录即接管连接；之后恢复的等待者不能把同一 session 改绑到其他目录。 */
function claimHostConnectionFlight(hostId: string, flight: HostConnectionFlight): void {
  if (flight.claimed) throw new Error("project.navigation-cancelled");
  flight.claimed = true;
  flight.waiters -= 1;
  if (hostConnectionFlights.get(hostId) === flight) hostConnectionFlights.delete(hostId);
}

/** 连接实例归 Host；这里只申请/绑定 logical attachment，不按 path 复用另一台设备的 scope。 */
export async function attachRemoteProjectWorkspace(input: {
  hostId: string;
  workspacePath: string;
  workspaceIdentity: string;
  expectedMembershipId?: string;
  projectId?: string | null;
  projectService?: Pick<IProjectService, "readProjects">;
  remoteService: IRemoteProjectService;
  isCurrent?(): boolean;
  findSession(identity: string): { sessionId: string } | undefined;
  connect: ProjectSidebarProps["onConnectRemote"];
  bind(
    sessionId: string,
    path: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ): Promise<void>;
  cancel: ProjectSidebarProps["onCancelRemoteProject"];
}): Promise<string> {
  const assertCurrent = () => {
    if (input.isCurrent?.() === false) throw new Error("project.navigation-cancelled");
  };
  assertCurrent();
  const host = await input.remoteService.connectHost(input.hostId);
  assertCurrent();
  const target = host.target;
  if (host.id !== input.hostId || !target) throw new Error("project.host-identity-changed");
  if (input.expectedMembershipId && host.membershipId !== input.expectedMembershipId)
    throw new Error("remote-project.host-removed");
  const validateMembership = async () => {
    if (input.expectedMembershipId) {
      const directory = await input.remoteService.readDirectory();
      if (
        !directory.hosts.some(
          (item) => item.id === input.hostId && item.membershipId === input.expectedMembershipId,
        )
      )
        throw new Error("remote-project.host-removed");
    }
    if (input.projectService && input.projectId) {
      const projects = await input.projectService.readProjects({ hostId: input.hostId });
      if (
        !projects.some(
          (project) =>
            project.id === input.projectId &&
            project.hostId === input.hostId &&
            !project.deleted &&
            project.roots.length === 1 &&
            project.roots[0]?.rootPath === input.workspacePath,
        )
      )
        throw new Error("project.not-found");
    }
    assertCurrent();
    return true;
  };
  // 连接和绑定都会等待远端；claim 在目录绑定前执行，标记本导航接管连接。
  const bindWorkspace = async (sessionId: string, claim?: () => void) => {
    assertCurrent();
    // Host 在连接等待中被移除再添加时，原请求不能借新成员的身份提交导航。
    const guard =
      input.expectedMembershipId || input.projectService ? validateMembership : input.isCurrent;
    if (guard === validateMembership) await validateMembership();
    claim?.();
    if (guard) await input.bind(sessionId, input.workspacePath, guard);
    else await input.bind(sessionId, input.workspacePath);
    const bound = input.findSession(input.workspaceIdentity);
    if (bound?.sessionId !== sessionId) throw new Error("project.workspace-identity-mismatch");
    return sessionId;
  };

  // 目录已有 session 时只复用；失败也不能取消其他项目复用的连接。
  const existing = input.findSession(input.workspaceIdentity);
  if (existing) return await bindWorkspace(existing.sessionId);

  // Bug 原因：首连 Provisioning 可达十几秒，期间再次点击会再发一次 connect，Host 把它 join 到同一
  // session。旧逻辑把每次 connect 结果都当作“本次创建”，被替代的旧点击在连接迟到成功后立即释放，
  // 最新点击随之失败。现在按设备合并在途连接：被替代的等待者只退出，由接管者或最后一个等待者释放。
  const flight = joinHostConnectionFlight(input.hostId, () => input.connect(target));
  let sessionId: string;
  try {
    sessionId = await flight.sessionId;
  } catch (error) {
    leaveHostConnectionFlight(input.hostId, flight);
    throw error;
  }
  let claimed = false;
  try {
    return await bindWorkspace(sessionId, () => {
      claimHostConnectionFlight(input.hostId, flight);
      claimed = true;
    });
  } catch (error) {
    if (claimed || leaveHostConnectionFlight(input.hostId, flight)) await input.cancel(sessionId);
    throw error;
  }
}
