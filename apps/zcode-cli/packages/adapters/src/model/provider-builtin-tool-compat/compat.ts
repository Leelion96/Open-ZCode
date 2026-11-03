// Provider 内置工具（GLM 的 analyze_image / webReader 等）的 Anthropic 线协议兼容。
//
// 服务端执行内置工具后，把多轮结果合成一个 assistant message 下发：
//   text(「**🌐 …」markdown) → server_tool_use(未知名) → text(「**Output:** …」markdown) → 裸 tool_result → 下一轮
// AI SDK 只认识固定名单的 server_tool_use，也不接受裸 tool_result，两者都会被丢弃，
// 只剩 markdown 进入正文和下一次请求，模型会照着文字假装调用工具。
// 这里把它们改写成 AI SDK 原生支持的 mcp_tool_use / mcp_tool_result（provider 执行、dynamic），
// 并去掉与结构化块重复的 markdown 渲染；没有配对上的裸 tool_result 仍交给上层丢弃。

/** 改写后 mcp_tool_use 的 server_name；下游据此识别 provider 内置工具。 */
export const PROVIDER_BUILTIN_TOOL_SERVER_NAME = "zcode-provider-builtin";

// @ai-sdk/anthropic 3.0.81 自己能解析的 server_tool_use 名称，保持原样。
const SDK_KNOWN_SERVER_TOOL_NAMES = new Set([
  "web_fetch",
  "web_search",
  "code_execution",
  "text_editor_code_execution",
  "bash_code_execution",
  "tool_search_tool_regex",
  "tool_search_tool_bm25",
  "advisor",
]);

// 服务端渲染副本的前缀：调用头以「**🌐」开头，结果以加粗标签开头。不写厂商名。
const CALL_RENDERING_PREFIX = "**🌐";
const RESULT_RENDERING_PREFIX = "**";

export function isProviderBuiltinServerToolUse(
  block: Record<string, unknown> | undefined,
): boolean {
  return (
    block?.type === "server_tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    !SDK_KNOWN_SERVER_TOOL_NAMES.has(block.name)
  );
}

export function toMcpToolUseBlock(block: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "mcp_tool_use",
    id: block.id,
    name: block.name,
    input: block.input ?? {},
    server_name: PROVIDER_BUILTIN_TOOL_SERVER_NAME,
  };
}

export function toMcpToolResultBlock(block: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "mcp_tool_result",
    tool_use_id: block.tool_use_id,
    is_error: block.is_error === true,
    content: toMcpResultContent(block.content),
  };
}

function toMcpResultContent(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((item) => {
      const record = asRecord(item);
      if (record?.type === "text" && typeof record.text === "string") {
        return { type: "text", text: record.text };
      }
      return { type: "text", text: typeof item === "string" ? item : JSON.stringify(item) };
    });
  }
  return [{ type: "text", text: content === undefined ? "" : JSON.stringify(content) }];
}

// ─── 流式响应 ────────────────────────────────────────────────────────────────

export interface SseFrame {
  frame: string;
  separator: string;
}

interface HeldTextBlock {
  index: number;
  frames: SseFrame[];
  text: string;
  /** call：可能是调用头副本；result：紧跟服务端调用的第一个 text 块，可能是结果副本。 */
  role: "call" | "result";
  /** result 角色对应的服务端调用；只有紧跟其后的就是这次调用的配对结果时，才确认是副本。 */
  resultForCallId?: string;
  /** 前缀已匹配且整块已收完，等下一个块开始时按结构确认去留。 */
  complete: boolean;
}

/**
 * 逐帧改写；按 message 维护状态。返回需要继续交给下游的帧（可能为空，也可能补发多帧）。
 * 只处理已解析出 JSON 的帧，其余原样返回。
 */
export class ProviderBuiltinToolStreamRewriter {
  private readonly pendingResultIds = new Set<string>();
  private held: HeldTextBlock | undefined;
  /** 上一个开始的块是服务端调用时为其 id；只有紧跟其后的 text 才可能是结果副本。 */
  private afterServerToolUseId: string | undefined;

  push(input: SseFrame, parsed: Record<string, unknown> | undefined): SseFrame[] {
    // 非 JSON 帧（注释、keepalive）和 ping 不影响块边界，直接放行，不打断缓冲。
    if (!parsed) return [input];
    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    const index = typeof parsed.index === "number" ? parsed.index : undefined;
    if (type === "ping") return [input];

    if (type === "message_start") {
      const flushed = this.flushHeld();
      this.pendingResultIds.clear();
      this.afterServerToolUseId = undefined;
      return [...flushed, input];
    }

    if (this.held && index === this.held.index) {
      return this.pushHeld(input, parsed, type);
    }

    if (type === "content_block_start" && index !== undefined) {
      const block = asRecord(parsed.content_block);
      const afterServerToolUseId = this.afterServerToolUseId;
      this.afterServerToolUseId = undefined;
      if (isProviderBuiltinServerToolUse(block)) {
        // 调用头副本只有紧跟其后的就是服务端调用时才确认是副本。
        this.dropConfirmedCopy("call");
        const flushed = this.flushHeld();
        this.pendingResultIds.add(block!.id as string);
        this.afterServerToolUseId = block!.id as string;
        return [
          ...flushed,
          rewriteFrame(input, { ...parsed, content_block: toMcpToolUseBlock(block!) }),
        ];
      }
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const paired = this.pendingResultIds.delete(block.tool_use_id);
        // 结果副本只有紧跟其后的就是配对的 tool_result 时才确认是副本，否则原样放行。
        if (paired) this.dropConfirmedCopy("result", block.tool_use_id);
        const flushed = this.flushHeld();
        if (!paired) return [...flushed, input];
        return [
          ...flushed,
          rewriteFrame(input, { ...parsed, content_block: toMcpToolResultBlock(block) }),
        ];
      }
      const flushed = this.flushHeld();
      if (block?.type === "text") {
        this.held = {
          index,
          frames: [input],
          text: typeof block.text === "string" ? block.text : "",
          role: afterServerToolUseId ? "result" : "call",
          ...(afterServerToolUseId ? { resultForCallId: afterServerToolUseId } : {}),
          complete: false,
        };
        return [...flushed, ...this.decideHeldPrefix()];
      }
      return [...flushed, input];
    }

