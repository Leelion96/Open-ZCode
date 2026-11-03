// ============================================================
// 浏览器代理 broker（apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「浏览器代理 broker」）
// ============================================================
// Worker 里的浏览器 bridge 原来直接连 ZCode 主进程的浏览器 broker，主线程看不到这些请求，截图下标
// 只能由 Worker 自报。这里在主线程转发一跳：按本次调用的 token 找到账本条目，用条目里来自 core 的
// 会话信息改写请求、换成上游 token，并把成功的截图记进账本。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
import type { NodeReplCallLedger, NodeReplCallLedgerEntry } from "./ledger.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// 文案与原来 Worker 侧 bridge、上游 broker 的报错一致，cell 看到的错误不变。
const UNAUTHORIZED_MESSAGE = "Node REPL browser broker request is not authorized";
const UNAVAILABLE_MESSAGE = "Browser control is unavailable for this node_repl session";
const UPSTREAM_CLOSED_MESSAGE = "Browser broker closed before returning a response";
// 超限文案按方向沿用原说法：请求超限原由上游 broker 报，响应超限原由 Worker 侧 bridge 报（MR !3219 评审 SG-03）。
const REQUEST_TOO_LARGE_MESSAGE = "Node REPL browser broker request exceeded 1 MiB";
const RESPONSE_TOO_LARGE_MESSAGE = "Browser broker response exceeded the 32 MiB limit";
/** 会话信息只由代理按账本条目填写，Worker 自报的同名字段一律丢弃。 */
const SESSION_CONTEXT_FIELDS = ["token", "runtimeScope", "sessionId", "turnId", "trace"] as const;

export interface NodeReplBrowserBrokerUpstream {
  socketPath: string;
  token: string;
}

