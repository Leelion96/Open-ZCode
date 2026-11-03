import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { formatRemoteDeviceName } from "@/lib/remoteConnectionPresentation.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import type {
  ConfigWorkspaceTarget,
  SettingsScopeContext,
  SettingsScopeDevice,
  SettingsScopeDeviceState,
  SettingsScopeGroup,
  SettingsScopeOption,
  SettingsScopeResolution,
} from "@/settings-scope/contract.js";

/**
 * 设置页 Scope 的纯模型：按设备分组、默认选中与选中项解析（docs/remote/data-sync.md「Scope 菜单按设备分组」）。
 *
 * Scope key 是页面级的全局 key：
 * - `"user"`：本机「用户」（沿用旧值，E2E 与插件商店返回都依赖它）；
 * - `source-user:<sourceServerId>`：远端设备的「用户」，经该设备的 source-settings attachment 读写；
 * - 其他：项目 key（`getWorkspaceKey(path, identity)`），远端项目的 identity 自带设备。
 */
export const LOCAL_USER_SCOPE_KEY = "user";
const REMOTE_USER_SCOPE_PREFIX = "source-user:";

export function remoteUserScopeKey(sourceServerId: string): string {
  return `${REMOTE_USER_SCOPE_PREFIX}${sourceServerId}`;
}

export function parseRemoteUserScopeKey(key: string): string | null {
  return key.startsWith(REMOTE_USER_SCOPE_PREFIX)
    ? key.slice(REMOTE_USER_SCOPE_PREFIX.length) || null
    : null;
}

export function isUserScopeKey(key: string): boolean {
  return key === LOCAL_USER_SCOPE_KEY || parseRemoteUserScopeKey(key) !== null;
}

export function getPluginWorkspaceKey(tab: ConfigWorkspaceTarget): string {
  return getWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
}

function isRemoteScopeTarget(tab: ConfigWorkspaceTarget): boolean {
  return Boolean(tab.workspaceIdentity?.trim() || tab.remoteTarget || tab.remoteSessionId);
}

export function isPluginScopeWorkspaceConnected(tab: ConfigWorkspaceTarget): boolean {
  // Bug 根因：持久化 tab 会保留已经断开的远端项目和已失效的本地目录；Scope 若继续展示，
  // 用户会选中一个没有可用 service target 的项目。远端必须有当前 session，本地必须仍可用。
  if (tab.configOnline !== undefined) return tab.configOnline;
  if (tab.availability === "unavailable-local-directory") return false;
  if (!isRemoteScopeTarget(tab)) return true;
  return Boolean(tab.remoteSessionId);
}

function remoteDeviceOf(
  target: Pick<ConfigWorkspaceTarget, "workspacePath" | "workspaceIdentity" | "remoteTarget"> & {
    hostId?: string;
  },
  devices: readonly SettingsScopeDeviceState[],
): Extract<SettingsScopeDevice, { kind: "remote" }> {
  const sourceServerId = getWorkspaceSourceServerId(target);
  const record = sourceServerId
    ? devices.find((device) => device.sourceServerId === sourceServerId)
    : undefined;
  const identity = target.workspaceIdentity?.trim() ?? "";
  return {
    kind: "remote",
    id:
      sourceServerId ??
      target.hostId ??
      remoteHostIdFromWorkspaceIdentity(identity) ??
      (identity || target.workspacePath),
    sourceServerId,
    name: record?.name ?? formatRemoteDeviceName(target.remoteTarget) ?? null,
  };
}

/**
 * 菜单分组：本机（「用户」+ 本机项目）在前，其后每台在线设备一组（「用户」+ 该设备的项目）。
 * 数据来自配置目录目录表；Source 设备的在线状态只看管理快照，离线设备整组不列出。
 * 没有设备记录的远端（旧格式 identity、Direct URL）只列出在线项目，不提供「用户」。
 */
