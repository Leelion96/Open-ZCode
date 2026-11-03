import {
  CoreErrorType,
  READ_MAX_FILE_SIZE_BYTES,
  READ_MAX_OUTPUT_TOKENS,
  createCoreError,
  dropTrailingHighSurrogate,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type ReadTextOutput,
  type TraceContext,
} from "@zcode/contracts";

import { estimateTokens } from "../../context/utils.js";
import type { ToolBatchNotice } from "../types.js";

/** 同视图、文件未变时 Read 的模型可见结果。 */
export const READ_FILE_UNCHANGED_STUB =
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";
/** 整文件读取超过 token 上限、部分视图也放不下时的错误码（`CoreError.context.code`）。 */
export const READ_OUTPUT_TOO_MANY_TOKENS_CODE = "read_output_too_many_tokens";
const EMPTY_FILE_REMINDER = formatReadToolResultWarning(
  "Warning: the file exists but the contents are empty.",
);
const READ_PARTIAL_VIEW_FIT_RATIO = 0.85;
const READ_PARTIAL_VIEW_SHRINK_RATIO = 0.7;
const READ_PARTIAL_VIEW_SHRINK_STEPS = 6;
const READ_TRUNCATION_BANNER_PREFIX = "[Truncated: PARTIAL view \u2014 ";
const READ_TOOL_NAME = "Read";
const SEARCH_TOOL_NAME = "Grep";

export interface ReadTextFileForModelOptions {
  abortSignal?: AbortSignal;
  allowPartialFallback?: boolean;
  filePath: string;
  fileSystemPort: FileSystemPort;
  limit?: number;
  onRead?: (read: FileSystemReadTextRangeResult) => void;
  offset?: number;
  trace?: TraceContext;
}

export async function readTextFileForModel({
  abortSignal,
  allowPartialFallback,
  filePath,
  fileSystemPort,
  limit,
  onRead,
  offset,
  trace,
}: ReadTextFileForModelOptions): Promise<ReadTextOutput> {
  const limitProvided = limit !== undefined;
  const read = await fileSystemPort.readTextFileRange(
    {
      path: filePath,
      offsetLine: toRangeOffsetLine(offset),
      limitLines: limit,
      maxBytes: limitProvided ? undefined : READ_MAX_FILE_SIZE_BYTES,
      trace,
    },
    { signal: abortSignal },
  );
  onRead?.(read);

  return readTextRangeResultToOutput({
    allowPartialFallback: allowPartialFallback ?? isInitialWholeFileRead(offset, limit),
    filePath,
    offset,
    read,
  });
}

/** Read 工具结果里的部分视图提示；tool_result 本身不含它，由工具批次之后的附件发送。 */
export function formatReadBatchNotice(output: unknown): ToolBatchNotice | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const record = output as { type?: unknown; partialViewNotice?: unknown };
  return record.type === "text" && typeof record.partialViewNotice === "string"
    ? { source: "read_truncation_notice", content: record.partialViewNotice }
    : undefined;
}

export function formatReadTextOutput(output: ReadTextOutput): string {
  const partialViewPrefix = output.partialViewNotice
    ? `${formatReadToolResultWarning(output.partialViewNotice)}\n\n`
    : "";

  // 修复原因：只有 totalLines 为 0 才算空文件时，空文件读取结果被规范成 1 行，
  // 空文件和按 offset 读到的空行都被说成 offset 太大。
  if (!output.content) {
    if (output.numLines >= 1 && output.totalLines > 1) {
      return `${partialViewPrefix}${addReadLineNumbers({ content: "", startLine: output.startLine })}`;
    }
    const warning =
      output.numLines >= 1 || output.totalLines === 0
        ? EMPTY_FILE_REMINDER
        : formatReadToolResultWarning(
            `Warning: the file exists but is shorter than the provided offset (${output.startLine}). The file has ${output.totalLines} lines.`,
          );
    return `${partialViewPrefix}${warning}`;
  }

  // 成功文本结果的模型可见契约只包含条件提醒与带行号正文；
  // 历史安全提醒不属于当前 tool result 路径。
  return `${partialViewPrefix}${addReadLineNumbers({
    content: output.content,
    startLine: output.startLine,
  })}`;
}

export function addReadLineNumbers({
  content,
  startLine,
}: {
  content: string;
  startLine: number;
}): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join("\n");
}

function formatReadToolResultWarning(body: string): string {
  return `<system-reminder>${body}</system-reminder>`;
}

function toRangeOffsetLine(offset: number | undefined): number {
  if (offset === undefined || offset <= 1) return 0;
  return offset - 1;
}

function isInitialWholeFileRead(offset: number | undefined, limit: number | undefined): boolean {
  return (offset === undefined || offset <= 1) && limit === undefined;
}

