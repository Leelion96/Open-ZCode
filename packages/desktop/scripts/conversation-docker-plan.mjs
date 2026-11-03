export const VERIFIED_DOCKER_TABLE_END_MARKER = "<!-- conversation-session-verified-table-end -->";

export function insertVerifiedDockerSpecRow(text, specRelFromDesktop) {
  const row = `| \`${specRelFromDesktop}\` | verified |`;
  if (text.includes(row) || text.includes(`| \`${specRelFromDesktop}\` |`)) {
    return { inserted: false, text };
  }
  if (!text.includes(VERIFIED_DOCKER_TABLE_END_MARKER)) {
    return {
      error: "Cannot find Docker suite table end marker",
      inserted: false,
      text,
    };
  }

  // 格式化会在表格与结束标记之间留空行；直接替换标记会把新行写成表外文本。
  // 去掉标记前的尾部空白，让新增行紧接表格，并保留文档原有的换行格式。
  const markerIndex = text.indexOf(VERIFIED_DOCKER_TABLE_END_MARKER);
  const tablePrefix = text.slice(0, markerIndex).trimEnd();
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return {
    inserted: true,
    text: `${tablePrefix}${newline}${row}${newline}${text.slice(markerIndex)}`,
  };
}
