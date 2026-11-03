/**
 * workflow 内的模型侧错误策略表。
 *
 * 分类器（failure-classifier.ts）回答的是「主对话要不要自动重试」；这张表回答的是
 * 「workflow 要不要停下来找人」。两张表在 3008/3009/3010（并发上限）上答案相反，这正是
 * 本模块存在的理由：workflow 子代理与工具侧请求持有无上限重试预算（`modelRetryBudget`），
 * 在它们身上，只有**确定性的、需要人来解决的**错误才值得停下 run；其余一切（TLS、5xx、限流、
 * 网络错误）一律在内重试，靠 stall 通知做逃生口。分类器不认识的业务码是例外：同一次请求里它
 * **连续**出现到 {@link WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE} 次，就停下。
 *
 * runner（attempt 循环的重试闸门）与 bootstrap driver（把 reject 归成 stopRun / askFailed）
 * 共用**同一个**函数：runner 判 retry 的失败绝不会以 stop 到 driver；runner 判 stop 的失败
 * 到 driver 时策略表必判 stop（同一函数、同一输入——连续计数随 adapter 错误的
 * `unrecognizedCodeStreak` 带过去）。
 */

import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isRetryableFailure } from "./failure-classifier.js";
import type { ModelRetryBudget } from "@zcode/contracts";
import { isUnboundedRetryBudget } from "./retry-budget.js";

/** `ProviderStop` 的判定键：通知文案表按它选句子（不是按 reason）。 */
export type WorkflowProviderStopKind =
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "invalid_request"
  | "quota"
  | "other";

/**
 * 配额类业务码（Stop 集的一行）。与 failure-provider-business-codes.ts 的
 * TERMINAL_RATE_LIMIT_MAPPING 有意**分开维护**：那张表决定主对话不自动重试，这张表决定
 * workflow 停下来等配额重置 / 充值。1005 在分类器里是 invalid_request，这里必须先按码判
 * 配额再看 reason。
 */
export const WORKFLOW_QUOTA_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1308",
  "1310",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "2056",
  "20097",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

/**
 * 分类器不认识的业务码（reason = unknown 且带业务码）在同一次请求里**连续**出现的上限，含首次。
 *
 * 根因（2026-10-16 事故）：服务端对一批账号确定性地返回 1113，分类器不认识它，workflow 无上限
 * 预算于是一直重试，run 永远挂着、只剩 stall 通知。不认识的码可能是瞬态的，所以不首次即停；
 * 同一次请求里连续 10 次都是不认识的码（全是它时退避后约 6 分钟），就当它是确定性的，以 kind
 * `other` 停下（可 Resume）。数的是**连续**出现，不是尝试次数：中间夹一次别的失败（网络错误、
 * 5xx、限流）就从零重数——「9 次网络错误后来一次未知码」只算 1 次，不该停（MR !3072 评审）。
 * 与主对话的 `DEFAULT_MAX_RETRIES = 10` 同量级。
 */
export const WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE = 10;

/** 这一次失败是不是「分类器不认识的业务码」：reason = unknown 且带 provider 业务码。 */
export function isUnrecognizedProviderCodeFailure(
  failure: Pick<ClassifiedModelFailure, "reason">,
  providerCode: string | undefined,
): boolean {
  return failure.reason === ModelFailureReason.Unknown && providerCode !== undefined;
}

/**
 * runner 每次失败后更新连续计数：这一次仍是不认识的业务码就 +1，否则清零。计数只活在一次请求的
 * attempt 循环里（成功即结束循环），runner 把它传给策略表，并随 adapter 错误带给 driver。
 */
export function nextUnrecognizedCodeStreak(
  previous: number,
  failure: Pick<ClassifiedModelFailure, "reason">,
  providerCode: string | undefined,
): number {
  return isUnrecognizedProviderCodeFailure(failure, providerCode) ? previous + 1 : 0;
}

/** 「provider 没配好 / 选型无效」一族的 ModelErrorCode（reason 不一定是 provider_not_configured）。 */
const NOT_CONFIGURED_ERROR_CODES: ReadonlySet<string> = new Set([
  ModelErrorCode.ProviderNotFound,
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelConfigMissing,
  ModelErrorCode.InvalidModelSelection,
  ModelErrorCode.ModelRequestAuthMissing,
]);

export type WorkflowModelFailurePolicy =
  | { decision: "retry" }
  | { decision: "stop"; kind: WorkflowProviderStopKind }
  /** core 已压缩失败才会到这里：节点以 `ContextLimit` 失败，脚本可 catch，未 catch 则 errored。 */
  | { decision: "context_exceeded" }
  | { decision: "cancelled" };

