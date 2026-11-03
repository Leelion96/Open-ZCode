import { dropTrailingHighSurrogate } from "@zcode/contracts";
import { Lexer } from "marked";

/** 记忆目录里的索引文件名；上下文前缀注入它，compaction 补回据此排除它。 */
export const MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const MEMORY_INDEX_LINE_LIMIT = 200;
const MEMORY_INDEX_CHARACTER_LIMIT = 25_000;
// 被截掉的第一行的预览上限（含省略号）。
const OMITTED_LINE_PREVIEW_MAX_CHARS = 80;
const OMITTED_LINE_PREVIEW_ELLIPSIS = "…";
const LEADING_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/u;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

export function formatProjectMemoryIndexContent(content: string): string {
  const withoutFrontmatter = content.replace(LEADING_FRONTMATTER_PATTERN, "");
  return formatMemoryIndexContent(stripTopLevelMarkdownHtmlComments(withoutFrontmatter));
}

export function formatMemoryIndexContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const characterCount = trimmed.length;
  const lineTruncated = lineCount > MEMORY_INDEX_LINE_LIMIT;
  const characterTruncated = characterCount > MEMORY_INDEX_CHARACTER_LIMIT;
  if (!lineTruncated && !characterTruncated) return trimmed;

  let truncated = lineTruncated ? lines.slice(0, MEMORY_INDEX_LINE_LIMIT).join("\n") : trimmed;
  if (truncated.length > MEMORY_INDEX_CHARACTER_LIMIT) {
    const finalNewline = truncated.lastIndexOf("\n", MEMORY_INDEX_CHARACTER_LIMIT);
    truncated = truncated.slice(0, finalNewline > 0 ? finalNewline : MEMORY_INDEX_CHARACTER_LIMIT);
  }

  const sizeDescription =
    characterTruncated && !lineTruncated
      ? `${formatBytes(characterCount)} (limit: ${formatBytes(MEMORY_INDEX_CHARACTER_LIMIT)}) — index entries are too long`
      : lineTruncated && !characterTruncated
        ? `${lineCount} lines (limit: ${MEMORY_INDEX_LINE_LIMIT})`
        : `${lineCount} lines and ${formatBytes(characterCount)}`;

  const retainedLines = trimmed[truncated.length] === "\n" ? truncated.split("\n").length : 0;
  const omittedLine = trimmed
    .slice(truncated.length + 1)
    .split("\n", 1)[0]!
    .trim();
  const preview = previewOmittedLine(omittedLine);
  const omittedDescription =
    retainedLines === 0
      ? `everything after the first ${truncated.length} characters of line 1 was cut off`
      : `${lineCount - retainedLines} of ${lineCount} lines were cut off, starting at line ${retainedLines + 1}${preview ? ` ("${preview}")` : ""}`;

  return `${truncated}\n\n> WARNING: MEMORY.md is ${sizeDescription}. Only part of it was loaded: ${omittedDescription}. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

function previewOmittedLine(line: string): string {
  if (line.length <= OMITTED_LINE_PREVIEW_MAX_CHARS) return line;
  // 预览尽量停在词边界；长词或无空格文本也不能截断 UTF-16 代理对。
  // 修复原因：切口正好落在空白上时，若要求空白后还有非空白字符，会退到前一个词，预览少一个词。
  // 这里 `\S*` 可为空，末尾的空白本身就是词边界，最后一个完整的词仍保留。
  const prefix = dropTrailingHighSurrogate(line.slice(0, OMITTED_LINE_PREVIEW_MAX_CHARS - 1));
  const wordBoundary = prefix.search(/\s\S*$/u);
  const words = wordBoundary < 0 ? "" : prefix.slice(0, wordBoundary).trimEnd();
  return `${words.length > OMITTED_LINE_PREVIEW_MAX_CHARS / 2 ? words : prefix.trimEnd()}${OMITTED_LINE_PREVIEW_ELLIPSIS}`;
}

function formatBytes(value: number): string {
  const kilobytes = value / 1024;
  if (kilobytes < 1) return `${value} bytes`;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/u, "")}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(1).replace(/\.0$/u, "")}MB`;
  return `${(megabytes / 1024).toFixed(1).replace(/\.0$/u, "")}GB`;
}

function stripTopLevelMarkdownHtmlComments(content: string): string {
  if (!content.includes("<!--")) return content;

  let result = "";
  for (const token of new Lexer({ gfm: false }).lex(content)) {
    if (token.type === "html") {
      const trimmedToken = token.raw.trimStart();
      if (trimmedToken.startsWith("<!--") && trimmedToken.includes("-->")) {
        const withoutComments = token.raw.replace(HTML_COMMENT_PATTERN, "");
        // 只删除 Markdown lexer 识别到的顶层 HTML comment token；
        // list、blockquote、paragraph 和 code token 内的 comment 必须保持 provider-visible。
        if (withoutComments.trim().length > 0) result += withoutComments;
        continue;
      }
    }
    result += token.raw;
  }
  return result;
}
