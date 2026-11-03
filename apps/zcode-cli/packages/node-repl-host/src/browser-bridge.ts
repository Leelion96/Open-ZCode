import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { BrowserClientTransport } from "@zcode/core/browser-client";
import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core/repl";
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
// 只加载 broker 协议；shared 总入口会在每个 Worker 中初始化无关领域的 schema。
import { nodeReplBrowserBrokerResponseSchema } from "@zcode/shared/node-repl-browser-broker";
import { NODE_REPL_BROWSER_BRIDGE_SYMBOL } from "./runtime-bridge.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
type BrokerResponse = ReturnType<typeof nodeReplBrowserBrokerResponseSchema.parse>;
type SuccessfulBrokerResponse = Extract<BrokerResponse, { ok: true }>;

export interface ActiveNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

/** Worker 连主线程浏览器代理 broker 用的地址和本次调用的 token（由主线程账本签发）。 */
export interface NodeReplBrowserBrokerConnection {
  socketPath: string;
  token: string;
}

// 修复原因（MR !3207 评审 CR-01）：bridge 原来直接连 ZCode 主进程的浏览器 broker，并在 Worker 里
// 填写会话信息、记录截图；cell 能冒充 Worker 的结果消息，也能自报别的会话。现在只连主线程的代理，
// 会话信息由代理按账本条目填写，截图由代理记进账本（20-node-repl-call-ledger.md「浏览器代理 broker」）。
export function createBrowserBridgeGlobals(input: {
  broker?: NodeReplBrowserBrokerConnection;
  documentationRoot: string;
  generation: number;
  getActiveCall: () => ActiveNodeReplCall | undefined;
  session: () => NodeReplSession;
}): Record<PropertyKey, unknown> {
  const assertActive = (): ActiveNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Browser runtime binding is stale after kernel reset");
    }
    return active;
  };
  const transport: BrowserClientTransport = {
    list: async () => {
      const active = assertActive();
      const response = await sendBrokerRequest(input.broker, { op: "list" }, active.signal);
      assertActive();
      return response.browsers ?? [];
    },
    execute: async (browserId, browserGeneration, command) => {
      const active = assertActive();
      const response = await sendBrokerRequest(
        input.broker,
        { op: "execute", browserId, browserGeneration, command },
        active.signal,
      );
      assertActive();
      if (!response.result) throw new Error("Browser broker returned no command result");
      mergeBrowserResponseMeta(input.session(), command, response.result);
      return response.result;
    },
  };
  return {
    [NODE_REPL_BROWSER_BRIDGE_SYMBOL]: {
      ...transport,
      documentationRoot: input.documentationRoot,
      assertAvailable: assertActive,
    },
  };
}



async function sendBrokerRequest(
  broker: NodeReplBrowserBrokerConnection | undefined,
  request:
    | { op: "list" }
    | {
        op: "execute";
        browserId: string;
        browserGeneration: number;
        command: BrowserCommand;
      },
  signal: AbortSignal,
): Promise<SuccessfulBrokerResponse> {
  if (!broker) {
    throw new Error("Browser control is unavailable for this node_repl session");
  }
  const { socketPath, token } = broker;
  const id = randomUUID();
  return await new Promise<SuccessfulBrokerResponse>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const socket = createConnection(socketPath);
    const finish = (error?: unknown, value?: SuccessfulBrokerResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Browser broker returned no response"));
    };
    const onAbort = () => finish(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Browser broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as unknown;
        const parsed = nodeReplBrowserBrokerResponseSchema.parse(response);
        if (parsed.id !== id) throw new Error("Browser broker response id mismatch");
        if (!parsed.ok) throw new Error(parsed.error);
        finish(undefined, parsed);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Browser broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}

function mergeBrowserResponseMeta(
  session: NodeReplSession,
  command: BrowserCommand,
  result: BrowserCommandResult,
): void {
  const meta = result.meta;
  if (!meta) return;
  const finalized = result.ok && command.method === "finalizeTabs";
  const includeOpenTabs = result.ok && isBrowserSurfaceSideEffect(command);
  session.mergeResponseMeta({
    "zcode/browserUse": true,
    "zcode/toolSurface": {
      kind: "browserUse",
      backend: meta.backendType,
      browserId: meta.browserId,
      ...(includeOpenTabs || finalized ? { openTabIds: meta.openTabIds } : {}),
      ...(finalized ? { sessionEnded: true } : {}),
    },
    browser_use: meta.currentUrl ? { url: meta.currentUrl } : {},
    ...(result.ok && meta.tabId && isAutoScreenshotTriggerCommand(command)
      ? {
          "zcode/browserTurnScreenshot": {
            browserGeneration: meta.browserGeneration,
            browserId: meta.browserId,
            tabId: meta.tabId,
          },
        }
      : {}),
  });
}

function isAutoScreenshotTriggerCommand(command: BrowserCommand): boolean {
  if (
    command.method === "capabilities" ||
    command.method === "list" ||
    command.method === "listUserTabs" ||
    command.method === "browserVisibilityGet"
  ) {
    return false;
  }
  return !["cancelRequest", "closeSession", "finalizeTabs", "nameSession", "turnEnded"].includes(
    command.method,
  );
}

function isBrowserSurfaceSideEffect(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "scroll",
    "hover",
    "select",
    "check",
    "drag",
    "handleDialog",
    "close",
  ].includes(command.method);
}