    return [...this.flushHeld(), input];
  }

  /** 流结束时补发仍在缓冲的帧。 */
  finish(): SseFrame[] {
    return this.flushHeld();
  }

  private pushHeld(
    input: SseFrame,
    parsed: Record<string, unknown>,
    type: string | undefined,
  ): SseFrame[] {
    const held = this.held!;
    held.frames.push(input);
    const delta = asRecord(parsed.delta);
    if (type === "content_block_delta" && delta?.type === "text_delta") {
      held.text += typeof delta.text === "string" ? delta.text : "";
    }
    if (type === "content_block_stop") {
      const decided = this.decideHeldPrefix(true);
      if (this.held === held) held.complete = true;
      return decided;
    }
    return this.decideHeldPrefix();
  }

  /** 前缀不匹配就放行；匹配则继续缓冲，等下一个块开始时按结构确认（dropConfirmedCopy）。 */
  private decideHeldPrefix(stopped = false): SseFrame[] {
    const held = this.held!;
    const prefix = held.role === "call" ? CALL_RENDERING_PREFIX : RESULT_RENDERING_PREFIX;
    const text = held.text.trimStart();
    const decidable = stopped || text.length >= prefix.length;
    if (!decidable) return [];
    if (!text.startsWith(prefix)) return this.flushHeld();
    return [];
  }

  /** 下一个块确认了缓冲块就是服务端渲染副本时丢弃它；其余情况由 flushHeld 原样放行。 */
  private dropConfirmedCopy(role: HeldTextBlock["role"], resultForCallId?: string): void {
    const held = this.held;
    if (!held?.complete || held.role !== role) return;
    if (role === "result" && held.resultForCallId !== resultForCallId) return;
    this.held = undefined;
  }

  private flushHeld(): SseFrame[] {
    const held = this.held;
    this.held = undefined;
    return held ? held.frames : [];
  }
}

function rewriteFrame(input: SseFrame, data: Record<string, unknown>): SseFrame {
  const lineEnding = input.frame.includes("\r\n")
    ? "\r\n"
    : input.frame.includes("\r")
      ? "\r"
      : "\n";
  const type = typeof data.type === "string" ? data.type : "message";
  return {
    frame: `event: ${type}${lineEnding}data: ${JSON.stringify(data)}`,
    separator: input.separator,
  };
}

// ─── 非流式 JSON 响应 ─────────────────────────────────────────────────────────

export function rewriteProviderBuiltinToolContent(content: readonly unknown[]): {
  changed: boolean;
  content: unknown[];
} {
  const output: unknown[] = [];
  const pendingResultIds = new Set<string>();
  let changed = false;
  let previousServerToolUseId: string | undefined;
  for (const [position, value] of content.entries()) {
    const block = asRecord(value);
    const afterServerToolUseId = previousServerToolUseId;
    previousServerToolUseId = undefined;
    if (isProviderBuiltinServerToolUse(block)) {
      const previous = asRecord(output.at(-1));
      if (isRenderingText(previous, CALL_RENDERING_PREFIX)) output.pop();
      pendingResultIds.add(block!.id as string);
      output.push(toMcpToolUseBlock(block!));
      previousServerToolUseId = block!.id as string;
      changed = true;
      continue;
    }
    if (block?.type === "tool_result") {
      changed = true;
      if (typeof block.tool_use_id === "string" && pendingResultIds.delete(block.tool_use_id)) {
        output.push(toMcpToolResultBlock(block));
      }
      continue;
    }
    // 结果副本必须夹在服务端调用和它的配对 tool_result 之间，不能只凭加粗前缀判断。
    const next = asRecord(content[position + 1]);
    if (
      afterServerToolUseId !== undefined &&
      isRenderingText(block, RESULT_RENDERING_PREFIX) &&
      next?.type === "tool_result" &&
      next.tool_use_id === afterServerToolUseId
    ) {
      changed = true;
      continue;
    }
    output.push(value);
  }
  return { changed, content: changed ? output : [...content] };
}

function isRenderingText(block: Record<string, unknown> | undefined, prefix: string): boolean {
  return (
    block?.type === "text" &&
    typeof block.text === "string" &&
    block.text.trimStart().startsWith(prefix)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
