import { describe, expect, it } from "vitest";
import { truncateMiddleForModel } from "../src/tool/result-persistence-format.js";

const HEAD_CHARS = 5_000;
const TAIL_CHARS = 5_000;
const marker = (count: string) => `\n\n... [${count} characters truncated] ...\n\n`;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("truncateMiddleForModel", () => {
  it("keeps text within the limit plus slack unchanged", () => {
    const text = "x".repeat(10_000 + 1_024);
    expect(truncateMiddleForModel(text)).toBe(text);
  });

  it("adds the recorded counts of nested truncation markers to the new count", () => {
    const head = "h".repeat(HEAD_CHARS);
    const tail = "t".repeat(TAIL_CHARS);
    const first = marker("300");
    const second = marker("4500");
    const text = `${head}${"m".repeat(1_000)}${first}${"m".repeat(500)}${second}${"m".repeat(500)}${tail}`;

    // 被截掉的中段里已有两条截断说明：数字按它们记录的原字符数累计，反映原文长度。
    const removed = text.length - HEAD_CHARS - TAIL_CHARS;
    const expected = removed - first.length - second.length + 300 + 4_500;
    expect(truncateMiddleForModel(text)).toBe(
      `${head}\n\n... [${expected} characters truncated] ...\n\n${tail}`,
    );
  });

  it("does not trust markers whose count is too long or shorter than the marker itself", () => {
    const head = "h".repeat(HEAD_CHARS);
    const tail = "t".repeat(TAIL_CHARS);
    // 16 位数字超出可信范围；5 小于说明本身的长度，都按普通文本计数。
    const text = `${head}${"m".repeat(1_000)}${marker("1234567890123456")}${marker("5")}${"m".repeat(1_000)}${tail}`;

    const removed = text.length - HEAD_CHARS - TAIL_CHARS;
    expect(truncateMiddleForModel(text)).toBe(
      `${head}\n\n... [${removed} characters truncated] ...\n\n${tail}`,
    );
  });

  it("drops half surrogate pairs at both cut points", () => {
    // 头部切点落在 😀 中间，尾部切点落在 🎉 中间：两个半字符都丢弃，不产生孤立代理。
    const head = `${"h".repeat(HEAD_CHARS - 1)}😀`;
    const tail = `🎉${"t".repeat(TAIL_CHARS - 1)}`;
    const text = `${head}${"m".repeat(2_000)}${tail}`;

    const result = truncateMiddleForModel(text);

    expect(LONE_SURROGATE.test(result)).toBe(false);
    expect(result.startsWith(`${"h".repeat(HEAD_CHARS - 1)}\n\n... [`)).toBe(true);
    expect(result.endsWith(`] ...\n\n${"t".repeat(TAIL_CHARS - 1)}`)).toBe(true);
    const removed = text.length - (HEAD_CHARS - 1) - (TAIL_CHARS - 1);
    expect(result).toContain(`[${removed} characters truncated]`);
  });
});
