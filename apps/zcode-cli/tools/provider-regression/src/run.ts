import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runWithModelInvocationContext } from "@zcode/contracts";
import { createConfig } from "@zcode/adapters/config";
import {
  createRuntimeAiSdkModelExecutionConfig,
  createDefaultProviderEndpointRoutingPort,
} from "@zcode/bootstrap";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import type { RegressionOptions, RegressionReport, RegressionRow } from "#contract";
import { loadConfiguration } from "#regression/config";
import { selectCases, REASONING_TASK_ID, REASONING_PROMPT } from "#regression/cases";
import { executeCase, Untested, NeedsReview } from "#regression/execute";
import { redact, renderReport } from "#regression/report";
import { observeUsage, readModelRequestBody, type ObservedUsage } from "#regression/usage";
import { atomicWrite, createResultStore, sanitizeReport } from "#regression/persistence";
import { mapConcurrent } from "#regression/scheduler";

const PARAMETER_FIELDS = [
  "thinking",
  "reasoning",
  "reasoning_effort",
  "output_config",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "enable_thinking",
];
function contains(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) =>
      value === null ? !(key in actual) : contains((actual as Record<string, unknown>)[key], value),
    );
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export async function runRegression(options: RegressionOptions): Promise<RegressionReport> {
  const config = await loadConfiguration(options.providersFile, options.listFile);
  const selected = selectCases(config.list.caseIds);
  const { version: appVersion } = JSON.parse(
    await readFile(new URL("../../../../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const network = createConfig({
    env: process.env,
    workingDirectory: config.fixtureDir,
    skipUserConfig: true,
  }).config.network;
  const endpointRoutingPort = createDefaultProviderEndpointRoutingPort({
    appVersion,
    workingDirectory: config.fixtureDir,
    skipUserConfig: true,
    sourceTitle: "electron",
  });
  const executionConfig = createRuntimeAiSdkModelExecutionConfig(process.env, {
    appVersion,
    network,
    endpointRoutingPort,
    sourceTitle: "electron",
  });
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(":", "-")}-${randomUUID()}`;
  const report: RegressionReport = {
    schemaVersion: 1,
    runId,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    endedAt: null,
    configHash: config.configHash,
    listHash: config.listHash,
    revision: config.revision,
    dryRun: options.dryRun ?? false,
    execution: {
      concurrency: config.list.concurrency,
      targets: config.list.targets.map((target) => ({
        providerId: target.providerId,
        modelIds: config.targets
          .filter((t) => t.provider.providerId === target.providerId)
          .map((t) => t.model.modelId),
        concurrency: {
          models: target.concurrency?.models ?? config.list.concurrency.models,
          cases: target.concurrency?.cases ?? config.list.concurrency.cases,
        },
      })),
    },
    reasoningTask: {
      id: REASONING_TASK_ID,
      prompt: REASONING_PROMPT,
      maxOutputTokens: config.list.maxOutputTokens ?? null,
      timeoutMs: config.list.timeoutMs,
    },
    rows: [],
  };
  const groups = report.execution!.targets.map((target) => ({
    ...target,
    models: config.targets
      .filter((t) => t.provider.providerId === target.providerId)
      .map(({ provider, model }) => ({
        jobs: selected.flatMap((test) => {
          const levels =
            test.kind === "reasoning"
              ? model.config.optionSpecs.reasoningLevel.values
              : [model.config.optionSpecs.reasoningLevel.values.at(test.kind === "web" ? 0 : -1)!];
          const repeats = test.kind === "reasoning" ? config.list.repetitions : 1;
          return Array.from({ length: repeats }, (_, index) =>
            levels.map((level) => {
              const budget = Math.min(
                config.list.maxOutputTokens ?? model.config.optionSpecs.maxOutputTokens.max,
                model.config.optionSpecs.maxOutputTokens.max,
              );
              const row: RegressionRow = {
                providerId: provider.providerId,
                modelId: model.modelId,
                caseId: test.id,
                reasoningLevel: level,
                repetition: index + 1,
                status: "pending",
                detail: "",
                executionPath: [
                  "text",
                  "tool",
                  "context",
                  "image",
                  "video",
                  "pdf",
                  "system",
                ].includes(test.kind)
                  ? "session"
                  : test.kind === "web"
                    ? "websearch-handler"
                    : "adapter-probe",
                requestCount: 0,
                startedAt: null,
                endedAt: null,
                maxOutputTokens:
                  test.kind === "web"
                    ? Math.min(4096, model.config.optionSpecs.maxOutputTokens.max)
                    : test.kind === "output"
                      ? Math.min(1024, budget)
                      : budget,
                reasoningTokens: null,
                reasoningCharacters: null,
                firstTextMs: null,
                durationMs: null,
                finishReason: null,
                answer: "",
                requestParameters: [],
                parameterCheck: "unobserved",
              };
              // 会话预算由产品逐次计算，不能把清单预算伪装成实际生效值。
              if (row.executionPath === "session") delete row.maxOutputTokens;
              report.rows.push(row);
              return { provider, model, test, row, level, repetition: index + 1 };
            }),
          ).flat();
        }),
      })),
  }));
  const store = await createResultStore(
    options.outputDir ?? join(dirname(resolve(options.providersFile)), "reports"),
    runId,
    config.secrets,
  );
  const save = () => {
    report.updatedAt = new Date().toISOString();
    return store.save(report);
  };
  await save();
  options.onProgress?.(`结果文件：${join(store.directory, "report.json")}`);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  type Job = (typeof groups)[number]["models"][number]["jobs"][number];
  async function execute({ provider, model, test, row, level, repetition }: Job) {
    if (abort.signal.aborted) {
      row.status = "untested";
      row.detail = "已取消，未执行";
    } else if (!test.applies(model.config.properties)) {
      row.status = "skipped";
      row.detail = "模型未声明所需能力";
    } else if (config.missingKeys.has(provider.providerId)) {
      row.status = "untested";
      row.detail = "缺 API Key";
    } else if (options.dryRun) {
      row.status = "untested";
      row.detail = "仅预览，未调用供应商";
    } else {
      row.status = "running";
      row.startedAt = new Date().toISOString();
      await save();
      // 保存期间可能收到取消，必须在实际请求前再检查，不能让排队写入后的任务漏出取消边界。
      if (abort.signal.aborted) {
        row.status = "untested";
        row.detail = "已取消，未执行";
      } else {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.list.timeoutMs)]);
        const observed: ObservedUsage[] = [];
        try {
          const maxOutputTokens =
            row.maxOutputTokens ?? model.config.optionSpecs.maxOutputTokens.max;
          const expectedBudget =
            test.kind === "web"
              ? Math.min(4096, model.config.optionSpecs.maxOutputTokens.max)
              : maxOutputTokens;
          const expectedLevel =
            test.kind === "web" ? model.config.optionSpecs.reasoningLevel.values[0] : level;
          const expected = compileModelOptionMaps(
            row.executionPath === "session"
              ? {
                  ...model.config.optionSpecs,
                  maxOutputTokens: { ...model.config.optionSpecs.maxOutputTokens, map: "{}" },
                }
              : model.config.optionSpecs,
          ).apply({}, { reasoningLevel: expectedLevel, maxOutputTokens: expectedBudget });
          const adapter = new AiSdkModelAdapter({
            ...executionConfig,
            // 1 pass 只限制用例重复；保留产品内部重试和空回答恢复。
            modelIoFullRetentionEnabled: false,
            transport: options.transport,
            observeTransport: (transport) => async (url, init) => {
              const body = await readModelRequestBody(url, init);
              if (!body) return transport(url, init);
              row.requestCount = (row.requestCount ?? 0) + 1;
              const matches = contains(body, expected);
              row.parameterCheck =
                !matches || row.parameterCheck === "mismatch" ? "mismatch" : "matched";
              row.requestParameters.push(
                Object.fromEntries(
                  PARAMETER_FIELDS.filter((k) => k in body).map((k) => [k, body[k]]),
                ),
              );
              const usage: ObservedUsage = { reasoningTokens: null };
              observed.push(usage);
              return observeUsage(await transport(url, init), usage);
            },
          });
          const active = adapter.createModel({
            providerId: provider.providerId,
            modelId: model.modelId,
            providerConfig: provider.config,
            modelConfig: model.config,
            options: { reasoningLevel: level, maxOutputTokens },
          });
          options.onProgress?.(
            `${provider.providerId} / ${model.modelId} / ${test.id} / ${level} / ${repetition}`,
          );
          // 专项探针没有 Agent 会话，直接调用曾遗漏会话头；真实会话会建立自己的上下文。
          // 每个实例独立建上下文，沿现有 Adapter 生成请求头，避免并行串会话。
          await runWithModelInvocationContext({ metadata: { sessionId: randomUUID() } }, () =>
            executeCase({
              model: active,
              adapter,
              registry: config.registry,
              test,
              row,
              list: config.list,
              fixtureDir: config.fixtureDir,
              signal,
            }),
          );
          if (signal.aborted) throw signal.reason;
          if (row.parameterCheck !== "matched") throw new Error("最终请求参数未能通过 Map 核验");
          row.status = "passed";
          if (!row.detail) row.detail = "请求与结果满足断言";
        } catch (error) {
          row.status =
            signal.aborted && abort.signal.aborted
              ? "cancelled"
              : error instanceof NeedsReview
                ? "review"
                : error instanceof Untested
                  ? "untested"
                  : "failed";
          row.detail = signal.aborted
            ? abort.signal.aborted
              ? "请求已取消"
              : "请求超时"
            : redact(errorDetails(error), config.secrets).slice(0, 2000);
        }

        // SDK 可能将缺失 usage 补零；只认供应商原始计数，不混用其他并行实例的统计。
        row.reasoningTokens =
          observed.length && observed.every((u) => u.reasoningTokens !== null)
            ? observed.reduce((sum, u) => sum + u.reasoningTokens!, 0)
            : null;
      }
    }
    row.endedAt = new Date().toISOString();
    await save();
  }
  try {
    await mapConcurrent(groups, config.list.concurrency.providers, async (group) => {
      await mapConcurrent(group.models, group.concurrency.models, async (model) => {
        await mapConcurrent(model.jobs, group.concurrency.cases, async (job) => {
          try {
            await execute(job);
          } catch (error) {
            abort.abort();
            throw error;
          }
        });
      });
    });
    report.status = abort.signal.aborted ? "cancelled" : "completed";
    report.endedAt = new Date().toISOString();
    await save();
    const safe = sanitizeReport(report, config.secrets);
    await atomicWrite(join(store.directory, "report.md"), renderReport(safe));
    return safe;
  } catch (error) {
    abort.abort();
    report.status = "error";
    report.endedAt = new Date().toISOString();
    for (const row of report.rows)
      if (row.status === "pending" || row.status === "running") {
        row.status = "untested";
        row.detail = "运行基础设施错误，未完成";
      }
    // 写入失败后队列保持失败态，避免继续发请求；最近成功快照仍可生成部分报告。
    try {
      await save();
    } catch {
      /* 原错误由调用方处理。 */
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}

// 原报告只保留最外层 message，丢失服务端原因；限深度并统一脱敏，避免秘密或循环引用落盘。
function errorDetails(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && messages.length < 4) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join(" → ");
}