export function buildSettingsScopeGroups(context: SettingsScopeContext): SettingsScopeGroup[] {
  const local: SettingsScopeGroup = {
    device: { kind: "local" },
    options: [{ key: LOCAL_USER_SCOPE_KEY, kind: "user" }],
  };
  const remote = new Map<string, SettingsScopeGroup>();
  for (const device of context.devices) {
    if (!device.online) continue;
    remote.set(device.sourceServerId, {
      device: {
        kind: "remote",
        id: device.sourceServerId,
        sourceServerId: device.sourceServerId,
        name: device.name,
      },
      options: context.remoteUserAvailable
        ? [{ key: remoteUserScopeKey(device.sourceServerId), kind: "user" }]
        : [],
    });
  }
  for (const target of context.targets) {
    if (!isPluginScopeWorkspaceConnected(target)) continue;
    const option: SettingsScopeOption = {
      key: getPluginWorkspaceKey(target),
      kind: "workspace",
      target,
    };
    if (!isRemoteScopeTarget(target)) {
      local.options.push(option);
      continue;
    }
    const device = remoteDeviceOf(target, context.devices);
    const known = device.sourceServerId
      ? context.devices.find((item) => item.sourceServerId === device.sourceServerId)
      : undefined;
    if (known && !known.online) continue;
    const group = remote.get(device.id) ?? { device, options: [] };
    group.options.push(option);
    remote.set(device.id, group);
  }
  return [local, ...[...remote.values()].filter((group) => group.options.length > 0)];
}

function remoteUserDevice(
  sourceServerId: string,
  devices: readonly SettingsScopeDeviceState[],
): Extract<SettingsScopeDevice, { kind: "remote" }> {
  return {
    kind: "remote",
    id: sourceServerId,
    sourceServerId,
    name: devices.find((device) => device.sourceServerId === sourceServerId)?.name ?? null,
  };
}

export function resolveSettingsScope(
  key: string,
  context: SettingsScopeContext,
): SettingsScopeResolution {
  if (key === LOCAL_USER_SCOPE_KEY) {
    return { status: "ready", key, kind: "user", device: { kind: "local" } };
  }
  const remoteUserId = parseRemoteUserScopeKey(key);
  if (remoteUserId) {
    if (!context.remoteUserAvailable) {
      return { status: "missing", key, fallbackKey: LOCAL_USER_SCOPE_KEY };
    }
    const device = remoteUserDevice(remoteUserId, context.devices);
    const online = context.devices.some(
      (item) => item.sourceServerId === remoteUserId && item.online,
    );
    return online
      ? { status: "ready", key, kind: "user", device }
      : { status: "offline", key, device };
  }
  const target = context.targets.find((candidate) => getPluginWorkspaceKey(candidate) === key);
  const owner = target ?? { workspacePath: key, workspaceIdentity: key };
  if (!target && !remoteHostIdFromWorkspaceIdentity(key)) {
    return { status: "missing", key, fallbackKey: LOCAL_USER_SCOPE_KEY };
  }
  if (target && !isRemoteScopeTarget(target)) {
    return isPluginScopeWorkspaceConnected(target)
      ? { status: "ready", key, kind: "workspace", device: { kind: "local" }, target }
      : { status: "missing", key, fallbackKey: LOCAL_USER_SCOPE_KEY };
  }
  const device = remoteDeviceOf(owner, context.devices);
  const known = device.sourceServerId
    ? context.devices.find((item) => item.sourceServerId === device.sourceServerId)
    : undefined;
  if (known && !known.online) return { status: "offline", key, device };
  if (target && isPluginScopeWorkspaceConnected(target)) {
    return { status: "ready", key, kind: "workspace", device, target };
  }
  return {
    status: "missing",
    key,
    fallbackKey:
      known && context.remoteUserAvailable
        ? remoteUserScopeKey(known.sourceServerId)
        : LOCAL_USER_SCOPE_KEY,
  };
}

/**
 * 默认选中当前 workspace 所在设备的「用户」：本地 tab 为「本机 · 用户」，远程 tab 为「该设备 · 用户」。
 * 平台不能申请 source-settings attachment（Web / 手机）时没有远端「用户」，改为选中当前远程项目本身。
 */
export function resolveDefaultSettingsScopeKey(params: {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  remoteTarget?: ConfigWorkspaceTarget["remoteTarget"];
  remoteUserAvailable: boolean;
}): string {
  const identity = params.workspaceIdentity?.trim();
  if (!identity || !params.workspacePath) return LOCAL_USER_SCOPE_KEY;
  const sourceServerId = getWorkspaceSourceServerId({
    workspacePath: params.workspacePath,
    workspaceIdentity: identity,
    remoteTarget: params.remoteTarget,
  });
  if (sourceServerId && params.remoteUserAvailable) return remoteUserScopeKey(sourceServerId);
  return getWorkspaceKey(params.workspacePath, identity);
}
