import { describe, expect, it } from "vitest";
import { ModelErrorCode, ModelFailureReason, ModelRetryBudget } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "../src/model/errors.js";
import type { ClassifiedModelFailure } from "../src/model/failure-classifier.js";
import {
  WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE,
  inspectWorkflowModelFailure,
  isPlausibleQuotaResetAt,
  nextUnrecognizedCodeStreak,
  parseQuotaResetAt,
  resolveWorkflowModelFailurePolicy,
  retryAllowedByFailurePolicy,
} from "../src/model/workflow-model-failure-policy.js";

// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Terminal states」：Stop 集逐行一例，其余一切 retry。
function failure(
  overrides: Partial<ClassifiedModelFailure> & Pick<ClassifiedModelFailure, "reason">,
): ClassifiedModelFailure {
  return {
    code: ModelErrorCode.ModelRequestFailed,
    message: "x",
    retryReason: "network_error",
    retryable: false,
    ...overrides,
  };
}

describe("resolveWorkflowModelFailurePolicy", () => {
  it("Stop 集：认证 / 未配置 / 模型不可用 / 请求无效 / 配额", () => {
    expect(
      resolveWorkflowModelFailurePolicy(failure({ reason: ModelFailureReason.AuthFailed }), "1006"),
    ).toEqual({
      decision: "stop",
      kind: "auth",
    });
    expect(
      resolveWorkflowModelFailurePolicy(failure({ reason: ModelFailureReason.AuthFailed }), "3007"),
    ).toEqual({
      decision: "stop",
      kind: "auth",
    });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.ProviderNotConfigured }),
        undefined,
      ),
    ).toEqual({ decision: "stop", kind: "not_configured" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ code: ModelErrorCode.ModelConfigMissing, reason: ModelFailureReason.Unknown }),
        undefined,
      ),
    ).toEqual({ decision: "stop", kind: "not_configured" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ code: ModelErrorCode.ModelNotFound, reason: ModelFailureReason.InvalidRequest }),
        "3006",
      ),
    ).toEqual({ decision: "stop", kind: "model_unavailable" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({
          code: ModelErrorCode.InvalidModelRequest,
          reason: ModelFailureReason.InvalidRequest,
        }),
        "3001",
      ),
    ).toEqual({ decision: "stop", kind: "invalid_request" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({
          code: ModelErrorCode.InvalidModelRequest,
          reason: ModelFailureReason.InvalidRequest,
          statusCode: 400,
        }),
        undefined,
      ),
    ).toEqual({ decision: "stop", kind: "invalid_request" });
    // 1005 在分类器里是 invalid_request：配额按码判、先于 reason。
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.InvalidRequest }),
        "1005",
      ),
    ).toEqual({
      decision: "stop",
      kind: "quota",
    });
  });

  it("并发上限 3008/3009/3010 与其余一切都是 retry（含分类器判不可重试的）", () => {
    for (const code of ["3008", "3009", "3010"]) {
      expect(
        resolveWorkflowModelFailurePolicy(
          failure({
            code: ModelErrorCode.ModelRateLimited,
            reason: ModelFailureReason.RateLimited,
            retryable: false,
          }),
          code,
        ),
      ).toEqual({ decision: "retry" });
    }
    for (const reason of [
      ModelFailureReason.RateLimited,
      ModelFailureReason.ProviderOverloaded,
      ModelFailureReason.ServerError,
      ModelFailureReason.NetworkError,
      ModelFailureReason.Timeout,
      ModelFailureReason.StreamIdleTimeout,
      ModelFailureReason.Unknown,
      ModelFailureReason.TlsError,
      ModelFailureReason.ProxyError,
    ]) {
      expect(resolveWorkflowModelFailurePolicy(failure({ reason }), undefined)).toEqual({
        decision: "retry",
      });
    }
    for (const code of ["1008", "1314", "1315", "2007"]) {
      expect(
        resolveWorkflowModelFailurePolicy(failure({ reason: ModelFailureReason.Unknown }), code),
      ).toEqual({
        decision: "retry",
      });
    }
    // 响应解析失败也被分类器标成 invalid_request，但那不是 provider 拒绝请求：再问一次。
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({
          code: ModelErrorCode.InvalidModelResponse,
          reason: ModelFailureReason.InvalidRequest,
        }),
        undefined,
      ),
    ).toEqual({ decision: "retry" });
  });

  it("context exceeded 与 cancelled 各有自己的裁决", () => {
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.ContextExceeded }),
        "1261",
      ),
    ).toEqual({
      decision: "context_exceeded",
    });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.Cancelled }),
        undefined,
      ),
    ).toEqual({
      decision: "cancelled",
    });
  });
});