/**
 * 策略表本体。输入是分类器的结果（只读 code / reason / retryable）、provider 业务码，以及
 * 不认识的业务码在同一次请求里连续出现了几次、含这一次（缺省 1；只有不认识的业务码读它，见
 * {@link nextUnrecognizedCodeStreak}）。
 * 顺序有意义：取消最先（它不是错误）；配额按**码**判，先于 reason（1005 的 reason 是
 * invalid_request）；其余按 reason / code；表外一切 = retry。
 */
export function resolveWorkflowModelFailurePolicy(
  failure: Pick<ClassifiedModelFailure, "code" | "reason" | "retryable">,
  providerCode: string | undefined,
  unrecognizedCodeStreak = 1,
): WorkflowModelFailurePolicy {
  if (failure.reason === ModelFailureReason.Cancelled) return { decision: "cancelled" };
  if (providerCode !== undefined && WORKFLOW_QUOTA_PROVIDER_CODES.has(providerCode)) {
    return { decision: "stop", kind: "quota" };
  }
  if (failure.reason === ModelFailureReason.AuthFailed) return { decision: "stop", kind: "auth" };
  if (
    failure.reason === ModelFailureReason.ProviderNotConfigured ||
    NOT_CONFIGURED_ERROR_CODES.has(failure.code)
  ) {
    return { decision: "stop", kind: "not_configured" };
  }
  if (failure.code === ModelErrorCode.ModelNotFound) {
    return { decision: "stop", kind: "model_unavailable" };
  }
  if (failure.reason === ModelFailureReason.ContextExceeded)
    return { decision: "context_exceeded" };
  // 「请求无效」只认 provider 对**请求**的拒绝（3001、HTTP 400/422）。`invalid_model_response`
  // 也被分类器标成 invalid_request，但那是**响应**解析失败——再问一次很可能就好，归 retry。
  if (
    failure.reason === ModelFailureReason.InvalidRequest &&
    failure.code !== ModelErrorCode.InvalidModelResponse
  ) {
    return { decision: "stop", kind: "invalid_request" };
  }
  if (
    isUnrecognizedProviderCodeFailure(failure, providerCode) &&
    unrecognizedCodeStreak >= WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE
  ) {
    return { decision: "stop", kind: "other" };
  }
  return { decision: "retry" };
}

/**
 * runner 重试闸门的替换点：有界预算照旧读分类器的 `retryable`（主对话一字不动）；无上限
 * 预算（workflow 流量）改读策略表——`retry` 即可重试，`stop` / `context_exceeded` 不重试。
 * 取消由调用方在此之前单独短路（两处 runner 都已如此）。
 */
export function retryAllowedByFailurePolicy(
  failure: ClassifiedModelFailure,
  retryBudget: ModelRetryBudget | undefined,
  providerCode: string | undefined,
  unrecognizedCodeStreak?: number,
): boolean {
  if (!isUnboundedRetryBudget(retryBudget)) return isRetryableFailure(failure);
  return (
    resolveWorkflowModelFailurePolicy(failure, providerCode, unrecognizedCodeStreak).decision ===
    "retry"
  );
}

/** driver 侧从 adapter 错误读出的事实：策略裁决 + 拼 `ProviderStopDetails` 要的字段。 */
export interface WorkflowModelFailureInspection {
  policy: WorkflowModelFailurePolicy;
  /** contracts `ModelFailureReason` 的值。 */
  reason: string;
  providerCode?: string;
  providerId?: string;
  modelId?: string;
  /** adapter 错误的 message（映射过的业务码下就是 provider 原文）。 */
  rawMessage?: string;
  /**
   * 配额类时的重置时刻（epoch ms）：Retry-After 优先，否则读 provider 原文（{@link parseQuotaResetAt}）。
   * 两种来源都要落在 {@link isPlausibleQuotaResetAt} 的窗口里。
   */
  resetAt?: number;
}

/** 额度重置时刻的合理窗口：过去一天（时钟偏差）到未来 35 天（周、月额度）。窗口外的值不可信。 */
const QUOTA_RESET_PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const QUOTA_RESET_MAX_AHEAD_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * 重置时刻是否落在合理窗口里。Retry-After 与原文两种来源共用这一处判据：异常或恶意的
 * header（例如几年的秒数）不能比原文更容易把一个荒谬的时刻写进停止记录（MR !3072 评审 SG-01）。
 */
