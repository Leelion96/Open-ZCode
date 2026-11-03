import {
  HostMessageTypes,
  HostResponseTypes,
  type ProviderProvisioningLaneStatus,
} from "@zcode/shared";
import type { IProviderProvisioningStatusService } from "./contract.js";

type LaneAction = "read" | "wait" | "retry";

interface LaneResultMessage {
  readonly type: typeof HostMessageTypes.ProviderProvisioningLaneResult;
  readonly requestId: string;
  readonly status: ProviderProvisioningLaneStatus;
}

/**
 * 本机 Host 到 Main 协调器的 Provisioning lane 访问。
 *
 * ```text
 * Renderer ─RPC─▶ service.getStatus / retry ─▶ HostResponse lane-request {requestId, action} ─▶ Main 协调器
 *                                   ◀─ handleResult ◀─ HostMessage lane-result {requestId, status} ◀─┘
 * ```
 *
 * Main 对每个请求都应答（无协调器时回「无 lane」），这里不设超时；Host 退出时请求随进程一起消失。
 */
export function createHostProviderProvisioningStatus(postMessage: (message: unknown) => void): {
  service: IProviderProvisioningStatusService;
  handleResult(message: LaneResultMessage): boolean;
} {
  const pending = new Map<string, (status: ProviderProvisioningLaneStatus) => void>();
  let sequence = 0;

  const request = (
    action: LaneAction,
    sourceServerId: string,
  ): Promise<ProviderProvisioningLaneStatus> => {
    const requestId = `provider-provisioning-lane-${Date.now()}-${sequence++}`;
    return new Promise((resolve, reject) => {
      pending.set(requestId, resolve);
      try {
        postMessage({
          type: HostResponseTypes.ProviderProvisioningLaneRequest,
          requestId,
          sourceServerId,
          action,
        });
      } catch (error) {
        pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  return {
    service: {
      getStatus: (params) => request(params.waitForIdle ? "wait" : "read", params.sourceServerId),
      retry: (params) => request("retry", params.sourceServerId),
    },
    handleResult(message) {
      const resolve = pending.get(message.requestId);
      if (!resolve) return false;
      pending.delete(message.requestId);
      resolve(message.status);
      return true;
    },
  };
}
