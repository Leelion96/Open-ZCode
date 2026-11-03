import { join } from "node:path";
import { resolveBashMaxOutputLength } from "./bash-output-policy.js";
import { ShellInitSnapshotManager, cleanupStaleShellInitSnapshots } from "./shell-init-snapshot.js";
import { OutputCollector, type AggregatePersistedOutputBudget } from "./output-collector.js";
import {
  DEFAULT_INLINE_OUTPUT_BYTES,
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  DEFAULT_MAX_PERSISTED_OUTPUT_BYTES,
  DEFAULT_PROGRESS_INTERVAL_MS,
  DEFAULT_PROGRESS_TAIL_BYTES,
  DEFAULT_PROGRESS_THRESHOLD_MS,
  isBashMergedOutputRequest,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
} from "./execution-utils.js";
import type {
  ActiveExecutionRecord,
  BackgroundTaskRecord,
  ExecutionOutputPaths,
  NodeExecutionAdapterOptions,
  StopReason,
} from "./execution-adapter-types.js";
import type {
  BackgroundExecutionSnapshot,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
} from "@zcode/contracts";

export class NodeExecutionAdapterBase {
  protected readonly activeExecutions = new Map<string, ActiveExecutionRecord>();

  protected readonly backgroundTasks = new Map<string, BackgroundTaskRecord>();

  protected readonly pendingBashProcessTreeKills = new Map<Promise<void>, { ref(): unknown }>();

  protected readonly shellInitRetentionCleanup: Promise<unknown>;

  protected readonly shellInitSnapshots = new ShellInitSnapshotManager();

  protected readonly outputPathsByRequest = new WeakMap<ExecutionRequest, ExecutionOutputPaths>();

  protected closePromise?: Promise<void>;

  protected readonly options: NodeExecutionAdapterOptions;

  constructor(options: NodeExecutionAdapterOptions = {}) {
    this.options = options;
    const rootDir = options.outputRootDir ?? resolveDefaultOutputRootDir(options.processEnv);
    this.shellInitRetentionCleanup = cleanupStaleShellInitSnapshots({ rootDir }).catch(
      () => undefined,
    );
  }

  protected createOutputCollector(
    request: ExecutionRequest,
    streamName: "stdout" | "stderr",
    legacyOutputEncoding: string | null,
    onPersistedLimit?: () => void,
    aggregatePersistedBudget?: AggregatePersistedOutputBudget,
  ): OutputCollector {
    const persistOutput = request.outputLimit?.persistOutput ?? "none";
    const outputPath = this.outputPathForRequest(request, streamName);
    return new OutputCollector({
      maxInlineBytes: this.inlineLimit(request),
      maxPersistedBytes: this.persistedOutputLimit(request),
      legacyOutputEncoding,
      maxTailBytes: this.progressTailBytes,
      onPersistedLimit,
      outputPath,
      persistOutput,
      aggregatePersistedBudget,
      requestedTailBytes: request.outputLimit?.tailBytes,
    });
  }

  protected outputPathForRequest(
    request: ExecutionRequest,
    streamName: "stdout" | "stderr",
  ): string | undefined {
    const paths = this.outputPathsForRequest(request);
    return streamName === "stdout"
      ? paths.stdoutPersistedOutputPath
      : paths.stderrPersistedOutputPath;
  }

  protected outputPathsForRequest(request: ExecutionRequest): ExecutionOutputPaths {
    const persistOutput = request.outputLimit?.persistOutput ?? "none";
    const usesBashMergedOutput = isBashMergedOutputRequest(request);
    if (persistOutput === "none" && !usesBashMergedOutput) return {};

    const existing = this.outputPathsByRequest.get(request);
    if (existing) return existing;

    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const toolCallId = sanitizePathSegment(
      String(request.trace?.attributes?.toolCallId ?? crypto.randomUUID()),
    );
    const stdoutPersistedOutputPath = join(rootDir, sessionId, `${toolCallId}-stdout.log`);
    if (usesBashMergedOutput) {
      const paths = {
        outputPath: stdoutPersistedOutputPath,
        stdoutPersistedOutputPath,
      };
      this.outputPathsByRequest.set(request, paths);
      return paths;
    }
    const stderrPersistedOutputPath = join(rootDir, sessionId, `${toolCallId}-stderr.log`);
    const paths = {
      outputPath: stdoutPersistedOutputPath,
      stderrPersistedOutputPath,
      stdoutPersistedOutputPath,
    };
    this.outputPathsByRequest.set(request, paths);
    return paths;
  }

  protected inlineLimit(request: ExecutionRequest): number {
    return (
      request.outputLimit?.maxInlineBytes ??
      request.outputLimit?.maxBufferBytes ??
      DEFAULT_INLINE_OUTPUT_BYTES
    );
  }

