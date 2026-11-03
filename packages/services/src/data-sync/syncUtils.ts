/** 数据同步各分类共用的小工具（Node 侧实现内部使用，不经公共入口导出）。 */

/** 错误转为可写入导入结果的说明文字。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** key 排序的 JSON 序列化，作为 JSON 类条目（MCP、钩子）内容哈希的规范化输入。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
