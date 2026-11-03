import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
} from "@zcode/zcode-cua";
import type { Logger } from "@zcode/contracts";
import type { NodeReplCuaAppIdentity, NodeReplRequestMeta } from "@zcode/core/repl";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NodeReplCallLedger } from "./call-ledger/contract.js";
import { CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE } from "./cua-bridge.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface NodeReplCuaBroker {
  /** 只有地址；token 每次调用由账本签发（20-node-repl-call-ledger.md「账本与 token」）。 */
  connection: { socketPath: string };
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createNodeReplCuaBroker(input: {
  runtime: ComputerUseRuntime;
  ledger: NodeReplCallLedger;
  logger?: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker {
  const socketPath =
    input.platform === "win32"
      ? `\\\\.\\pipe\\zcode-node-repl-cua-${randomUUID()}`
      : join(tmpdir(), `znrc-${randomUUID()}.sock`);
  const server = createServer((socket) => {
    void handleSocket(socket, input.runtime, input.ledger).catch((error) => {
      input.logger?.warn("Node REPL CUA broker request failed", {
        event: "node_repl.cua_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger?.error("Node REPL CUA broker failed", error, {
      event: "node_repl.cua_broker.failed",
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
  runtime: ComputerUseRuntime,
  ledger: NodeReplCallLedger,
): Promise<void> {
  const abortController = new AbortController();
  let completed = false;
  let requestId: string | undefined;
  socket.on("error", () => {
    if (!completed) abortController.abort();
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw) as {
      id?: unknown;
      token?: unknown;
      method?: unknown;
      input?: unknown;
      context?: unknown;
    };
    // 只认本次调用的 token；会话信息按账本条目里来自 core 的 request-context 构造，Worker 发来的
    // context 不采信。修复原因（MR !3207 评审 CR-01）：原来整个进程共用一个 token、直接采信请求里的
    // context，cell 绕过 bridge 就能冒充别的会话，或在 subagent 里冒充主会话。
    const entry = ledger.resolve(payload.token);
    if (!entry) throw new Error("Computer Use broker request is not authorized");
    // 会话能力标签 computer_use 按「真实尝试」记：记在校验请求和 subagent 检查之前，broker 侧的拒绝、
    // runtime 的失败都算（session-features-header.md「BUA/CUA 标签的补充规则」）。
    entry.facts.computerUse = true;
    if (typeof payload.id !== "string" || typeof payload.method !== "string") {
      throw new Error("Computer Use broker request is invalid");
    }
    requestId = payload.id;
    const context = parseContext(requestContext(entry.requestMeta));
    // Worker 侧 bridge 已先拒绝 subagent；这里兜住绕过 bridge 的请求。
    if (context.runtimeScope === "subagent") throw new Error(CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    const result = await runtime.execute({
      // 这里把 capability method 适配到 staging runtime 的内部 handler；
      // 外层 SDK/bridge 不再构造或调用 MCP tool envelope。
      toolName: payload.method as never,
      arguments: payload.input,
      context,
      signal: abortController.signal,
    });
    // 目标应用身份在这里取：runtime 结果在 Worker 之外，cell 改不了。等结果经 Worker 的
    // `projectToHost` → `nodeRepl.emitStructuredResult` 就已落在 cell 可写的通道上。
    const app = readPrimaryAppIdentity(result);
    if (app) entry.facts.cuaApps.push(app);
    completed = true;
    if (socket.writable) socket.end(`${JSON.stringify({ id: payload.id, ok: true, result })}\n`);
  } catch (error) {
    completed = true;
    if (socket.writable) {
      socket.end(`${JSON.stringify({ id: requestId ?? null, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}

/**
 * 从 producer 的 app-associations 元数据里取出单一目标应用。
 *
 * 只读 `primary`：`list_apps` 用的是 `items` 模式（按结果下标关联，node_repl 下没有逐条列表卡），
 * `request_access` / `stop_computer_control` 声明 `none`，这三者都不该覆盖同一 cell 里前面动作
 * 已经确立的身份。producer 自带的内联 icon PNG 刻意不取：会话协议不承载图标字节，UI 按
 * appKey 派生 locator 后交平台服务解析。
 */
function readPrimaryAppIdentity(result: CallToolResult): NodeReplCuaAppIdentity | undefined {
  const meta = result._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const associations = (meta as Record<string, unknown>)[CUA_APP_ASSOCIATIONS_META_KEY];
  if (!associations || typeof associations !== "object" || Array.isArray(associations)) {
    return undefined;
  }
  const primary = (associations as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return undefined;
  const { appKey, displayName } = primary as { appKey?: unknown; displayName?: unknown };
  if (typeof appKey !== "string" || !appKey.trim()) return undefined;
  return {
    appKey: appKey.trim(),
    ...(typeof displayName === "string" && displayName.trim()
      ? { displayName: displayName.trim() }
      : {}),
  };
}

/** 构造规则从原来 Worker 侧 bridge 原样移过来，缺字段的报错文案不变。 */
function requestContext(meta: Readonly<NodeReplRequestMeta>): Record<string, unknown> {
  const stringMeta = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const sessionId = stringMeta("session_id");
  if (!sessionId) throw new Error("node_repl CUA request is missing session_id metadata");
  const workspacePath = stringMeta("workspace_path");
  const workspaceIdentity = stringMeta("workspace_identity");
  const workspaceKey = stringMeta("workspace_key") ?? workspaceIdentity ?? workspacePath;
  if (!workspaceKey) throw new Error("node_repl CUA request is missing workspaceKey metadata");
  const clientMode = stringMeta("client_mode") ?? "desktop-continuous";
  const deliveryKind = stringMeta("delivery_kind") ?? clientMode;
  // badge 文字（spec §4.8）：node_repl cell 的 title（js 契约必填、host 已放进 callMeta）。
  // 一个代码块一个 title——cell 内所有 CUA 动作共享，换 cell 才换字。
  const actionTitle = stringMeta("title");
  return {
    runtimeScope: meta.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(actionTitle ? { actionTitle } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    workspaceKey,
    ...(stringMeta("remote_session_id")
      ? { remoteSessionId: stringMeta("remote_session_id") }
      : {}),
    ...(stringMeta("turn_id") ? { turnId: stringMeta("turn_id") } : {}),
    clientMode,
    deliveryKind,
    ...(stringMeta("trace_id")
      ? {
          trace: {
            traceId: stringMeta("trace_id"),
            ...(stringMeta("span_id") ? { spanId: stringMeta("span_id") } : {}),
            ...(stringMeta("parent_span_id")
              ? { parentSpanId: stringMeta("parent_span_id") }
              : {}),
          },
        }
      : {}),
  };
}

function parseContext(value: unknown): ComputerUseRuntimeContext {
  if (!value || typeof value !== "object") throw new Error("Computer Use request context is missing");
  const context = value as Record<string, unknown>;
  if (typeof context.sessionId !== "string" || !context.sessionId.trim()) {
    throw new Error("Computer Use request context is missing sessionId");
  }
  const workspacePath = typeof context.workspacePath === "string" ? context.workspacePath.trim() : "";
  const workspaceIdentity =
    typeof context.workspaceIdentity === "string" ? context.workspaceIdentity.trim() : "";
  const workspaceKey =
    (typeof context.workspaceKey === "string" ? context.workspaceKey.trim() : "") ||
    workspaceIdentity ||
    workspacePath;
  if (!workspaceKey) throw new Error("Computer Use request context is missing workspaceKey");
  return {
    sessionId: context.sessionId,
    runtimeScope: context.runtimeScope === "subagent" ? "subagent" : "main",
    workspaceKey,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(typeof context.remoteSessionId === "string" ? { remoteSessionId: context.remoteSessionId } : {}),
    ...(typeof context.turnId === "string" ? { turnId: context.turnId } : {}),
    // badge 文字（spec §4.8）：node_repl cell title。白名单重组此前把它丢掉，
    // 导致 actionTitle 断在 cua-broker socket 这一跳——badge 从未出现（2026-10-25 真机）。
    ...(typeof context.actionTitle === "string" && context.actionTitle.trim()
      ? { actionTitle: context.actionTitle.trim().slice(0, 120) }
      : {}),
    ...(context.clientMode === "web-remote-replayable" || context.clientMode === "desktop-continuous"
      ? { clientMode: context.clientMode }
      : {}),
    ...(context.deliveryKind === "web-remote-replayable" || context.deliveryKind === "desktop-continuous"
      ? { deliveryKind: context.deliveryKind }
      : {}),
    ...(context.trace && typeof context.trace === "object" ? { trace: context.trace as ComputerUseRuntimeContext["trace"] } : {}),
  };
}

async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Computer Use broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