  protected bashInlineLimit(request: ExecutionRequest): number {
    return resolveBashMaxOutputLength(this.processEnv, this.inlineLimit(request));
  }

  protected persistedOutputLimit(request: ExecutionRequest): number {
    return (
      request.outputLimit?.maxPersistedBytes ??
      this.options.maxPersistedOutputBytes ??
      (isBashMergedOutputRequest(request)
        ? BASH_RUNTIME_OUTPUT_LIMIT_BYTES
        : DEFAULT_MAX_PERSISTED_OUTPUT_BYTES)
    );
  }

  protected createBackgroundTaskRecord(args: {
    controller: AbortController;
    outputPaths: ExecutionOutputPaths;
    startedAt: Date;
    taskId: string;
    request: ExecutionRequest;
  }): BackgroundTaskRecord {
    let resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void = () => undefined;
    const completion = new Promise<BackgroundExecutionSnapshot>((resolve) => {
      resolveCompletion = resolve;
    });
    return {
      completion,
      controller: args.controller,
      resolveCompletion,
      startedAt: args.startedAt,
      status: "running",
      taskId: args.taskId,
      sessionId: args.request.trace?.sessionId,
      isBash: isBashMergedOutputRequest(args.request),
      legacyOutputEncoding: null,
      ...args.outputPaths,
    };
  }

  protected updateBackgroundTaskRecordFromEvent(
    record: BackgroundTaskRecord,
    event: ExecutionEvent,
  ): void {
    if (event.type === "started") {
      record.pid = event.pid;
      return;
    }
    if (event.type !== "progress") return;
    record.pid = event.pid ?? record.pid;
    record.stderrBytes = event.stderrBytes;
    record.stderrTail = event.stderrTail;
    record.stdoutBytes = event.stdoutBytes;
    record.stdoutTail = event.stdoutTail;
  }

  protected finalizeBackgroundTaskRecord(
    record: BackgroundTaskRecord,
    result: ExecutionResult,
  ): void {
    record.status = result.status;
    record.completedAt = result.completedAt;
    record.pid = result.pid ?? record.pid;
    record.result = result;
    record.error = result.error;
    record.resolveCompletion(this.snapshot(record));
  }

  protected snapshot(record: BackgroundTaskRecord): BackgroundExecutionSnapshot {
    return {
      taskId: record.taskId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      pid: record.pid,
      stderrBytes: record.stderrBytes,
      stderrTail: record.stderrTail,
      stdoutBytes: record.stdoutBytes,
      stdoutTail: record.stdoutTail,
      outputPath: record.outputPath,
      stderrPersistedOutputPath: record.stderrPersistedOutputPath,
      stdoutPersistedOutputPath: record.stdoutPersistedOutputPath,
      result: record.result,
      error: record.error,
    };
  }

  protected get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  protected get processEnv(): NodeJS.ProcessEnv {
    return this.options.processEnv ?? process.env;
  }

  protected get progressIntervalMs(): number {
    return Math.max(1, this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  }

  protected get progressTailBytes(): number {
    return Math.max(0, this.options.progressTailBytes ?? DEFAULT_PROGRESS_TAIL_BYTES);
  }

  protected get progressThresholdMs(): number {
    return Math.max(0, this.options.progressThresholdMs ?? DEFAULT_PROGRESS_THRESHOLD_MS);
  }

  protected completeActiveExecution(executionId: string): void {
    const record = this.activeExecutions.get(executionId);
    if (!record) return;
    record.resolveCompletion();
    this.activeExecutions.delete(executionId);
  }

  protected registerActiveExecution(stop: (reason: StopReason) => void): string {
    const executionId = crypto.randomUUID();
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.activeExecutions.set(executionId, {
      completion,
      resolveCompletion,
      stop,
    });
    return executionId;
  }

  async close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return await this.closePromise;
  }

  protected async shutdown(): Promise<void> {
    for (const record of this.backgroundTasks.values()) {
      if (record.status === "running") {
        record.status = "cancelled";
        record.controller.abort();
      }
    }

    const activeExecutions = Array.from(this.activeExecutions.values());
    for (const record of activeExecutions) {
      record.stop("cancelled");
    }

    await Promise.allSettled(activeExecutions.map((record) => record.completion));
    // 直写后没有 pipe 保活，仅 await Promise 会让 Node 在 SIGKILL 前退出。
    // active execution 已结算，所有主动终止均已登记；只在 shutdown 引用既有清理句柄。
    for (const handle of this.pendingBashProcessTreeKills.values()) handle.ref();
    await Promise.allSettled(Array.from(this.pendingBashProcessTreeKills.keys()));
    await this.shellInitRetentionCleanup;
    await this.shellInitSnapshots.cleanup();
  }
}
