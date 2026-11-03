/**
 * provider-builtin-tool-compat 标准调用示例：在 SSE transform 里逐帧交给 rewriter，流结束时补发缓冲帧。
 */
import { ProviderBuiltinToolStreamRewriter, type SseFrame } from "./contract.js";

export function exampleRewriteFrames(
  frames: ReadonlyArray<{ frame: SseFrame; parsed: Record<string, unknown> | undefined }>,
): SseFrame[] {
  const rewriter = new ProviderBuiltinToolStreamRewriter();
  const output: SseFrame[] = [];
  for (const { frame, parsed } of frames) output.push(...rewriter.push(frame, parsed));
  output.push(...rewriter.finish());
  return output;
}
