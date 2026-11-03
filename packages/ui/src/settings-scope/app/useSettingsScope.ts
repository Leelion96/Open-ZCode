import { useCallback, useEffect, useMemo, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useRemoteDevicePresentationInputs } from "@/hooks/useSourceServerStatuses.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import {
  formatRemoteDeviceName,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import type {
  SettingsScopeDevice,
  SettingsScopeDeviceState,
  SettingsScopeState,
  SettingsUserScope,
} from "@/settings-scope/contract.js";
import {
  LOCAL_USER_SCOPE_KEY,
  buildSettingsScopeGroups,
  isUserScopeKey,
  remoteUserScopeKey,
  resolveDefaultSettingsScopeKey,
  resolveSettingsScope,
} from "@/settings-scope/domain/scope.js";
import {
  ensureSourceSettingsServices,
  useSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import {
  useConfigWorkspaceTargets,
  type ConfigWorkspaceTarget,
} from "@/workspace-config-catalog/index.js";

function useServicesHomeDir(services: IServiceAccessor | undefined): string | undefined {
  const [snapshot, setSnapshot] = useState<{
    services: IServiceAccessor;
    homedir: string;
  } | null>(null);
  useEffect(() => {
    const info = services?.systemService?.info;
    if (!services || !info) return;
    let current = true;
    // 迟到结果只属于发起请求的那组服务：切换设备或 attachment 换代后旧结果被丢弃。
    void info.call(services.systemService).then(
      (result) => {
        if (current) setSnapshot({ services, homedir: result.homedir });
      },
      (error: unknown) => {
        if (current) logger.warn("[settings-scope] 读取设备 home 目录失败", error);
      },
    );
    return () => {
      current = false;
    };
  }, [services]);
  return snapshot && snapshot.services === services ? snapshot.homedir : undefined;
}

/**
 * 远端「用户」只经该设备的 source-settings attachment 读写，不要求打开项目。
 * 设备离线时 Host 会 detach attachment，但 renderer 只能经 port close 感知；
 * 因此在线判断以管理快照为准，离线时即使旧服务仍在注册表中也不再使用（fail-closed）。
 */
function useRemoteUserServices(sourceServerId: string | null, online: boolean) {
  const request = useOptionalPlatform()?.requestSourceSettingsAttachment;
  const registered = useSourceSettingsServices(sourceServerId ?? undefined);
  const services = sourceServerId && online ? registered : undefined;
  const [failedSourceServerId, setFailedSourceServerId] = useState<string | null>(null);
  useEffect(() => {
    if (!sourceServerId || !online || registered || !request) return;
    let current = true;
    setFailedSourceServerId(null);
    ensureSourceSettingsServices(sourceServerId, request).catch((error: unknown) => {
      logger.warn("[settings-scope] 申请设备配置连接失败", {
        sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (current) setFailedSourceServerId(sourceServerId);
    });
    return () => {
      current = false;
    };
  }, [online, registered, request, sourceServerId]);
  const homedir = useServicesHomeDir(services);
  return {
    services,
    homedir,
    failed: Boolean(sourceServerId && failedSourceServerId === sourceServerId && !registered),
  };
}

function normalizeInitialScopeKey(key: string | undefined): string | null {
  const trimmed = key?.trim();
  // 插件商店返回的 "user" 表示「当前设备的用户视图」，按默认规则解析到当前 workspace 所在设备。
  return trimmed && trimmed !== LOCAL_USER_SCOPE_KEY ? trimmed : null;
}

/**
 * 设置页 Scope 的唯一状态 owner（插件 / MCP / 技能 / 命令 / 子智能体 / 钩子共用）。
 *
 * ```text
 * 配置目录目录表（项目）──┐
 * 管理快照（设备名/在线）──┼─▶ groups ─▶ 菜单
 * 平台能力（attachment）──┘
 * selectedScopeKey ─▶ resolveSettingsScope ─▶ ready / offline(fail-closed) / missing(回退同设备「用户」)
 *                                         └▶ user：本机 base services | 远端 source-settings + home
 * ```
 */
export function useSettingsScope(params: {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  initialScopeKey?: string;
  /** 选中的项目已关闭、回退到同设备「用户」时通知（插件页沿用原有提示）。 */
  onFallback?(): void;
}): SettingsScopeState {
  const { workspacePath, workspaceIdentity, initialScopeKey, onFallback } = params;
  const base = useBaseWorkspaceServices();
  const remoteUserAvailable = Boolean(useOptionalPlatform()?.requestSourceSettingsAttachment);
  const { targets, loaded: catalogLoaded } = useConfigWorkspaceTargets();
  const inputs = useRemoteDevicePresentationInputs();
  const devices = useMemo<SettingsScopeDeviceState[]>(
    () =>
      [...inputs.entries()].map(([sourceServerId, input]) => ({
        sourceServerId,
        name: formatRemoteDeviceName(input.target, input.displayName) ?? sourceServerId,
        // 与数据同步页设备行的「已连接」判断一致：只取自管理快照。
        online: resolveRemoteConnectionPresentation(input).status === "online",
      })),
    [inputs],
  );
  const context = useMemo(
    () => ({ targets, devices, remoteUserAvailable }),
    [devices, remoteUserAvailable, targets],
  );
  const groups = useMemo(() => buildSettingsScopeGroups(context), [context]);
  const activeTarget = workspaceIdentity?.trim()
    ? targets.find((target) => target.workspaceIdentity === workspaceIdentity)
    : undefined;
  const defaultKey = resolveDefaultSettingsScopeKey({
    workspacePath,
    workspaceIdentity,
    remoteTarget: activeTarget?.remoteTarget,
    remoteUserAvailable,
  });
  const [pickedKey, setPickedKey] = useState(() => normalizeInitialScopeKey(initialScopeKey));
  useEffect(() => setPickedKey(normalizeInitialScopeKey(initialScopeKey)), [initialScopeKey]);
  const selectedScopeKey = pickedKey ?? defaultKey;
  const rawResolution = resolveSettingsScope(selectedScopeKey, context);
  // 默认 key 指向的项目可能还没出现在目录表里（异步读取）：只在本帧按回退目标解析，不改写选择。
  const resolution =
    rawResolution.status === "missing" && pickedKey === null
      ? resolveSettingsScope(rawResolution.fallbackKey, context)
      : rawResolution;
  const fallbackKey =
    // 初次挂载的空目录不是项目已删除，不能抢在异步读取前丢掉审核入口的工作区。
    catalogLoaded && rawResolution.status === "missing" && pickedKey !== null
      ? rawResolution.fallbackKey
      : null;
  useEffect(() => {
    if (fallbackKey === null) return;
    // 用户选中的项目已关闭或断开：显式回退到同一设备的「用户」并提示，不静默改写到其他设备。
    setPickedKey(fallbackKey);
    onFallback?.();
  }, [fallbackKey, onFallback]);

  const device: SettingsScopeDevice =
    resolution.status === "missing" ? { kind: "local" } : resolution.device;
  const deviceId = device.kind === "local" ? "local" : device.id;
  const deviceTargets = useMemo(
    () =>
      groups
        .find((group) => (group.device.kind === "local" ? "local" : group.device.id) === deviceId)
        ?.options.flatMap((option) => (option.target ? [option.target] : [])) ?? [],
    [deviceId, groups],
  );

  const remoteSourceServerId =
    device.kind === "remote" && remoteUserAvailable ? device.sourceServerId : null;
  const remoteOnline = remoteSourceServerId
    ? devices.some((item) => item.sourceServerId === remoteSourceServerId && item.online)
    : false;
  const remote = useRemoteUserServices(remoteSourceServerId, remoteOnline);
  const localHomeDir = useServicesHomeDir(base);
  const localAnchor = useMemo<ConfigWorkspaceTarget | null>(() => {
    if (device.kind !== "local") return null;
    // 本机「用户」借用一个本机项目作为插件 / 技能接口需要的 cwd（与旧行为一致）；没有本机项目时用本机 home。
    const activeLocal =
      workspacePath && !workspaceIdentity?.trim()
        ? (deviceTargets.find((target) => target.workspacePath === workspacePath) ?? {
            workspacePath,
            label: getPathLeaf(workspacePath) || workspacePath,
          })
        : undefined;
    const anchor = activeLocal ?? deviceTargets[0];
    if (anchor) return anchor;
    return localHomeDir ? { workspacePath: localHomeDir, label: localHomeDir } : null;
  }, [device.kind, deviceTargets, localHomeDir, workspaceIdentity, workspacePath]);

  const user: SettingsUserScope =
    device.kind === "local"
      ? localAnchor
        ? { status: "ready", target: localAnchor, unscopedServices: base }
        : { status: "connecting" }
      : !remoteSourceServerId
        ? { status: "unavailable" }
        : !remoteOnline || remote.failed
          ? { status: "offline" }
          : remote.services && remote.homedir
            ? {
                status: "ready",
                target: { workspacePath: remote.homedir, label: remote.homedir },
                unscopedServices: remote.services,
                cacheAuthorityKey: `source-settings:${remoteSourceServerId}`,
              }
            : { status: "connecting" };

  const syncSourceServerId =
    resolution.status === "ready" && resolution.kind === "user" && device.kind === "remote"
      ? device.sourceServerId
      : null;
  const activeDeviceId = workspaceIdentity?.trim()
    ? workspacePath
      ? (getWorkspaceSourceServerId({
          workspacePath,
          workspaceIdentity: workspaceIdentity.trim(),
          remoteTarget: activeTarget?.remoteTarget,
        }) ??
        activeTarget?.hostId ??
        null)
      : null
    : "local";
  const deviceUserKey =
    device.kind === "local"
      ? LOCAL_USER_SCOPE_KEY
      : device.sourceServerId
        ? remoteUserScopeKey(device.sourceServerId)
        : LOCAL_USER_SCOPE_KEY;
  const setSelectedScopeKey = useCallback((key: string) => setPickedKey(key), []);
  const toLocalScopeKey = useCallback(
    (pageKey: string) => (isUserScopeKey(pageKey) ? LOCAL_USER_SCOPE_KEY : pageKey),
    [],
  );
  const toPageScopeKey = useCallback(
    (localKey: string) => (localKey === LOCAL_USER_SCOPE_KEY ? deviceUserKey : localKey),
    [deviceUserKey],
  );
  return {
    groups,
    selectedScopeKey: resolution.status === "missing" ? selectedScopeKey : resolution.key,
    setSelectedScopeKey,
    resolution,
    device,
    deviceTargets,
    user,
    syncSourceServerId,
    isActiveWorkspaceDevice: activeDeviceId === deviceId,
    toLocalScopeKey,
    toPageScopeKey,
  };
}
