/* off-peak 排队协议只对显式声明 off-peak-queue 的请求生效。
   429/3105 等待不消耗普通重试预算；3102 过号、3106 运行超时均携带过期标记，
   由 Host 结束本次任务，不自动补号。其他 provider 不采用这些业务码语义。 */
import { isOffPeakTicketExpiredCode } from "@zcode/shared";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isProviderBusinessError } from "./model-execution.js";

/**
 * ⚠ 与 desktop 侧 @zcode/shared/src/off-peak-types.ts 的同名常量跨包同值（wire 契约）：
 * providerId 随 per-turn runtimeModel 注入，错误标记随 task 终态错误文本回传，改动须两侧同步。
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** 单次排队等待钳制（D24 规则 2）：min(Retry-After, 5min)；无 Retry-After 时保守 60s 探测。 */
export const OFF_PEAK_QUEUE_WAIT_CAP_MS = 5 * 60_000;
export const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60_000;

export type OffPeakFailureDecision =
  | { kind: "queued"; delayMs: number }
  | { kind: "ticketExpired" };

/**
 * 判定 off-peak 特有失败语义；非 idle plan provider 一律返回 null（零影响）。
 * error 需传 unwrapRetryError 之后的原始错误（ProviderBusinessError 才能读到业务码）。
 */
export function resolveOffPeakFailureDecision(params: {
  offPeak: boolean;
  failure: ClassifiedModelFailure;
  error: unknown;
}): OffPeakFailureDecision | null {
  if (!params.offPeak) return null;
  const businessCode = isProviderBusinessError(params.error)
    ? params.error.providerCode
    : undefined;
  // 3102/3106 按新契约区分；3001 仅保留旧网关兼容，不将新的 3104 无效票据归为过期。
  if (isOffPeakTicketExpiredCode(businessCode) || businessCode === "3001") {
    return { kind: "ticketExpired" };
  }
  // 排队真实信号 = HTTP 429（3105 带 Retry-After）；无业务码的裸 429 同样按排队处理。
  if (businessCode === "3105" || params.failure.statusCode === 429) {
    return {
      kind: "queued",
      delayMs: Math.min(
        params.failure.retryAfterMs ?? OFF_PEAK_QUEUE_WAIT_DEFAULT_MS,
        OFF_PEAK_QUEUE_WAIT_CAP_MS,
      ),
    };
  }
  return null;
}

export function offPeakTicketExpiredMessage(original: string): string {
  return `${OFF_PEAK_TICKET_EXPIRED_MARKER}: ${original}`;
}
