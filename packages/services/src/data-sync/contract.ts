import type {
  DataSyncContentHashesResult,
  DataSyncImportItem,
  DataSyncImportResult,
  DataSyncListResult,
  DataSyncWorkspaceMapping,
  DeviceSyncResult,
  DeviceSyncState,
  RemoteSyncWriteAccessResult,
  UserConfigSyncCategory,
  UserConfigSyncPayloadMap,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";

/**
 * 数据同步分类服务的统一形状（docs/remote/data-sync.md「统一的同步服务形状」）。
 * 两端注册同一实现：本机作为 source，远端作为 target；方向由调用方决定，服务不写死。
 */
export interface IDataSyncCategoryService<TPayload> {
  listSyncItems(): Promise<DataSyncListResult>;
  /**
   * `targetHomeDir`：作为来源端计算时由调用方传入目标端 home。需要路径改写的分类（MCP）
   * 先把来源配置改写成目标端路径再计算，使两端可以直接比较；其他分类忽略。
   * `workspace`：带项目上下文的入口传入，MCP 先做 workspace 改写；其他分类忽略。
   */
  getSyncContentHashes(params: {
    keys: string[];
    targetHomeDir?: string;
    workspace?: DataSyncWorkspaceMapping;
  }): Promise<DataSyncContentHashesResult>;
  checkSyncWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  /** `workspace`：同 getSyncContentHashes；MCP 把它带进 payload，由目标端改写。 */
  exportSyncItems(params: {
    keys: string[];
    workspace?: DataSyncWorkspaceMapping;
  }): Promise<TPayload>;
  importSyncItems(params: {
    payload: TPayload;
    items: DataSyncImportItem[];
  }): Promise<DataSyncImportResult>;
}

/**
 * 用户配置同步通道（`user-config-sync`）：子智能体、命令、钩子共用一个通道，方法与
 * IDataSyncCategoryService 相同，只多一个 category 参数。两端注册同一实现；未知 category 直接报错。
 */
export interface IUserConfigSyncService {
  listSyncItems(params: { category: UserConfigSyncCategory }): Promise<DataSyncListResult>;
  getSyncContentHashes(params: {
    category: UserConfigSyncCategory;
    keys: string[];
  }): Promise<DataSyncContentHashesResult>;
  checkSyncWriteAccess(params: {
    category: UserConfigSyncCategory;
  }): Promise<RemoteSyncWriteAccessResult>;
  exportSyncItems<C extends UserConfigSyncCategory>(params: {
    category: C;
    keys: string[];
  }): Promise<UserConfigSyncPayloadMap[C]>;
  importSyncItems<C extends UserConfigSyncCategory>(params: {
    category: C;
    payload: UserConfigSyncPayloadMap[C];
    items: DataSyncImportItem[];
  }): Promise<DataSyncImportResult>;
}

export const IUserConfigSyncService = createServiceDescriptor<IUserConfigSyncService>(
  ServiceChannels.UserConfigSync,
);

/** 本机 Host 的设备同步状态；设备列表只从这里读取上次同步结果。 */
export interface IDeviceSyncStateService {
  getDeviceSyncStates(): Promise<Record<string, DeviceSyncState>>;
  recordDeviceSyncResult(params: {
    sourceServerId: string;
    result: DeviceSyncResult;
  }): Promise<DeviceSyncState>;
}

export const IDeviceSyncStateService = createServiceDescriptor<IDeviceSyncStateService>(
  ServiceChannels.DeviceSyncState,
);
