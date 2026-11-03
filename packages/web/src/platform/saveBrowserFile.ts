import type { SaveFileRequest, SaveFileResult } from "@zcode/shared";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_URL_RETENTION_MS = 40_000;

async function readDownloadBytes(url: string): Promise<ArrayBuffer> {
  const parsed = new URL(url, window.location.href);
  if (!["https:", "http:", "data:", "blob:"].includes(parsed.protocol))
    throw new Error("download_failed");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(parsed.href, { signal: controller.signal });
    if (!response.ok) throw new Error("download_failed");
    if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES)
      throw new Error("file_too_large");
    if (!response.body) {
      const data = await response.arrayBuffer();
      if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("file_too_large");
      return data;
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error("file_too_large");
      chunks.push(next.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data.buffer;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

export async function saveBrowserFile(payload: SaveFileRequest): Promise<SaveFileResult> {
  let objectUrl: string | undefined;
  let anchor: HTMLAnchorElement | undefined;
  let dispatched = false;
  try {
    const data = payload.data ?? (await readDownloadBytes(payload.sourceUrl));
    if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("file_too_large");
    // 文件名来自上游产物；去掉路径和平台非法字符，避免浏览器把它当作目标目录。
    const leafName = payload.suggestedName.split(/[\\/]/).pop() || "download";
    const filename =
      Array.from(leafName, (character) =>
        character.charCodeAt(0) < 32 || '<>:"|?*'.includes(character) ? "_" : character,
      )
        .join("")
        .trim() || "download";
    objectUrl = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    dispatched = true;
    // 浏览器下载没有可靠的落盘回执；success 只表示已将字节交给下载器。
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error && error.message === "file_too_large"
          ? "file_too_large"
          : "save_failed",
    };
  } finally {
    anchor?.remove();
    if (objectUrl) {
      const completedUrl = objectUrl;
      // Safari 可能在 click 后等待下载确认，下一轮任务就回收会让下载链接提前失效。
      // 下载没有完成回执，保留一段有界时间供浏览器消费；派发失败则立即释放。
      if (dispatched)
        setTimeout(() => URL.revokeObjectURL(completedUrl), DOWNLOAD_URL_RETENTION_MS);
      else URL.revokeObjectURL(completedUrl);
    }
  }
}
