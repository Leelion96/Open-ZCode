import { createWebPlatform } from "#src/platform/index.js";

export async function saveBrowserFileExample(data: ArrayBuffer) {
  // 此处 success 表示下载已发起，浏览器不提供实际落盘结果。
  return createWebPlatform().saveFile!({ data, suggestedName: "report.pdf" });
}