function readTextRangeResultToOutput({
  allowPartialFallback,
  filePath,
  offset,
  read,
}: {
  allowPartialFallback: boolean;
  filePath: string;
  offset?: number;
  read: FileSystemReadTextRangeResult;
}): ReadTextOutput {
  const tokenCount = estimateTokens(read.content);
  if (tokenCount > READ_MAX_OUTPUT_TOKENS) {
    if (!allowPartialFallback) {
      throwReadOutputTokenBudgetError(tokenCount, filePath);
    }
    const fallback = createTokenCapPartialView(read, tokenCount, filePath);
    if (fallback) return { filePath, type: "text", ...fallback };
    throwReadOutputTokenBudgetError(tokenCount, filePath);
  }

  return normalizeReadTextOutput({
    type: "text",
    filePath,
    content: read.content,
    numLines: read.lineCount,
    startLine: offset === 0 ? 0 : read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: read.truncated,
  });
}

function normalizeReadTextOutput(output: ReadTextOutput): ReadTextOutput {
  if (
    output.content.length === 0 &&
    output.numLines === 0 &&
    output.startLine === 1 &&
    output.totalLines === 0
  ) {
    return {
      ...output,
      numLines: 1,
      totalLines: 1,
    };
  }
  return output;
}

// 部分视图：按 行数 × 上限 / 全文 token × 0.85 估算保留行数，超出时按 0.7 逐步缩小；
// 按行缩小用完仍放不下（单行过长或前段很密）时改按字符截取。提示不进 tool_result，由工具批次之后的附件发送。
function createTokenCapPartialView(
  read: FileSystemReadTextRangeResult,
  tokenCount: number,
  filePath: string,
): Omit<ReadTextOutput, "filePath" | "type"> | undefined {
  const content = read.content;
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return undefined;

  const charsPerToken = Math.max(0.5, content.length / tokenCount);
  // 平均密度只用于估算初始长度；是否放得进上限与整文件判定用同一估算。
  // 按平均密度判定时，前段比全文更密（例如前段中文多）的部分视图会超过上限。
  const fits = (text: string) => estimateTokens(text) <= READ_MAX_OUTPUT_TOKENS;
  let lineCount = Math.max(
    1,
    Math.min(
      lines.length,
      Math.floor(
        ((lines.length * READ_MAX_OUTPUT_TOKENS) / tokenCount) * READ_PARTIAL_VIEW_FIT_RATIO,
      ),
    ),
  );
  let view = lines.slice(0, lineCount).join("\n");
  for (let step = 0; step < READ_PARTIAL_VIEW_SHRINK_STEPS; step++) {
    if (fits(view) || lineCount <= 1) break;
    lineCount = Math.max(1, Math.floor(lineCount * READ_PARTIAL_VIEW_SHRINK_RATIO));
    view = lines.slice(0, lineCount).join("\n");
  }

  let byCharacters = false;
  if (!fits(view) || view.trim() === "") {
    let charCount = Math.max(
      1,
      Math.floor(READ_MAX_OUTPUT_TOKENS * charsPerToken * READ_PARTIAL_VIEW_FIT_RATIO),
    );
    for (let step = 0; step < READ_PARTIAL_VIEW_SHRINK_STEPS; step++) {
      view = content.slice(0, charCount);
      if (fits(view)) break;
      charCount = Math.max(1, Math.floor(charCount * READ_PARTIAL_VIEW_SHRINK_RATIO));
    }
    view = dropTrailingHighSurrogate(view);
    // 缩小次数用完仍放不下时不返回超限视图，由调用方按 token 超限报错。
    if (!fits(view)) return undefined;
    byCharacters = true;
  }

  const shownLines = byCharacters ? view.split("\n").length : lineCount;
  // 修复原因：提示固定写 "lines 1-N"，视图不从第 1 行开始时行号和下一页 offset 都错。
  const lastShownLine = read.startLine + shownLines - 1;
  const tokens = `${tokenCount} tokens, cap ${READ_MAX_OUTPUT_TOKENS}`;
  const partialViewNotice =
    !byCharacters && lastShownLine < read.totalLines
      ? `${READ_TRUNCATION_BANNER_PREFIX}${filePath}: showing lines ${read.startLine}-${lastShownLine} of ${read.totalLines} total (${tokens}). Call ${READ_TOOL_NAME} with offset=${lastShownLine + 1} limit=${shownLines} for the next page, or ${SEARCH_TOOL_NAME} to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]`
      : `${READ_TRUNCATION_BANNER_PREFIX}${filePath}: showing the first ${view.length} of ${content.length} characters (${tokens}); this file has very long lines and cannot be paginated by line. Use ${SEARCH_TOOL_NAME} to find a specific section, or ${READ_TOOL_NAME} with offset/limit to page through it. Do NOT answer from this excerpt alone if the answer may be elsewhere in the file.]`;
  return {
    content: view,
    numLines: shownLines,
    startLine: read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: true,
    truncatedByTokenCap: true,
    partialViewNotice,
  };
}

function throwReadOutputTokenBudgetError(tokenCount: number, filePath: string): never {
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    {
      context: {
        code: READ_OUTPUT_TOO_MANY_TOKENS_CODE,
        filePath,
        maxTokens: READ_MAX_OUTPUT_TOKENS,
        tokenCount,
      },
      recoverable: true,
    },
  );
}
