/**
 * settings-scope 合同：设置页 Scope 菜单按设备分组（docs/remote/data-sync.md「Scope 菜单按设备分组」）。
 * Scope key：`"user"` = 本机「用户」；`source-user:<sourceServerId>` = 远端设备「用户」；其余为项目 key。
 */
import type { IServiceAccessor } from "@zcode/services";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

export type { ConfigWorkspaceTarget, IServiceAccessor };

/** 管理快照投影出的设备：名称与在线状态都只取自本机 Source 设备记录。 */
export interface SettingsScopeDeviceState {
  sourceServerId: string;
  name: string;
  online: boolean;
}

export type SettingsScopeDevice =
  | { kind: "local" }
  | {
      kind: "remote";
      /** 分组 id：Source 设备为 sourceServerId，其余远端（旧格式 / Direct URL）为 hostId。 */
      id: string;
      sourceServerId: string | null;
      name: string | null;
    };

export interface SettingsScopeOption {
  key: string;
  kind: "user" | "workspace";
  target?: ConfigWorkspaceTarget;
}

export interface SettingsScopeGroup {
  device: SettingsScopeDevice;
  options: SettingsScopeOption[];
}

export interface SettingsScopeContext {
  targets: readonly ConfigWorkspaceTarget[];
  devices: readonly SettingsScopeDeviceState[];
  /** 只有能申请 source-settings attachment 的平台（桌面端）提供远端「用户」。 */
  remoteUserAvailable: boolean;
}

export type SettingsScopeResolution =
  | {
      status: "ready";
      key: string;
      kind: "user";
      device: SettingsScopeDevice;
    }
  | {
      status: "ready";
      key: string;
      kind: "workspace";
      device: SettingsScopeDevice;
      target: ConfigWorkspaceTarget;
    }
  /** 选中的设备离线：该页读写一律失败并提示，不回退到本机，也不显示旧快照。 */
  | { status: "offline"; key: string; device: Extract<SettingsScopeDevice, { kind: "remote" }> }
  /** 选中的项目已关闭（设备仍在线或为本机）：回退到同一设备的「用户」。 */
  | { status: "missing"; key: string; fallbackKey: string };

/** 选中设备的「用户」目标：ready 时分区用这组服务和锚点路径读写该设备的用户级配置。 */
export type SettingsUserScope =
  | {
      status: "ready";
      target: ConfigWorkspaceTarget;
      /** 显式服务：本机为 base services，远端为该设备的 source-settings attachment。 */
      unscopedServices: IServiceAccessor;
      /** 远端「用户」的 renderer 缓存权威；本机沿用原有项目缓存 key（undefined）。 */
      cacheAuthorityKey?: string;
    }
  /** attachment 或 home 目录尚未就绪。 */
  | { status: "connecting" }
  /** 设备离线或无法连接：fail-closed，不提供任何服务。 */
  | { status: "offline" }
  /** 该设备没有「用户」（旧格式远端、Direct URL，或平台不能申请 source-settings attachment）。 */
  | { status: "unavailable" };

export interface SettingsScopeState {
  groups: SettingsScopeGroup[];
  selectedScopeKey: string;
  setSelectedScopeKey(key: string): void;
  resolution: SettingsScopeResolution;
  /** 选中项所在设备；表单菜单只列出这台设备。 */
  device: SettingsScopeDevice;
  /** 选中设备上可选的项目（表单菜单与分区内的项目解析用）。 */
  deviceTargets: ConfigWorkspaceTarget[];
  /** 选中设备的「用户」目标（选中项目时也提供，表单可切回同设备的「用户」）。 */
  user: SettingsUserScope;
  /** 选中某台在线远端设备的「用户」时为其 sourceServerId：技能、MCP、插件页的同步按钮只在此时显示。 */
  syncSourceServerId: string | null;
  /** 选中设备是否就是当前 workspace 所在设备（插件商店等只作用于当前 workspace 的入口据此显示）。 */
  isActiveWorkspaceDevice: boolean;
  /** 页面 key ↔ 设备内 key：设备内「用户」统一写作 `"user"`，分区与表单沿用原有判断。 */
  toLocalScopeKey(pageKey: string): string;
  toPageScopeKey(localKey: string): string;
}