export interface NodeReplBrowserBrokerProxy {
  connection: { socketPath: string };
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createNodeReplBrowserBrokerProxy(input: {
  ledger: NodeReplCallLedger;
  upstream?: NodeReplBrowserBrokerUpstream;
  logger?: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplBrowserBrokerProxy {
  const socketPath =
    input.platform === "win32"
      ? `\\\\.\\pipe\\zcode-node-repl-browser-${randomUUID()}`
      : join(tmpdir(), `znrb-${randomUUID()}.sock`);
  const server = createServer((socket) => {
    void handleSocket(socket, input).catch((error) => {
      input.logger?.warn("Node REPL browser broker proxy request failed", {
        event: "node_repl.browser_broker_proxy.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger?.error("Node REPL browser broker proxy failed", error, {
      event: "node_repl.browser_broker_proxy.failed",
    });
  });
  server.listen(socketPath);
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    connection: { socketPath },
    ready,
    close: async () => {
      await ready.catch(() => undefined);
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (input.platform !== "win32") await rm(socketPath, { force: true });
    },
  };
}

async function handleSocket(
  socket: Socket,
  input: { ledger: NodeReplCallLedger; upstream?: NodeReplBrowserBrokerUpstream },
): Promise<void> {
  // Worker 被 abort 后会直接 destroy socket；监听覆盖整个生命周期，避免写回阶段的 EPIPE 变成无人接收的
  // 'error' 事件（同 bootstrap 浏览器 broker 的处置）。
  socket.on("error", () => undefined);
  let requestId: unknown = null;
  const respondError = (message: string) => {
    if (socket.writable)
      socket.end(`${JSON.stringify({ id: requestId, ok: false, error: message })}\n`);
  };
  try {
    const payload = JSON.parse(
      await readLine(socket, { maxBytes: MAX_REQUEST_BYTES, tooLarge: REQUEST_TOO_LARGE_MESSAGE }),
    ) as unknown;
    if (!isRecord(payload)) throw new Error("Node REPL browser broker request is invalid");
    requestId = typeof payload.id === "string" ? payload.id : null;
    const entry = input.ledger.resolve(payload.token);
    if (!entry) {
      respondError(UNAUTHORIZED_MESSAGE);
      return;
    }
    // 会话能力标签 browser_use 按「真实尝试」记：记在检查上游和转发之前，上游报错也算
    // （session-features-header.md「BUA/CUA 标签的补充规则」）。
    if (payload.op === "list" || payload.op === "execute") entry.facts.browserUse = true;
    if (!input.upstream) {
      respondError(UNAVAILABLE_MESSAGE);
      return;
    }
    const forwarded: Record<string, unknown> = { ...payload };
    for (const field of SESSION_CONTEXT_FIELDS) delete forwarded[field];
    Object.assign(forwarded, browserSessionContext(entry.requestMeta), {
      token: input.upstream.token,
    });
    const response = await forward(socket, input.upstream.socketPath, forwarded);
    recordScreenshot(entry, payload, response);
    if (socket.writable) socket.end(`${response}\n`);
  } catch (error) {
    respondError(error instanceof Error ? error.message : String(error));
  }
}

/** 把一行请求转发给上游，读回一行响应。Worker 一侧先断开时关闭上游连接（上游视为取消）。 */
async function forward(
  client: Socket,
  upstreamPath: string,
  request: Record<string, unknown>,
): Promise<string> {
  const upstream = createConnection(upstreamPath);
  upstream.on("error", () => undefined);
  const onClientClose = () => upstream.destroy();
  client.once("close", onClientClose);
  try {
    upstream.once("connect", () => upstream.write(`${JSON.stringify(request)}\n`));
    return await readLine(upstream, {
      maxBytes: MAX_RESPONSE_BYTES,
      tooLarge: RESPONSE_TOO_LARGE_MESSAGE,
      closed: UPSTREAM_CLOSED_MESSAGE,
    });
  } finally {
    client.off("close", onClientClose);
    upstream.destroy();
  }
}

/** execute 的 screenshot 命令成功并带图片时，把图片记进账本。 */
function recordScreenshot(
  entry: NodeReplCallLedgerEntry,
  request: Record<string, unknown>,
  rawResponse: string,
): void {
  if (request.op !== "execute") return;
  if (!isRecord(request.command) || request.command.method !== "screenshot") return;
  let response: unknown;
  try {
    response = JSON.parse(rawResponse);
  } catch {
    return;
  }
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) return;
  const { ok, image } = response.result;
  if (ok !== true || !isRecord(image)) return;
  if (typeof image.base64 !== "string" || typeof image.mimeType !== "string") return;
  entry.facts.browserScreenshots.push({ base64: image.base64, mimeType: image.mimeType });
}

/** 构造规则从原来 Worker 侧 bridge 的 requestContext 原样移过来，缺字段的报错文案不变。 */
function browserSessionContext(meta: Readonly<NodeReplRequestMeta>): Record<string, unknown> {
  const sessionId = stringMeta(meta, "session_id");
  if (!sessionId) throw new Error("node_repl browser request is missing session_id metadata");
  const traceId = stringMeta(meta, "trace_id");
  const turnId = stringMeta(meta, "turn_id");
  const spanId = stringMeta(meta, "span_id");
  const parentSpanId = stringMeta(meta, "parent_span_id");
  return {
    runtimeScope: meta.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(turnId ? { turnId } : {}),
    ...(traceId
      ? {
          trace: {
            traceId,
            ...(spanId ? { spanId } : {}),
            ...(parentSpanId ? { parentSpanId } : {}),
          },
        }
      : {}),
  };
}

function stringMeta(meta: Readonly<NodeReplRequestMeta>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * 读一行（不含换行）。数据块先存数组、只在新到的块里找换行，找到后一次性拼接，开销随数据量线性增长。
 * 修复原因（MR !3219 评审 SG-02）：最初每个块都把字符串整体拼接、重算字节数并从头找换行，截图越大开销
 * 越接近平方级；这里跑在所有会话共用的主线程上，一张大截图会拖住别的会话。
 */
async function readLine(
  socket: Socket,
  limits: { maxBytes: number; tooLarge: string; closed?: string },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      size += newline < 0 ? chunk.length : newline;
      if (size > limits.maxBytes) {
        cleanup();
        reject(new Error(limits.tooLarge));
        return;
      }
      if (newline < 0) {
        chunks.push(chunk);
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      cleanup();
      resolve(Buffer.concat(chunks, size).toString("utf8"));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(limits.closed ?? "Node REPL browser broker request is invalid"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onEnd);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("close", onEnd);
    socket.once("error", onError);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
