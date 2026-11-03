import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor, ProviderProvisioningLaneStatus } from "@/data-sync/contract.js";
import { toDataSyncProviderRows, type DataSyncProviderRow } from "@/data-sync/domain/providers.js";
import { logger } from "@/logger.js";

export type DataSyncProvidersList =
  | { phase: "loading" }
  | { phase: "ready"; rows: DataSyncProviderRow[] }
  | { phase: "error" };

export type DataSyncProvisioningView =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; status: ProviderProvisioningLaneStatus };

export interface DataSyncProvidersState {
  list: DataSyncProvidersList;
  provisioning: DataSyncProvisioningView;
  /** 用户点了「重试」且结果未返回。 */
  retrying: boolean;
  retry(): void;
}

/**
 * 模型提供商分类（只读）：本机 Personal Layer 的提供商列表 + 该设备 Provisioning lane 的最近结果。
 * 结果的唯一数据源是 Main 协调器的 lane，经本机 Host 的 providerProvisioningStatusService 读取，页面不另存。
 *
 * ```text
 * 打开 / sourceServerId·services·online 变化 → generation+1
 *   ├─ providerSettingsService.getView() ──▶ list（掩码后的行）
 *   └─ getStatus(read) ──▶ status
 *        └─ status.running ──▶ getStatus(waitForIdle) ──▶ status（本次执行的结果）
 * 重试 ──▶ retrying=true ──▶ retry（同一条 lane 的尾随同步）──▶ status, retrying=false
 * ```
 *
 * 每个状态请求都带递增序号，只采用最后发出的请求的结果；generation 变化后迟到的结果全部丢弃。
 */
export function useDataSyncProviders(params: {
  sourceServices: IServiceAccessor | undefined;
  sourceServerId: string;
  online: boolean;
}): DataSyncProvidersState {
  const { sourceServices, sourceServerId, online } = params;
  const [list, setList] = useState<DataSyncProvidersList>({ phase: "loading" });
  const [provisioning, setProvisioning] = useState<DataSyncProvisioningView>({
    phase: "loading",
  });
  const [retrying, setRetrying] = useState(false);
  const generationRef = useRef(0);
  const requestSeqRef = useRef(0);
  const laneService = sourceServices?.providerProvisioningStatusService;
  const providerSettingsService = sourceServices?.providerSettingsService;

  const applyStatus = useCallback(
    (
      generation: number,
      request: () => Promise<ProviderProvisioningLaneStatus>,
    ): Promise<ProviderProvisioningLaneStatus | undefined> => {
      const seq = ++requestSeqRef.current;
      return request().then(
        (status) => {
          if (generation !== generationRef.current || seq !== requestSeqRef.current) {
            return undefined;
          }
          setProvisioning({ phase: "ready", status });
          return status;
        },
        (error: unknown) => {
          if (generation === generationRef.current && seq === requestSeqRef.current) {
            setProvisioning({ phase: "error" });
          }
          logger.warn("[DataSync] 读取模型提供商同步状态失败", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        },
      );
    },
    [],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    setList({ phase: "loading" });
    setProvisioning({ phase: "loading" });
    setRetrying(false);

    if (providerSettingsService) {
      providerSettingsService.getView().then(
        (view) => {
          if (generation === generationRef.current) {
            setList({ phase: "ready", rows: toDataSyncProviderRows(view) });
          }
        },
        (error: unknown) => {
          if (generation === generationRef.current) setList({ phase: "error" });
          logger.warn("[DataSync] 读取本机模型提供商失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    } else {
      setList({ phase: "error" });
    }

    if (!laneService) {
      // Web / 手机没有本机 Host 的 Provisioning 状态服务：按「无 lane」展示，不提供重试。
      setProvisioning({ phase: "ready", status: { lane: "none" } });
      return;
    }
    void applyStatus(generation, () => laneService.getStatus({ sourceServerId })).then((status) => {
      if (status?.lane === "present" && status.running) {
        void applyStatus(generation, () =>
          laneService.getStatus({ sourceServerId, waitForIdle: true }),
        );
      }
    });
    // online 变化也重新读取：设备重新上线后 lane 可能已重新注册并完成首次同步。
  }, [applyStatus, laneService, online, providerSettingsService, sourceServerId]);

  const retry = useCallback(() => {
    if (!laneService) return;
    const generation = generationRef.current;
    setRetrying(true);
    void applyStatus(generation, () => laneService.retry({ sourceServerId })).finally(() => {
      if (generation === generationRef.current) setRetrying(false);
    });
  }, [applyStatus, laneService, sourceServerId]);

  return { list, provisioning, retrying, retry };
}
