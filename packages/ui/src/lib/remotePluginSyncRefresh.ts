import type { ICommandsService, ISkillsService, IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { mergeSlashCommandsAfterCommandRefresh } from "@/settings/pluginSlashCommandRefresh.js";
import { useCommandsStore } from "@/store/commandsStore.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { notifyPluginManagementChange } from "@/store/pluginManagementStoreLoading.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 重新拉取远端 workspace 的命令并写回 commandsStore 与输入框 `/` 面板（插件、命令推送后共用）。 */
export async function refreshSlashCommandsAfterRemoteSync(params: {
  commandsService: ICommandsService;
  reason: string;
  workspacePath: string;
  workspaceIdentity: string | null;
}): Promise<void> {
  const { commandsService, reason, workspacePath, workspaceIdentity } = params;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;

  try {
    const result = await commandsService.list({
      workspacePath,
      ...(workspaceIdentityParam ? { workspaceIdentity: workspaceIdentityParam } : {}),
    });

    const commandsStore = useCommandsStore.getState();
    // 这里刷新的是项目（没有 authority）；store 指向同路径的远端「用户」时属于另一个目标，不写回。
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity &&
      commandsStore.authorityKey === null
    ) {
      useCommandsStore.setState({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loadedAuthorityKey: null,
        loading: false,
        error: null,
      });
    }

    const zcodeSessionStore = useZCodeSessionStore.getState();
    const currentSlashCommands = zcodeSessionStore.getWorkspaceState(
      workspacePath,
      workspaceIdentityParam,
    ).slashCommands;
    // 远程插件同步入口不一定打开过命令设置页，commandsStore 可能尚未初始化。
    // 输入框 `/` 面板读取的是 zcodeSessionStore.slashCommands，所以同步后必须直接
    // 向当前远端 workspace 拉取 commands 并写回 slashCommands，不能只刷新设置页 store。
    zcodeSessionStore.setSlashCommands(
      workspacePath,
      mergeSlashCommandsAfterCommandRefresh(currentSlashCommands, result.commands),
      workspaceIdentityParam,
    );
  } catch (error) {
    const commandsStore = useCommandsStore.getState();
    if (
      commandsStore.workspacePath === workspacePath &&
      commandsStore.workspaceIdentity === workspaceIdentity &&
      commandsStore.authorityKey === null
    ) {
      useCommandsStore.setState({
        loading: false,
        error: toMessage(error),
      });
    }
    logger.warn("[plugins] refresh slash commands after remote plugin sync failed", {
      reason,
      workspaceIdentity,
      workspacePath,
      error: toMessage(error),
    });
  }
}

/**
 * MCP store 是全局单例，只跟踪一个当前项目：只在它正指向该 workspace 时重新加载。
 * Bug 原因：数据同步推送插件后对该设备每个已打开的项目调用 ensureLoadedForWorkspace，
 * 它会把 store 切到最后一个被刷新的项目，改掉用户当前正在看的项目的 MCP 列表。
 * 修法：不切换当前项目；不是当前项目的 workspace 由切换项目时的正常加载拿到新配置。
 *
 * Bug 原因：store 的目录服务与目标一起绑定后，这里传入推送用的 source-settings 服务会把当前
 * 项目换绑到它，之后该项目的读写不再走项目自己的服务。修法：只重读已绑定的目标，不传服务。
 */
export async function reloadMcpStoreIfCurrentWorkspace(params: {
  workspacePath: string;
  workspaceIdentity?: string | null;
}): Promise<void> {
  const { currentProjectPath, currentWorkspaceIdentity } = useMcpStore.getState();
  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  if (
    params.workspacePath !== currentProjectPath ||
    workspaceIdentity !== currentWorkspaceIdentity
  ) {
    return;
  }
  await useMcpStore.getState().loadMcpFromUserDirectory();
}

export async function refreshWorkspacePluginCapabilitiesAfterRemoteSync(params: {
  commandsService: ICommandsService;
  reason: string;
  skillsService: ISkillsService;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
  zcodeAgentService: IZCodeAgentService;
}): Promise<void> {
  const workspacePath = params.workspacePath;
  if (!workspacePath) {
    return;
  }
  const workspaceIdentity = params.workspaceIdentity?.trim() || null;
  const workspaceIdentityParam = workspaceIdentity ?? undefined;
  await invalidateDeferredDraftSessionForSkillChange({
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    reason: params.reason,
  });
  await refreshSharedSkillStoreForWorkspace({
    workspacePath,
    workspaceIdentity: workspaceIdentityParam,
    skillsService: params.skillsService,
  });
  await refreshSlashCommandsAfterRemoteSync({
    commandsService: params.commandsService,
    reason: params.reason,
    workspacePath,
    workspaceIdentity,
  });
  await reloadMcpStoreIfCurrentWorkspace({
    workspacePath,
    workspaceIdentity,
  });
  // 同步入口可能没有打开全局设置；按真实目标通知所有已挂载投影。
  notifyPluginManagementChange({
    workspacePath,
    workspaceIdentity,
    authorityKey: null,
    scope: "user",
  });
}