describe("retryAllowedByFailurePolicy", () => {
  const busy = failure({
    code: ModelErrorCode.ModelRateLimited,
    reason: ModelFailureReason.RateLimited,
    retryable: false,
  });
  it("有界预算照旧读分类器的 retryable（主对话一字不动）", () => {
    expect(retryAllowedByFailurePolicy(busy, undefined, "3008")).toBe(false);
    expect(retryAllowedByFailurePolicy(busy, ModelRetryBudget.Default, "3008")).toBe(false);
    expect(retryAllowedByFailurePolicy({ ...busy, retryable: true }, undefined, undefined)).toBe(
      true,
    );
  });
  it("无上限预算读策略表", () => {
    expect(retryAllowedByFailurePolicy(busy, ModelRetryBudget.Unbounded, "3008")).toBe(true);
    expect(
      retryAllowedByFailurePolicy(
        failure({ reason: ModelFailureReason.AuthFailed }),
        ModelRetryBudget.Unbounded,
        "1006",
      ),
    ).toBe(false);
    expect(retryAllowedByFailurePolicy(busy, ModelRetryBudget.Unbounded, "1308")).toBe(false);
  });
});

describe("inspectWorkflowModelFailure", () => {
  it("按形状读 adapter 错误（直接或一层 cause），带出拼 ProviderStop 要的事实", () => {
    const adapterError = new AiSdkModelAdapterError(
      ModelErrorCode.ModelRateLimited,
      "[1308] 已达到 5 小时的使用上限",
      {
        context: {
          reason: "rate_limited",
          retryable: false,
          providerCode: 1308,
          providerId: "account:bigmodel-coding-plan",
          modelId: "glm-5.3",
          retryAfterMs: 60_000,
        },
      },
    );
    const direct = inspectWorkflowModelFailure(adapterError);
    expect(direct).toMatchObject({
      policy: { decision: "stop", kind: "quota" },
      reason: "rate_limited",
      providerCode: "1308",
      providerId: "account:bigmodel-coding-plan",
      modelId: "glm-5.3",
      rawMessage: "[1308] 已达到 5 小时的使用上限",
    });
    expect(direct?.resetAt).toBeGreaterThan(Date.now());
    const wrapped = new Error("Subagent turn failed", { cause: adapterError });
    expect(inspectWorkflowModelFailure(wrapped)?.policy).toEqual({
      decision: "stop",
      kind: "quota",
    });
  });

  it("并发上限是 retry；非模型层错误返回 undefined", () => {
    const busy = new AiSdkModelAdapterError(
      ModelErrorCode.ModelRateLimited,
      "user concurrency limit exceeded",
      {
        context: { reason: "rate_limited", retryable: false, providerCode: "3008" },
      },
    );
    expect(inspectWorkflowModelFailure(busy)).toMatchObject({
      policy: { decision: "retry" },
      providerCode: "3008",
    });
    expect(inspectWorkflowModelFailure(new Error("tool crashed"))).toBeUndefined();
    expect(inspectWorkflowModelFailure(undefined)).toBeUndefined();
    // 没有 reason 的 adapter 错误（构造期）也不归模型层。
    expect(
      inspectWorkflowModelFailure(
        new AiSdkModelAdapterError(ModelErrorCode.ModelRequestFailed, "x", { context: {} }),
      ),
    ).toBeUndefined();
  });
});

