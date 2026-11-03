import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Host 私有装配端口：只读取本机已提交目录，禁止递归读取设置或网络。 */
export type WorkspaceSettingsProjection = Pick<
  AppSettings,
  "lastActiveWorkspace" | "lastWorkspaceSession" | "recentProjects" | "lastActiveTabIndex"
>;

export interface ISettingService {
  get(): Promise<AppSettings>;
  /** 完整连接映射写入必须传入原快照和操作版本；服务在锁内比较并递增版本。 */
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      | "providerFamilyDomain"
      | "providerFamilyConnectionSelections"
      | "providerFamilyDomainUpdatedAt"
    >,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  /**
   * 读取用户自定义指令（个性化）文件 `~/.zcode/AGENTS.md`。
   * 文件缺失时返回空 content；filePath 用于排查与 Agent 实际读取路径是否一致。
   */
  getUserInstructions(): Promise<{ content: string; filePath: string }>;
  /** 原子写入用户自定义指令（个性化）文件，按需创建 `~/.zcode` 目录。 */
  saveUserInstructions(content: string): Promise<{ filePath: string }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
