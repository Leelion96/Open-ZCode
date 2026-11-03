// ============================================================
// 故障矩阵 · Stop 集行（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md：B10–B13）
// ============================================================
// 这些行的共同预期是 **stopped(provider)**：确定性的模型侧错误让 run 像 cancel 一样停下、
// 兄弟子代理立即被 abort、结算带齐 `providerStop` 载荷（通知文案是它的纯函数）。
// 与 terminal-states 策略表的对应：auth / quota / model_unavailable / invalid_request。

import type { ModelNetworkStatusEvent } from "@zcode/contracts";
import type { FaultProgram, Verdict } from "./helpers/fake-provider-server.js";
import { WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE } from "@zcode/adapters/model";
import { describe, expect, it } from "vitest";
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from "./helpers/fake-provider-server.js";
import {
  AUTH_401,
  INVALID_REQUEST_3001,
  MODEL_NOT_FOUND_3006,
  QUOTA_1308,
  SERVE,
  UNKNOWN_1314,
  always,
  type StatusVerdict,
} from "./helpers/fault-programs.js";
import {
  FAULT_CELL_DEFAULT_CONCURRENCY,
  assertCommonInvariants,
  pause,
  runFaultCell,
  type FaultCellObservation,
} from "./helpers/fault-matrix.js";
import {
  CELL_TIMEOUT_MS,
  POST_SETTLE_GRACE_MS,
  cellName,
  cells,
  type CellCoordinate,
} from "./helpers/fault-matrix-cells.js";
import { FAULT_MODEL_ID, FAULT_PROVIDER_ID } from "./helpers/fault-provider-model.js";

/** 从第一条 Stop 集应答到 run 结算的上限：兄弟 abort 必须是立即的，不是等退避。 */
const STOP_LATENCY_MS = 2_000;

interface StopRow {
  id: string;
  title: string;
  verdict: StatusVerdict;
  kind: "auth" | "quota" | "model_unavailable" | "invalid_request";
  quick: CellCoordinate[];
  fullOnly: CellCoordinate[];
}

const STOP_ROWS: StopRow[] = [
  {
    id: "B10",
    title: "认证失效 401/1006",
    verdict: AUTH_401,
    kind: "auth",
    quick: [{ shape: "W4" }, { shape: "W4", apiFormat: "openai-chat-completions" }],
    fullOnly: [{ shape: "W16" }],
  },
  {
    id: "B11",
    title: "五小时用量上限 429/1308（带 Retry-After）",
    verdict: QUOTA_1308,
    kind: "quota",
    quick: [{ shape: "W4" }],
    fullOnly: [],
  },
  {
    id: "B12",
    title: "模型不在套餐里 404/3006",
    verdict: MODEL_NOT_FOUND_3006,
    kind: "model_unavailable",
    quick: [{ shape: "W4" }],
    fullOnly: [],
  },
  {
    id: "B13",
    title: "请求不合法 400/3001",
    verdict: INVALID_REQUEST_3001,
    kind: "invalid_request",
    quick: [{ shape: "W4" }],
    fullOnly: [],
  },
];

async function runCell(
  server: FakeProviderServer,
  cell: CellCoordinate,
): Promise<FaultCellObservation> {
  const observation = await runFaultCell({
    server,
    shape: cell.shape,
    apiFormat: cell.apiFormat ?? "anthropic-messages",
  });
  await pause(POST_SETTLE_GRACE_MS);
  return observation;
}