// 分类器不认识的业务码（reason = unknown，如 2026-10-16 事故里的 1113）：原先无限重试，一个确定性的
// 服务端拒绝会让 run 永远挂着、只剩 stall 通知。现在同一次请求里它**连续**出现到第 N 次时停下（kind
// other，可 Resume）；网络错误、5xx、限流照旧无限重试，并让连续计数从零重数（MR !3072 评审 CR-02）。
describe("unrecognized provider codes", () => {
  const unknown = failure({ reason: ModelFailureReason.Unknown });
  const network = failure({ reason: ModelFailureReason.NetworkError });
  const limit = WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE;

  /** 按 runner 的做法逐次更新连续计数，返回每一次的策略裁决。 */
  function decide(sequence: readonly { failure: ClassifiedModelFailure; code?: string }[]) {
    let streak = 0;
    return sequence.map(({ failure: item, code }) => {
      streak = nextUnrecognizedCodeStreak(streak, item, code);
      return resolveWorkflowModelFailurePolicy(item, code, streak).decision;
    });
  }

  it("is 10 in a row", () => {
    expect(limit).toBe(10);
  });

  it("retries below the limit and stops at it", () => {
    expect(resolveWorkflowModelFailurePolicy(unknown, "1113", limit - 1)).toEqual({
      decision: "retry",
    });
    expect(resolveWorkflowModelFailurePolicy(unknown, "1113", limit)).toEqual({
      decision: "stop",
      kind: "other",
    });
    expect(resolveWorkflowModelFailurePolicy(unknown, "1314", limit + 5)).toEqual({
      decision: "stop",
      kind: "other",
    });
  });

  it("counts only consecutive unknown codes: any other failure starts the count again", () => {
    expect(nextUnrecognizedCodeStreak(0, unknown, "1113")).toBe(1);
    expect(nextUnrecognizedCodeStreak(4, unknown, "1113")).toBe(5);
    expect(nextUnrecognizedCodeStreak(4, network, undefined)).toBe(0);
    expect(nextUnrecognizedCodeStreak(4, unknown, undefined)).toBe(0);
    expect(nextUnrecognizedCodeStreak(4, network, "1234")).toBe(0);
  });

  it("does not stop on one unknown code after nine network errors", () => {
    const decisions = decide([
      ...Array.from({ length: limit - 1 }, () => ({ failure: network })),
      { failure: unknown, code: "1113" },
    ]);
    expect(decisions.every((decision) => decision === "retry")).toBe(true);
  });

  it("does not stop while unknown codes alternate with network errors", () => {
    const decisions = decide(
      Array.from({ length: limit * 3 }, (_, index) =>
        index % 2 === 0 ? { failure: unknown, code: "1113" } : { failure: network },
      ),
    );
    expect(decisions.every((decision) => decision === "retry")).toBe(true);
  });

  it("stops on the 10th unknown code in a row, even after earlier network errors", () => {
    const decisions = decide([
      { failure: network },
      { failure: network },
      ...Array.from({ length: limit }, () => ({ failure: unknown, code: "1113" })),
    ]);
    expect(decisions.slice(0, -1).every((decision) => decision === "retry")).toBe(true);
    expect(decisions.at(-1)).toBe("stop");
  });

  it("keeps retrying network, server and rate-limit failures, and an unknown reason with no code", () => {
    for (const reason of [
      ModelFailureReason.NetworkError,
      ModelFailureReason.ServerError,
      ModelFailureReason.RateLimited,
      ModelFailureReason.Timeout,
    ]) {
      expect(resolveWorkflowModelFailurePolicy(failure({ reason }), "1234", 50)).toEqual({
        decision: "retry",
      });
    }
    expect(resolveWorkflowModelFailurePolicy(unknown, undefined, 50)).toEqual({
      decision: "retry",
    });
  });

  it("caps the runner gate for workflow traffic only", () => {
    expect(
      retryAllowedByFailurePolicy(unknown, ModelRetryBudget.Unbounded, "1113", limit - 1),
    ).toBe(true);
    expect(retryAllowedByFailurePolicy(unknown, ModelRetryBudget.Unbounded, "1113", limit)).toBe(
      false,
    );
    // 有界预算（主对话）照旧只读分类器的 retryable，与连续计数无关。
    expect(retryAllowedByFailurePolicy(unknown, undefined, "1113", 1)).toBe(false);
  });

  it("reads the streak from the adapter error, so the driver stops where the runner gave up", () => {
    const at = (context: Record<string, unknown>) =>
      inspectWorkflowModelFailure(
        new AiSdkModelAdapterError(ModelErrorCode.ModelRequestFailed, "[1113] 账户异常", {
          context: { providerCode: 1113, reason: "unknown", retryable: false, ...context },
        }),
      )?.policy;
    expect(at({ unrecognizedCodeStreak: limit - 1 })).toEqual({ decision: "retry" });
    expect(at({ unrecognizedCodeStreak: limit })).toEqual({ decision: "stop", kind: "other" });
    // 尝试次数不再是判据：第 10 次尝试、但未知码只连续出现了 1 次，照旧重试。
    expect(at({ attempt: limit, unrecognizedCodeStreak: 1 })).toEqual({ decision: "retry" });
  });
});

