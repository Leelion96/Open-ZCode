import { dropLeadingLowSurrogate, dropTrailingHighSurrogate } from "@zcode/contracts";

const PERSISTED_OUTPUT_OPEN_TAG = "<persisted-output>";
const PERSISTED_OUTPUT_CLOSE_TAG = "</persisted-output>";
// Artifact strategy uses resultBudget as the persistence trigger; once persisted, this independent
// preview budget controls the provider-visible <persisted-output> snippet.
const PERSISTED_OUTPUT_PREVIEW_CHARS = 2_000;

export interface PersistedOutputEnvelopeInput {
  content: string;
  formatBytes: (bytes: number) => string;
  originalBytes: number;
  persistedPath: string;
  previewChars: number;
}

export function formatGenericPersistedOutputContent(input: {
  content: string;
  originalBytes: number;
  persistedPath: string;
}): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatDecimalBytes,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
    previewChars: PERSISTED_OUTPUT_PREVIEW_CHARS,
  });
}

/** 紧凑写法：大小按 1024 进位、最多一位小数（如 `11.7KB`），预览前 2000 字符。 */
export function formatCompactPersistedOutputContent(input: {
  content: string;
  originalBytes: number;
  persistedPath: string;
}): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatCompactByteSize,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
    previewChars: PERSISTED_OUTPUT_PREVIEW_CHARS,
  });
}

export function formatPersistedOutputEnvelope(input: PersistedOutputEnvelopeInput): string {
  const preview = previewFirstChars(input.content, input.previewChars);
  return [
    PERSISTED_OUTPUT_OPEN_TAG,
    `Output too large (${input.formatBytes(input.originalBytes)}). Full output saved to: ${input.persistedPath}`,
    "",
    `Preview (first ${input.formatBytes(input.previewChars)}):`,
    preview.preview,
    preview.hasMore ? "..." : undefined,
    PERSISTED_OUTPUT_CLOSE_TAG,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

const MIDDLE_TRUNCATION_MAX_CHARS = 10_000;
const MIDDLE_TRUNCATION_SLACK_CHARS = 1_024;
const MIDDLE_TRUNCATION_MARKER_PATTERN = /\n\n\.\.\. \[(\d+) characters truncated\] \.\.\.\n\n/g;

/**
 * 模型可见的错误文本：不超过上限加余量时原样返回；否则保留头尾各一半，中间换成截断说明。
 * 被截掉的部分里如果已有截断说明，按它记录的原字符数累计，数字反映原文长度。
 */
export function truncateMiddleForModel(text: string): string {
  const maxChars = MIDDLE_TRUNCATION_MAX_CHARS;
  if (text.length <= maxChars + MIDDLE_TRUNCATION_SLACK_CHARS) return text;
  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  const head = dropTrailingHighSurrogate(text.slice(0, headChars));
  const tail = dropLeadingLowSurrogate(text.slice(text.length - tailChars));
  let truncatedChars = text.length - head.length - tail.length;
  for (const match of text
    .slice(headChars, text.length - tailChars)
    .matchAll(MIDDLE_TRUNCATION_MARKER_PATTERN)) {
    const recorded = match[1]!.length <= 15 ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(recorded) && recorded >= match[0].length) {
      truncatedChars += recorded - match[0].length;
    }
  }
  return `${head}\n\n... [${truncatedChars} characters truncated] ...\n\n${tail}`;
}

export function isPersistedOutputContent(content: string): boolean {
  return (
    content.startsWith(PERSISTED_OUTPUT_OPEN_TAG) && content.includes(PERSISTED_OUTPUT_CLOSE_TAG)
  );
}

function previewFirstChars(
  content: string,
  maxChars: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) return { preview: content, hasMore: false };

  const newlineIndex = content.slice(0, maxChars).lastIndexOf("\n");
  const endIndex = newlineIndex > maxChars * 0.5 ? newlineIndex : maxChars;
  return {
    preview: content.slice(0, endIndex),
    hasMore: true,
  };
}

function formatDecimalBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}

function formatCompactByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  if (kb < 1024) return `${trimSingleDecimal(kb)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${trimSingleDecimal(mb)}MB`;
  return `${trimSingleDecimal(mb / 1024)}GB`;
}

function trimSingleDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