for (const row of STOP_ROWS) {
  describe(`fault matrix · ${row.id} always(${row.verdict.status}/${row.verdict.code}) — ${row.title}`, () => {
    it.each(cells(row.quick, row.fullOnly).map((cell) => [cellName(cell), cell] as const))(
      "%s：stopped(provider)，providerStop 载荷齐全，兄弟立即被 abort，停下后零请求",
      async (_name, cell) => {
        const server = await startFakeProviderServer({ program: always(row.verdict) });
        try {
          const obs = await runCell(server, cell);
          assertCommonInvariants(obs, { status: "stopped", stopReason: "provider", server });

          // 结算载荷：ProviderStop + 通知文案需要的每个字段。
          expect(obs.settlement.status).toBe("stopped");
          if (obs.settlement.status !== "stopped") return;
          expect(obs.settlement.error?.code).toBe("ProviderStop");
          const details = obs.settlement.error?.providerStop;
          expect(details?.kind).toBe(row.kind);
          expect(details?.providerId).toBe(FAULT_PROVIDER_ID);
          expect(details?.modelId).toBe(FAULT_MODEL_ID);
          expect(details?.providerCode).toBe(row.verdict.code);
          expect(details?.subagent).toMatch(/^actor#/u);
          expect(details?.subagentName).toBeTruthy();
          expect(details?.rawMessage).toContain(row.verdict.message);
          if (row.kind === "quota") {
            // Retry-After: 120 → resetAt ≈ 第一条 429 的到达时刻 + 120 s。
            const firstAt = server.requests[0]?.at ?? 0;
            expect(details!.resetAt! - firstAt).toBeGreaterThanOrEqual(110_000);
            expect(details!.resetAt! - firstAt).toBeLessThanOrEqual(130_000);
          } else {
            expect(details?.resetAt).toBeUndefined();
          }

          // journal 与事件流说同一件事。
          const run = obs.journal.getRun(obs.runId);
          expect(run?.status).toBe("stopped");
          expect(run?.stopReason).toBe("provider");
          expect(run?.failure?.code).toBe("ProviderStop");
          const settled = obs.events.filter((event) => event.type === "run-settled");
          expect(settled).toHaveLength(1);
          expect(settled[0]).toMatchObject({ status: "stopped", stopReason: "provider" });

          // 兄弟立即被 abort：Stop 集应答数 ≤ 当时的在飞上界（同时到达的那一批），
          // 而不是每个子代理各撞一次；从第一条到结算 ≤ STOP_LATENCY_MS。
          const stopResponses = server.requests.filter(
            (entry) => entry.verdict.kind === "status" && entry.servedStatus === row.verdict.status,
          );
          expect(stopResponses.length).toBeGreaterThan(0);
          expect(stopResponses.length).toBeLessThanOrEqual(FAULT_CELL_DEFAULT_CONCURRENCY);
          expect(obs.settledAt - stopResponses[0]!.at).toBeLessThanOrEqual(STOP_LATENCY_MS);
          // 没有一个逻辑请求成功过：Stop 集在第一次请求就停下。
          expect(server.requests.every((entry) => entry.verdict.kind === "status")).toBe(true);
          // 每条 Stop 集应答都作为不可重试失败报出，且没有 retry_scheduled；被 abort 的兄弟
          // 报 `reason:"cancelled"`（取消的回声，不带业务码）。
          const failed = obs.statusEvents.filter(
            (event): event is Extract<ModelNetworkStatusEvent, { type: "model_request_failed" }> =>
              event.type === "model_request_failed",
          );
          // 同一批在飞的兄弟可能已经拿到 Stop 集应答却在 abort 之后才被 runner 看到，那时它
          // 报的是 cancelled——所以带业务码的失败数 ≥ 1 且 ≤ Stop 集应答数，不必相等。
          const providerFailed = failed.filter((event) => event.reason !== "cancelled");
          expect(providerFailed.length).toBeGreaterThan(0);
          expect(providerFailed.length).toBeLessThanOrEqual(stopResponses.length);
          expect(failed.every((event) => event.retryable === false)).toBe(true);
          expect(
            providerFailed.every((event) => event.providerErrorCode === row.verdict.code),
          ).toBe(true);
          expect(obs.statusEvents.some((event) => event.type === "model_retry_scheduled")).toBe(
            false,
          );
          expect(obs.governor.snapshot(obs.key)?.inFlight ?? 0).toBe(0);
          // Stop 集不是并发信号：桶既不降 cap 也不冷却，resume（额度恢复后）同一模型立即准入，
          // 而不是在闸门上静默等到 Retry-After 指的额度窗口结束。
          const snapshot = obs.governor.snapshot(obs.key);
          expect(snapshot?.cooldownUntil).toBeUndefined();
          expect(snapshot?.cap).toBe(snapshot?.initial);
          const resumed = obs.governor.tryAdmit("resumed-run", obs.key);
          expect(resumed).toBeDefined();
          resumed?.release();
        } finally {
          await server.close();
        }
      },
      CELL_TIMEOUT_MS,
    );
  });
}

// B14b（2026-10-19）：分类器不认识的业务码一直失败。原先无限重试（决策 10），一个确定性的服务端
// 拒绝（2026-10-16 的 1113）让 run 永远挂着；现在同一次请求里它连续出现到第 N 次时停下，kind other，
// 可 Resume。B14（失败若干次后成功）不受影响：那里每个请求都没连续到 N 次。
describe(`fault matrix · B14b always(${UNKNOWN_1314.status}/${UNKNOWN_1314.code}) — 未知业务码连续失败到上限即停`, () => {
  it(
    "W4：在内重试到上限后 stopped(provider)，kind other，带业务码与原文",
    async () => {
      const server = await startFakeProviderServer({ program: always(UNKNOWN_1314) });
      try {
        const obs = await runCell(server, { shape: "W4" });
        assertCommonInvariants(obs, { status: "stopped", stopReason: "provider", server });

        expect(obs.settlement.status).toBe("stopped");
        if (obs.settlement.status !== "stopped") return;
        expect(obs.settlement.error?.code).toBe("ProviderStop");
        const details = obs.settlement.error?.providerStop;
        expect(details?.kind).toBe("other");
        expect(details?.providerCode).toBe(UNKNOWN_1314.code);
        expect(details?.rawMessage).toContain(UNKNOWN_1314.message);
        expect(details?.resetAt).toBeUndefined();

        // 先在内重试：至少有一个请求被试满上限次，期间排过重试。
        expect(server.requests.length).toBeGreaterThanOrEqual(
          WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE,
        );
        expect(statusCountOf(obs, "model_retry_scheduled")).toBeGreaterThanOrEqual(
          WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE - 1,
        );
        // 停下的那一次报成不可重试失败，且带着这个业务码。
        const finalFailures = obs.statusEvents.filter(
          (event): event is Extract<ModelNetworkStatusEvent, { type: "model_request_failed" }> =>
            event.type === "model_request_failed" &&
            event.retryable === false &&
            event.reason !== "cancelled",
        );
        expect(finalFailures.length).toBeGreaterThan(0);
        expect(finalFailures.every((event) => event.providerErrorCode === UNKNOWN_1314.code)).toBe(
          true,
        );
        expect(obs.journal.getRun(obs.runId)?.stopReason).toBe("provider");
      } finally {
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// B14c / B14d（MR !3072 评审 CR-02）：数的是**连续**出现的未知业务码，不是尝试次数。网络错误夹在
// 中间就从零重数，所以下面两种混合序列都不该停，run 照常完成。W1 只有一个子代理，到达序号即第一个
// 请求的尝试序号。
const RESET: Verdict = { kind: "reset" };
const MIXED_ROWS: { id: string; title: string; program: FaultProgram; unknownCount: number }[] = [
  {
    id: "B14c",
    title: "9 次网络错误后一次未知业务码",
    program: ({ ordinal }) =>
      ordinal < WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE
        ? RESET
        : ordinal === WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE
          ? UNKNOWN_1314
          : SERVE,
    unknownCount: 1,
  },
  {
    id: "B14d",
    title: "未知业务码与网络错误交替",
    program: ({ ordinal }) =>
      ordinal > 2 * WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE
        ? SERVE
        : ordinal % 2 === 1
          ? UNKNOWN_1314
          : RESET,
    unknownCount: WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE,
  },
];

for (const row of MIXED_ROWS) {
  describe(`fault matrix · ${row.id} ${row.title} — 未知业务码不连续，不停`, () => {
    it(
      "W1：在内重试后 completed",
      async () => {
        const server = await startFakeProviderServer({ program: row.program });
        try {
          const obs = await runCell(server, { shape: "W1" });
          assertCommonInvariants(obs, { status: "completed", server });
          const unknown = server.requests.filter(
            (entry) => entry.verdict.kind === "status" && entry.verdict.code === UNKNOWN_1314.code,
          );
          expect(unknown).toHaveLength(row.unknownCount);
          // 第一个请求至少尝试了 N 次（尝试次数到了上限也不停）。
          expect(server.requests.length).toBeGreaterThan(
            WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE,
          );
        } finally {
          await server.close();
        }
      },
      CELL_TIMEOUT_MS,
    );
  });
}

function statusCountOf(obs: FaultCellObservation, type: ModelNetworkStatusEvent["type"]): number {
  return obs.statusEvents.filter((event) => event.type === type).length;
}
