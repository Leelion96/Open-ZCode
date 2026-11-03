"use client";

import { ArrowLeftIcon, ArrowRightIcon, DownloadIcon, XIcon } from "lucide-react";
import type { IPlatformService } from "@zcode/shared";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ImagePreviewSurface } from "@/image-preview-editor/index.js";

export interface ImagePreviewDialogItem {
  alt: string;
  error?: boolean;
  filename?: string;
  loading?: boolean;
  mediaType?: string;
  src?: string;
}

interface PreviewOffset {
  x: number;
  y: number;
}

interface PreviewSize {
  height: number;
  width: number;
}

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const imageExtensionByMediaType: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function imageDownloadFilename(item: ImagePreviewDialogItem, mediaType = item.mediaType ?? "") {
  const knownExtension = imageExtensionByMediaType[mediaType.toLowerCase().split(";")[0] ?? ""];
  let sourcePath: string | undefined;
  if (item.src && isHttpSource(item.src)) sourcePath = new URL(item.src).pathname;
  const supportedExtensions = new Set([...Object.values(imageExtensionByMediaType), "jpeg"]);
  const sourceExtension = [item.filename, sourcePath, item.alt]
    .map((name) => /\.([a-z0-9]+)$/iu.exec(name?.trim() ?? "")?.[1]?.toLowerCase())
    .find((extension) => extension !== undefined && supportedExtensions.has(extension));
  // 原字节不能统一命名成 PNG；未知 MIME 保留可信图片后缀，已知 MIME 拒绝不相容的后缀。
  const compatible =
    !knownExtension || (sourceExtension === "jpeg" ? "jpg" : sourceExtension) === knownExtension;
  const extension = (compatible ? sourceExtension : undefined) ?? knownExtension ?? "bin";
  return `${safeDownloadBaseName(item)}.${extension}`;
}

export function clampImagePreviewOffset(
  offset: PreviewOffset,
  scale: number,
  imageSize: PreviewSize,
  viewportSize: PreviewSize,
): PreviewOffset {
  const maxX = Math.max(0, (imageSize.width * scale - viewportSize.width) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - viewportSize.height) / 2);
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, offset.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

function safeDownloadBaseName(item: ImagePreviewDialogItem) {
  return (
    (item.filename || item.alt)
      .trim()
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
      .slice(0, 80) || "image"
  );
}

class ImageDownloadError extends Error {
  constructor(readonly code: "download_failed" | "file_too_large") {
    super(code);
  }
}

