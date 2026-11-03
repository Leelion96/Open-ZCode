import type { ProviderProvisioningLaneStatus, ProviderSettingsView } from "@/data-sync/contract.js";

/** 模型提供商分类的一行（只读）。API Key 在投影时就掩码，明文不进入弹窗状态。 */
export interface DataSyncProviderRow {
  providerId: string;
  name: string;
  endpoint?: string;
  /** 已启用的模型 ID。 */
  models: string[];
  maskedApiKey?: string;
}

const MASK = "••••";

/** 只保留末 4 位；较短的 Key 全部掩码，避免泄露大部分内容。 */
export function maskDataSyncApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  return trimmed.length >= 12 ? `${MASK}${trimmed.slice(-4)}` : `${MASK}${MASK}`;
}

/** 本机 Personal Layer 中的提供商：有 personalConfig 的才列出，顺序沿用 Settings View。 */
export function toDataSyncProviderRows(view: ProviderSettingsView): DataSyncProviderRow[] {
  return view.providers
    .filter((provider) => provider.personalConfig !== undefined)
    .map((provider) => {
      const endpoint = provider.effectiveConfig.api?.baseUrl?.trim();
      const access = provider.effectiveConfig.access;
      // 账号类提供商（登录态）没有 apiKey 字段，只有 Key 类提供商显示掩码。
      const apiKey = access && "apiKey" in access ? access.apiKey?.trim() : undefined;
      return {
        providerId: provider.providerId,
        name: provider.providerName ?? provider.providerId,
        ...(endpoint ? { endpoint } : {}),
        models: provider.models.filter((model) => model.enabled).map((model) => model.modelId),
        ...(apiKey ? { maskedApiKey: maskDataSyncApiKey(apiKey) } : {}),
      };
    });
}

/** 分类顶部状态行的展示态；`retrying` 期间按执行中显示。 */
export type DataSyncProvisioningDisplay =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "never" }
  | { kind: "success"; at: number }
  | { kind: "failed"; at: number; errorCode?: string };

export function resolveDataSyncProvisioningDisplay(
  view:
    | { phase: "loading" }
    | { phase: "error" }
    | { phase: "ready"; status: ProviderProvisioningLaneStatus },
  retrying: boolean,
): DataSyncProvisioningDisplay {
  if (view.phase !== "ready") return { kind: view.phase };
  const { status } = view;
  if (status.lane === "none") return { kind: "none" };
  if (retrying || status.running) return { kind: "running" };
  if (!status.lastResult) return { kind: "never" };
  return status.lastResult.outcome === "success"
    ? { kind: "success", at: status.lastResult.at }
    : {
        kind: "failed",
        at: status.lastResult.at,
        ...(status.lastResult.errorCode ? { errorCode: status.lastResult.errorCode } : {}),
      };
}
