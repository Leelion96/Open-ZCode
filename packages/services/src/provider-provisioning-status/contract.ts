import type { ProviderProvisioningLaneStatus } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 数据同步页「模型提供商」分类读取 / 重试该设备的 Provisioning lane（docs/remote/data-sync.md）。
 * 唯一数据源是 Main 协调器的 lane（内存，不持久化）；只在桌面本机 Host 注册，
 * 不进入远程 workspace RPC 合同、source-settings 服务集合和手机白名单。
 */
export interface IProviderProvisioningStatusService {
  /** 最近一次结果；`waitForIdle` 时等当前执行（含尾随同步）结束后返回。 */
  getStatus(params: {
    sourceServerId: string;
    waitForIdle?: boolean;
  }): Promise<ProviderProvisioningLaneStatus>;
  /** 最近一次失败后的用户重试：复用同一条 lane；没有 lane 时不执行，返回「无 lane」。 */
  retry(params: { sourceServerId: string }): Promise<ProviderProvisioningLaneStatus>;
}

export const IProviderProvisioningStatusService =
  createServiceDescriptor<IProviderProvisioningStatusService>(
    ServiceChannels.ProviderProvisioningStatus,
  );