function isHttpSource(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function sanitizeImageSourceForLog(source: string) {
  if (source.startsWith("data:")) return "data-url";
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

async function readBoundedImageBlob(source: string) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok || !response.body) throw new ImageDownloadError("download_failed");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new ImageDownloadError("file_too_large");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        // Web 下载也必须在读取过程中截断，不能等 response.blob() 完整占用 renderer 内存。
        controller.abort();
        throw new ImageDownloadError("file_too_large");
      }
      chunks.push(value);
    }
    if (receivedBytes === 0) throw new ImageDownloadError("download_failed");
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([bytes.buffer], {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

function startBrowserNativeDownload(source: string) {
  const link = document.createElement("a");
  link.href = source;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function downloadImagePreview(
  item: ImagePreviewDialogItem,
  saveFile?: IPlatformService["saveFile"],
): Promise<{ kind: "saved"; path: string } | { kind: "started" } | { kind: "canceled" }> {
  if (!item.src) throw new ImageDownloadError("download_failed");
  if (saveFile && isHttpSource(item.src)) {
    const result = await saveFile({
      sourceUrl: item.src,
      suggestedName: imageDownloadFilename(item),
    });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success || !result.path) throw new Error(result.error || "save_failed");
    return { kind: "saved", path: result.path };
  }
  let blob: Blob;
  try {
    blob = await readBoundedImageBlob(item.src);
  } catch (error) {
    if (
      !saveFile &&
      isHttpSource(item.src) &&
      !(error instanceof ImageDownloadError && error.code === "file_too_large")
    ) {
      startBrowserNativeDownload(item.src);
      return { kind: "started" };
    }
    throw error;
  }
  const filename = imageDownloadFilename(item, blob.type);
  if (saveFile) {
    const result = await saveFile({ data: await blob.arrayBuffer(), suggestedName: filename });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success || !result.path) throw new Error(result.error || "save_failed");
    return { kind: "saved", path: result.path };
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  return { kind: "started" };
}

export function ImagePreviewDialog({
  dialogTestId,
  imageTestId,
  initialIndex,
  items,
  onActiveIndexChange,
  onOpenChange,
  open,
}: {
  dialogTestId?: string;
  imageTestId?: string;
  initialIndex: number;
  items: readonly ImagePreviewDialogItem[];
  onActiveIndexChange?: (index: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [isDownloading, setIsDownloading] = useState(false);
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const activeItem = items[activeIndex];
  const activeItemIsVideo = activeItem?.mediaType?.startsWith("video/") === true;
  const hasMultiple = items.length > 1;

  const navigate = (direction: -1 | 1) => {
    if (items.length <= 1) return;
    const next = (activeIndex + direction + items.length) % items.length;
    setActiveIndex(next);
    onActiveIndexChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0)));
  }, [initialIndex, items.length, open]);

  useEffect(() => {
    setVideoState("loading");
  }, [activeIndex, activeItem?.src, open]);

  useEffect(() => {
    return () => {
      // 媒体 gallery 切离 video 时旧播放器可能继续解码或发声；显式暂停，
      // 让图片/视频混合导航只保留当前项的播放生命周期。
      previewVideoRef.current?.pause();
    };
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,[contenteditable=true]"))
      )
        return;
      if (event.key === "ArrowLeft") navigate(-1);
      else if (event.key === "ArrowRight") navigate(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, items.length, open]);

  const downloadActiveImage = async () => {
    if (!activeItem?.src || activeItemIsVideo || isDownloading) return;
    setIsDownloading(true);
    try {
      const result = await downloadImagePreview(activeItem, platform?.saveFile);
      if (result.kind === "saved") {
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }));
      } else if (result.kind === "started") {
        toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
      }
    } catch (error) {
      logger.warn("[ImagePreviewDialog] 图片下载失败", {
        // 签名 URL 的 userinfo/query/fragment 不参与排障，禁止写入持久化日志。
        src: sanitizeImageSourceForLog(activeItem.src),
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "markdownImage.downloadFailed" }));
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        // Radix modal 会禁用 body 指针事件；预览层需显式恢复命中并退出 Electron 拖拽区。
        className="pointer-events-auto h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none place-items-center gap-0 overflow-hidden border-0 bg-transparent p-10 shadow-none [app-region:no-drag] sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] platform-linux-desktop:h-[calc(100dvh-4rem)]"
        onClick={(event) => {
          // 透明内容层覆盖遮罩；只把真实空白点击当关闭，图片与控件不冒充遮罩。
          if (event.target === event.currentTarget) onOpenChange(false);
        }}
        data-testid={dialogTestId}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {activeItem?.alt || intl.formatMessage({ id: "chat.attachments.preview.title" })}
        </DialogTitle>
        <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2 [app-region:no-drag] platform-mac-desktop:top-12 platform-linux-desktop:right-6 platform-linux-desktop:top-4 platform-windows-desktop:right-6 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]">
          {!activeItemIsVideo ? (
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.download" })}
              className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
              disabled={!activeItem?.src || isDownloading}
              onClick={downloadActiveImage}
              size="icon-md"
              variant="ghost"
            >
              <DownloadIcon />
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
              size="icon-md"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </DialogClose>
        </div>
        {hasMultiple ? (
          <>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.previous" })}
              className="pointer-events-auto absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(-1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.next" })}
              // 图片工具栏也位于右侧中线；导航内移一格，避免控件互相遮挡。
              className={cn(
                "pointer-events-auto absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80",
                !activeItemIsVideo && "sm:right-16",
              )}
              onClick={() => navigate(1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowRightIcon />
            </Button>
          </>
        ) : null}
        {activeItem ? (
          activeItemIsVideo ? (
            <div className="flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden">
              {activeItem.src ? (
                videoState === "unsupported" ? (
                  <p
                    className="max-w-xl px-6 text-center text-ui-base text-foreground-subtle"
                    role="alert"
                  >
                    {intl.formatMessage({
                      id: "chat.attachments.preview.videoUnsupported",
                    })}
                  </p>
                ) : (
                  <>
                    {videoState === "loading" ? (
                      <p className="text-ui-base text-foreground-subtle" role="status">
                        {intl.formatMessage({
                          id: "chat.attachments.preview.videoLoading",
                        })}
                      </p>
                    ) : null}
                    {/* 可发送的 video MIME 不保证当前 Chromium 能解码其容器或 codec；
                解码失败只收口当前 gallery item，不能关闭预览或影响相邻媒体。 */}
                    <video
                      controls
                      playsInline
                      className={cn(
                        "max-h-full max-w-full rounded-xl border border-border bg-background shadow-2xl",
                        videoState === "loading" && "invisible absolute",
                      )}
                      onError={() => setVideoState("unsupported")}
                      onLoadedMetadata={() => setVideoState("ready")}
                      ref={previewVideoRef}
                      src={activeItem.src}
                    />
                  </>
                )
              ) : activeItem.error ? (
                <p className="px-6 text-center text-ui-base text-destructive" role="alert">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoUnavailable",
                  })}
                </p>
              ) : activeItem.loading ? (
                <p className="text-ui-base text-foreground-subtle" role="status">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoLoading",
                  })}
                </p>
              ) : null}
            </div>
          ) : activeItem.src && open ? (
            <ImagePreviewSurface
              key={`${activeIndex}:${activeItem.src}`}
              src={activeItem.src}
              alt={activeItem.alt}
              filename={activeItem.filename}
              imageTestId={imageTestId}
              onClose={() => onOpenChange(false)}
              onSaved={() => onOpenChange(false)}
            />
          ) : null
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