// 额度停止的重置时刻（docs/dynamic-workflow/... 「Resuming after a quota reset」）：Retry-After 优先；
// 没有时从 provider 原文里读「您的限额将在 YYYY-MM-DD HH:MM:SS 重置」。时刻按北京时间解释——
// 文案来自 bigmodel 服务端，时间不带时区（2026-10 线上样本，如「将在 2026-10-15 18:50:42 重置」）。
describe("quota reset time", () => {
  const now = Date.parse("2026-10-15T08:00:00.000Z"); // 北京时间 16:00

  it("reads the reset time from the provider's message, as Beijing time", () => {
    expect(
      parseQuotaResetAt(
        "[1308] 已达到 5 小时的使用上限。您的限额将在 2026-10-15 18:50:42 重置",
        now,
      ),
    ).toBe(Date.parse("2026-10-15T10:50:42.000Z"));
    expect(
      parseQuotaResetAt("您已达到每周/每月使用上限，您的限额将在 2026-10-20 00:00:00 重置", now),
    ).toBe(Date.parse("2026-10-19T16:00:00.000Z"));
    // 线上原文的完整形态：业务码、文案、请求 id 各占一对方括号；请求 id 的数字串不是时间。
    expect(
      parseQuotaResetAt(
        "[1308][已达到 5 小时的使用上限。您的限额将在 2026-10-15 18:50:42 重置。][20261015175300b9eb69fdbe0f4b93]",
        now,
      ),
    ).toBe(Date.parse("2026-10-15T10:50:42.000Z"));
  });

  it("ignores messages without a reset time, and times far outside a plausible window", () => {
    expect(parseQuotaResetAt("insufficient_quota", now)).toBeUndefined();
    expect(parseQuotaResetAt("您的限额将在 2019-01-01 00:00:00 重置", now)).toBeUndefined();
    expect(parseQuotaResetAt("您的限额将在 2027-06-01 00:00:00 重置", now)).toBeUndefined();
  });

  it("fills resetAt from the message when there is no Retry-After", () => {
    const inspected = inspectWorkflowModelFailure(
      new AiSdkModelAdapterError(
        ModelErrorCode.ModelRateLimited,
        "[1308] 已达到 5 小时的使用上限。您的限额将在 2099-01-01 00:00:00 重置",
        { context: { reason: "rate_limited", retryable: false, providerCode: "1308" } },
      ),
    );
    // 2099 远超合理窗口：不填，比填一个荒谬的时刻好。
    expect(inspected?.resetAt).toBeUndefined();
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const beijing = new Date(soon.getTime() + 8 * 60 * 60 * 1000).toISOString();
    const text = `${beijing.slice(0, 10)} ${beijing.slice(11, 19)}`;
    const fromMessage = inspectWorkflowModelFailure(
      new AiSdkModelAdapterError(
        ModelErrorCode.ModelRateLimited,
        `[1308] 已达到 5 小时的使用上限。您的限额将在 ${text} 重置`,
        { context: { reason: "rate_limited", retryable: false, providerCode: "1308" } },
      ),
    );
    expect(fromMessage?.resetAt).toBe(Math.floor(soon.getTime() / 1000) * 1000);
  });

  // MR !3072 第 2 轮评审 SG-01：Retry-After 与原文共用同一个合理窗口。
  it("ignores a Retry-After outside the plausible window, and reads the message instead", () => {
    const quotaError = (retryAfterMs: number, message = "[1308] 已达到 5 小时的使用上限") =>
      inspectWorkflowModelFailure(
        new AiSdkModelAdapterError(ModelErrorCode.ModelRateLimited, message, {
          context: { reason: "rate_limited", retryable: false, providerCode: "1308", retryAfterMs },
        }),
      );
    const thirtyYears = 30 * 365 * 24 * 60 * 60 * 1000;
    for (const retryAfterMs of [thirtyYears, 36 * 24 * 60 * 60 * 1000, -60_000, 0, NaN, Infinity]) {
      expect(quotaError(retryAfterMs)?.resetAt).toBeUndefined();
    }
    // header 不可信、原文里有可信的时刻：用原文的。
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const beijing = new Date(soon.getTime() + 8 * 60 * 60 * 1000).toISOString();
    const text = `${beijing.slice(0, 10)} ${beijing.slice(11, 19)}`;
    expect(quotaError(thirtyYears, `[1308] 您的限额将在 ${text} 重置`)?.resetAt).toBe(
      Math.floor(soon.getTime() / 1000) * 1000,
    );
    // 窗口上沿以内（35 天）照常采用 header。
    const before = Date.now();
    const monthly = quotaError(30 * 24 * 60 * 60 * 1000)?.resetAt;
    expect(monthly).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
  });

  it("judges plausibility with one window for both sources", () => {
    const now = Date.parse("2026-10-15T08:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    expect(isPlausibleQuotaResetAt(now + 35 * day, now)).toBe(true);
    expect(isPlausibleQuotaResetAt(now + 35 * day + 1, now)).toBe(false);
    expect(isPlausibleQuotaResetAt(now - day, now)).toBe(true);
    expect(isPlausibleQuotaResetAt(now - day - 1, now)).toBe(false);
    expect(isPlausibleQuotaResetAt(Number.NaN, now)).toBe(false);
  });

  it("keeps Retry-After first when both are present", () => {
    const before = Date.now();
    const inspected = inspectWorkflowModelFailure(
      new AiSdkModelAdapterError(
        ModelErrorCode.ModelRateLimited,
        "[1308] 您的限额将在 2026-10-15 18:50:42 重置",
        {
          context: {
            reason: "rate_limited",
            retryable: false,
            providerCode: "1308",
            retryAfterMs: 60_000,
          },
        },
      ),
    );
    expect(inspected?.resetAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(inspected?.resetAt).toBeLessThan(before + 120_000);
  });
});
