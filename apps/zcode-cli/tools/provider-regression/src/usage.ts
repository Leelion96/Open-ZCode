/** 只读取可重放 JSON 请求，不消费 Adapter 持有的 Request。 */
export async function readModelRequestBody(
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Record<string, unknown> | undefined> {
  const body = init?.body;
  const text =
    typeof body === "string"
      ? body
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
        ? new TextDecoder().decode(body)
        : url instanceof Request && body == null
          ? await url.clone().text()
          : undefined;
  if (!text) return;
  const payload = record(JSON.parse(text));
  // 前置鉴权曾混入 Map 和 usage 统计；只观察实际推理请求，字节体也不能漏掉。
  if (typeof payload.model === "string" && ("messages" in payload || "input" in payload))
    return payload;
}

/** 只观察原始 usage 数字，不保存响应或思考正文。 */
export interface ObservedUsage {
  reasoningTokens: number | null;
}
function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
function observePayload(text: string, usage: ObservedUsage) {
  try {
    const payload = record(JSON.parse(text));
    const raw = record(payload.usage ?? record(payload.response).usage);
    const value =
      raw.reasoning_tokens ??
      record(raw.completion_tokens_details).reasoning_tokens ??
      record(raw.output_tokens_details).reasoning_tokens;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      usage.reasoningTokens = value;
  } catch {
    /* 非 JSON SSE 控制帧不包含 usage。 */
  }
}
export async function observeUsage(response: Response, usage: ObservedUsage): Promise<Response> {
  if (!response.ok || !response.body) return response;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const bytes = await response.arrayBuffer();
    observePayload(new TextDecoder().decode(bytes), usage);
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (!type.includes("text/event-stream")) return response;
  const decoder = new TextDecoder();
  let pending = "";
  const line = (text: string) => {
    if (text.startsWith("data:") && text.includes('"usage"'))
      observePayload(text.slice(5).trim(), usage);
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let end = pending.indexOf("\n");
      while (end >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
      controller.enqueue(chunk);
    },
    flush() {
      pending += decoder.decode();
      if (pending) line(pending);
    },
  });
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
