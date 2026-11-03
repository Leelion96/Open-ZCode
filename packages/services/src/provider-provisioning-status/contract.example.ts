/**
 * provider-provisioning-status 标准调用示例：读取最近结果，只在有 lane 且最近一次失败时重试。
 */
import type { ProviderProvisioningLaneStatus } from "@zcode/shared";
import type { IProviderProvisioningStatusService } from "./contract.js";

export async function exampleRetryIfFailed(
  service: IProviderProvisioningStatusService,
  sourceServerId: string,
): Promise<ProviderProvisioningLaneStatus> {
  const status = await service.getStatus({ sourceServerId, waitForIdle: true });
  if (status.lane === "present" && status.lastResult?.outcome === "failed") {
    return service.retry({ sourceServerId });
  }
  return status;
}
