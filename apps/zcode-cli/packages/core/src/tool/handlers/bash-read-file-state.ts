import type {
  BashOutput,
  ExecutionResult,
  FileSystemStatResult,
  TraceContext,
} from "@zcode/contracts";
import { relative } from "node:path";
import { resolveWorkspacePath } from "../path-policy.js";
import {
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
  setReadFileStateEntry,
} from "../read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";
import { collectBashReadFileSources, selectReadContent } from "./bash-read-file-sources.js";
import { isBashProviderErrorStatus } from "./bash-semantics.js";

const MAX_BASH_READ_STATE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_STALE_HINT_DISPLAY_PATHS = 5;
const WRITE_COMMAND_MARKERS = new RegExp(
  [
    "--write",
    "--fix",
    "--in-place",
    "--auto-correct",
    "\\brun\\s+format\\b",
    "\\brun\\s+fix\\b",
    "\\b(yarn|pnpm)\\s+format\\b",
    "\\blint:file\\b",
    "\\blint:fix\\b",
    "\\bblack\\b",
    "\\bisort\\b",
    "\\bruff\\s+format\\b",
    "\\bcargo\\s+(fmt|fix)\\b",
    "\\brustfmt\\b",
    "\\bgo\\s+fmt\\b",
    "\\bterraform\\s+fmt\\b",
    "\\bdprint\\s+fmt\\b",
    "\\bswiftformat\\b",
    "\\bphpcbf\\b",
  ].join("|"),
);

interface BashReadFileStateEffectsInput {
  command: string;
  context: ToolExecutionContext;
  output: BashOutput;
  result: ExecutionResult;
}

export async function applyBashReadFileStateEffects(
  input: BashReadFileStateEffectsInput,
): Promise<void> {
  const staleHint = await createStaleReadFileStateHint(input);
  if (staleHint) input.output.staleReadFileStateHint = staleHint;
  await backfillReadFileStateFromBash(input);
}

async function createStaleReadFileStateHint(
  input: BashReadFileStateEffectsInput,
): Promise<string | undefined> {
  if (shouldSkipBashReadFileStateEffects(input.output)) return undefined;
  if (!WRITE_COMMAND_MARKERS.test(input.command)) return undefined;
  const fileSystemPort = input.context.fileSystemPort;
  const readFileState = input.context.readFileState;
  if (!fileSystemPort || !readFileState) return undefined;

  const changedPaths = new Set<string>();
  const trace = createBashReadFileStateTrace(input.context);
  await Promise.all(
    Array.from(readFileState.values(), async (entry) => {
      const entryMtimeMs = normalizeReadFileStateMtimeMs(entry.mtimeMs);
      if (entryMtimeMs === undefined) return;
      try {
        const stat = await fileSystemPort.stat(
          { path: entry.path, trace },
          { signal: input.context.abortSignal },
        );
        const currentMtimeMs = currentStatMtimeMs(stat);
        if (currentMtimeMs === undefined) return;
        if (currentMtimeMs > input.result.startedAt.getTime() && currentMtimeMs > entryMtimeMs) {
          changedPaths.add(entry.path);
        }
      } catch {
        // 无法 stat 的已读文件不阻断 Bash result。
      }
    }),
  );

  const paths = [...changedPaths];
  if (paths.length === 0) return undefined;
  return formatStaleReadFileStateHint(paths, input.context.workingDirectory);
}

async function backfillReadFileStateFromBash(input: BashReadFileStateEffectsInput): Promise<void> {
  if (shouldSkipBashReadFileStateEffects(input.output)) return;
  // Bash cat/head/tail/sed 的 read-state 只能代表模型已经看到的内容；
  // stdout 被截断时回读完整文件会绕过 Edit/Write 的 read-before-write 语义。
  if (input.output.stdoutTruncated === true) return;
  const fileSystemPort = input.context.fileSystemPort;
  const readFileState = input.context.readFileState;
  if (!fileSystemPort || !readFileState) return;

  const sources = collectBashReadFileSources(input.command).filter(
    (source) => !source.requiresExitZero || input.result.exitCode === 0,
  );
  if (sources.length === 0) return;

  const trace = createBashReadFileStateTrace(input.context);
  await Promise.all(
    sources.map(async (source) => {
      const resolvedPath = resolveWorkspacePath({
        inputPath: source.filePath,
        operation: "read",
        workingDirectory: input.context.workingDirectory,
        workspaceRoot: input.context.workspaceRoot,
      });
      if (findLatestReadFileState(readFileState, resolvedPath)) return;

      try {
        const stat = await fileSystemPort.stat(
          { path: resolvedPath, trace },
          { signal: input.context.abortSignal },
        );
        if (stat.kind !== "file") return;
        if (stat.sizeBytes > MAX_BASH_READ_STATE_FILE_BYTES) return;
        if (input.context.abortSignal.aborted) return;

        const read = await fileSystemPort.readTextFile(
          {
            path: resolvedPath,
            maxBytes: MAX_BASH_READ_STATE_FILE_BYTES,
            trace,
          },
          { signal: input.context.abortSignal },
        );
        if (read.truncated) return;
        const selected = selectReadContent(read.content, source);
        if (!selected) return;

        const entry: ReadFileStateEntry = {
          path: resolvedPath,
          content: selected.content,

          // (offset ?? 1) <= 1 && limit === undefined；grep/cat 这类整文件
          // Bash 回填保持 offset undefined，但显式 offset=1 的 Read 也仍算整文件读。
          offset: selected.offset,
          limit: selected.limit,
          isPartialView: false,
          readAt: new Date(),
          revisionId: read.revision?.id ?? stat.revision?.id,
          mtimeMs: normalizeReadFileStateMtimeMs(
            read.revision?.mtimeMs ?? stat.revision?.mtimeMs ?? stat.mtimeMs,
          ),
          sizeBytes: read.revision?.sizeBytes ?? stat.revision?.sizeBytes ?? stat.sizeBytes,
        };
        setReadFileStateEntry(readFileState, entry);
      } catch {
        // Bash 已经返回，read-state 回填失败不能改变 Bash 结果。
      }
    }),
  );
}

function shouldSkipBashReadFileStateEffects(output: BashOutput): boolean {
  // provider 错误应在 stale/backfill 前返回，避免失败结果污染 read-state。
  return (
    output.backgroundTaskId !== undefined ||
    output.isImage === true ||
    output.interrupted === true ||
    isBashProviderErrorStatus(output)
  );
}

function currentStatMtimeMs(stat: FileSystemStatResult): number | undefined {
  return normalizeReadFileStateMtimeMs(stat.revision?.mtimeMs ?? stat.mtimeMs);
}

function formatStaleReadFileStateHint(paths: string[], workingDirectory: string): string {
  const displayPaths = paths
    .slice(0, MAX_STALE_HINT_DISPLAY_PATHS)
    .map((path) => relative(workingDirectory, path) || path);
  const hiddenCount = paths.length - MAX_STALE_HINT_DISPLAY_PATHS;
  const hiddenSuffix = hiddenCount > 0 ? ` and ${hiddenCount} more` : "";
  const fileWord = paths.length === 1 ? "file" : "files";
  return `[This command modified ${paths.length} ${fileWord} you've previously read: ${displayPaths.join(", ")}${hiddenSuffix}. Call Read before editing.]`;
}

function createBashReadFileStateTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