export function isPlausibleQuotaResetAt(at: number, now: number): boolean {
  return (
    Number.isFinite(at) &&
    at >= now - QUOTA_RESET_PAST_TOLERANCE_MS &&
    at <= now + QUOTA_RESET_MAX_AHEAD_MS
  );
}
/** 原文里的重置时刻，如「您的限额将在 2026-10-15 18:50:42 重置」（1308 / 1310 / 1316 等）。 */
const QUOTA_RESET_TIME_PATTERN = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/u;
/** 只在原文确实在说「重置」时才读时间，避免把别的时间戳当成重置时刻。 */
const QUOTA_RESET_WORD_PATTERN = /重置|reset/iu;
/**
 * 文案来自 bigmodel 服务端，时间不带时区，按北京时间解释。依据（2026-10-15 线上样本）：
 * `[1308][…您的限额将在 2026-10-15 18:50:42 重置。][20261015175300…]`——同一条原文里请求 id 的
 * 时间前缀是 17:53:00，与用户所在的北京时间一致，重置时刻落在其后一小时内。
 */
const QUOTA_RESET_TIME_UTC_OFFSET = "+08:00";

/**
 * 从额度错误的 provider 原文里读出重置时刻（epoch ms）。读不出、或落在合理窗口外时返回
 * undefined——宁可不填，也不让 workflow 在一个荒谬的时刻自动续跑。
 */
export function parseQuotaResetAt(message: string, now: number): number | undefined {
  if (!QUOTA_RESET_WORD_PATTERN.test(message)) return undefined;
  const match = QUOTA_RESET_TIME_PATTERN.exec(message);
  if (match === null) return undefined;
  const at = Date.parse(`${match[1]}T${match[2]}${QUOTA_RESET_TIME_UTC_OFFSET}`);
  return isPlausibleQuotaResetAt(at, now) ? at : undefined;
}

/**
 * 按**形状**读 adapter 错误（`AiSdkModelAdapterError`：`name` + `context.reason` …），直接或
 * 一层 `cause` 之内；bootstrap 与 adapters 之间可能存在两份类定义（dist 边界），形状不会漂。
 * 不是模型层错误时返回 undefined（driver 照旧归成 DriverError）。
 */
export function inspectWorkflowModelFailure(
  error: unknown,
): WorkflowModelFailureInspection | undefined {
  const direct = readAdapterError(error);
  const found =
    direct ?? readAdapterError((error as { cause?: unknown } | undefined)?.cause ?? undefined);
  if (found === undefined) return undefined;
  const { context, code, message } = found;
  const reason = stringValue(context.reason);
  if (reason === undefined) return undefined;
  const providerCode = codeValue(context.providerCode);
  // runner 放弃时不认识的业务码已连续出现几次（runner 随 toAdapterError 写进 context）：与 runner
  // 闸门读同一个数。
  const unrecognizedCodeStreak =
    typeof context.unrecognizedCodeStreak === "number" ? context.unrecognizedCodeStreak : undefined;
  const policy = resolveWorkflowModelFailurePolicy(
    {
      code: code as ClassifiedModelFailure["code"],
      reason: reason as ClassifiedModelFailure["reason"],
      retryable: context.retryable === true,
    },
    providerCode,
    unrecognizedCodeStreak,
  );
  const retryAfterMs = context.retryAfterMs;
  const inspection: WorkflowModelFailureInspection = { policy, reason };
  if (providerCode !== undefined) inspection.providerCode = providerCode;
  const providerId = stringValue(context.providerId);
  if (providerId !== undefined) inspection.providerId = providerId;
  const modelId = stringValue(context.modelId);
  if (modelId !== undefined) inspection.modelId = modelId;
  if (message.length > 0) inspection.rawMessage = message;
  if (policy.decision === "stop" && policy.kind === "quota") {
    // Retry-After 是 provider 给的相对时长，最准；没有、或算出的时刻落在合理窗口外时，退到原文里的
    // 绝对时刻。重置时刻是自动续跑的唯一依据（bootstrap 的 dynamic-workflow-quota-resume.ts），两者
    // 都没有就不续跑、只通知。
    const now = Date.now();
    const fromHeader =
      typeof retryAfterMs === "number" &&
      retryAfterMs > 0 &&
      isPlausibleQuotaResetAt(now + retryAfterMs, now)
        ? now + retryAfterMs
        : undefined;
    const resetAt = fromHeader ?? parseQuotaResetAt(message, now);
    if (resetAt !== undefined) inspection.resetAt = resetAt;
  }
  return inspection;
}

function readAdapterError(
  error: unknown,
): { context: Record<string, unknown>; code: string; message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    context?: unknown;
    message?: unknown;
  };
  if (candidate.name !== "AiSdkModelAdapterError") return undefined;
  const context =
    typeof candidate.context === "object" && candidate.context !== null
      ? (candidate.context as Record<string, unknown>)
      : {};
  return {
    context,
    code: typeof candidate.code === "string" ? candidate.code : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** provider 业务码可能是数字（响应体原样）也可能是字符串；统一成字符串键。 */
function codeValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return stringValue(value);
}
