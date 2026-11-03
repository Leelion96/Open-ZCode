import { randomUUID } from "node:crypto";
import type { BrowserControlPort, TraceContext } from "@zcode/contracts";
import {
  zcodeBrowserExecuteResultSchema,
  zcodeBrowserListResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolClientRequestOptions,
} from "./server-types.js";

/**
 * 一个 server context 的 broker 状态。同一 context 里 broker 被造两次——进程级 node_repl broker 用的
 * 那个（server.ts）与每个 app 的 runtime 端口（server-operations.ts）——状态必须共享。
 *
 * Bug 根因（2026-09-30）：连接记忆原来存在各自的闭包里。node_repl 的 execute 记在进程级实例，
 * runtime 的 turnEnded / closeSession 走 app 实例，那里只见过 app 实例自己发的命令（轮尾截图），
 * 于是生命周期只在恰好截过图的轮次才到达桌面（桌面日志 2026-09-30：会话 sess_fc6b0f61 用了
 * Browser，一条 turnEnded 都没有）。子会话登记同理：actor runtime 在 app 实例上登记，actor 的浏览器
 * 请求却经进程级实例到达。
 */
type BrowserRoute = Omit<ReturnType<typeof buildBrowserRequestContext>, "requestId" | "turnId">;
interface BrowserConnection {
  browserId: string;
  browserGeneration: number;
  route: BrowserRoute;
  controlScopeId?: string;
  opening?: Promise<void>;
  closing?: boolean;
}

interface ProtocolBrowserBrokerState {
  scopedBackends: Set<string>;
  connectionsBySession: Map<string, Map<string, BrowserConnection>>;
  /** 客户端不认识的子会话（dwf / core Agent 子代理）→ 发起它的客户端会话。只由 forChildSession 写入。 */
  childSessionParents: Map<string, { parentSessionId: string }>;
  /** 以父会话为 tab 归属的子会话（core Agent 子代理，tabOwner: "parent"）。 */
  parentTabOwnerChildren: Set<string>;
}

const brokerStateByContext = new WeakMap<
  ZCodeProtocolAgentServerContext,
  ProtocolBrowserBrokerState
>();

function brokerState(context: ZCodeProtocolAgentServerContext): ProtocolBrowserBrokerState {
  let state = brokerStateByContext.get(context);
  if (!state) {
    state = {
      scopedBackends: new Set(),
      connectionsBySession: new Map(),
      childSessionParents: new Map(),
      parentTabOwnerChildren: new Set(),
    };
    brokerStateByContext.set(context, state);
  }
  return state;
}

/**
 * ProtocolBrowserControlBroker —— agent 侧 BrowserControlPort 实现。
 *
 * browser-client 的 agent.browsers.* 每个调用经此把一条 BrowserCommand 变成
 * ZCode Protocol 的 interaction/browserExecute 反向请求，由 app（host→main webview/CDP）
 * 执行并返回结果。与 permission broker 并列注入（server-operations 的 createWorkspaceZCodeApp options）。
 */
export function createProtocolBrowserControlBroker(
  context: ZCodeProtocolAgentServerContext,
): BrowserControlPort {
  const state = brokerState(context);
  const { connectionsBySession, childSessionParents } = state;

  const rememberConnection = (
    {
      requestId: _requestId,
      turnId: _turnId,
      ...route
    }: ReturnType<typeof buildBrowserRequestContext>,
    browserId: string,
    browserGeneration: number,
  ) => {
    const connections = connectionsBySession.get(route.sessionId) ?? new Map();
    const backendKey = `${browserId}\u0000${browserGeneration}`;
    // 路由也是资源身份的一部分；手机/桌面、远端作用域不能相互覆盖。
    const key = JSON.stringify([
      browserId,
      browserGeneration,
      route.workspaceKey,
      route.workspaceIdentity,
      route.remoteSessionId,
      route.clientMode,
    ]);
    const existing = connections.get(key);
    const connection: BrowserConnection = existing?.controlScopeId
      ? existing
      : { browserId, browserGeneration, route };
    connections.set(key, connection);
    connectionsBySession.set(route.sessionId, connections);
    if (state.scopedBackends.has(backendKey)) connection.controlScopeId ??= randomUUID();
    if (connection.controlScopeId && !connection.opening && !connection.closing) {
      connection.opening = (async () => {
        const result = await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...route,
            requestId: randomUUID(),
            browserId,
            browserGeneration,
            controlScopeId: connection.controlScopeId,
            command: { method: "openScope" },
          },
          zcodeBrowserExecuteResultSchema,
        );
        if (
          result.ok &&
          result.scope?.id === connection.controlScopeId &&
          result.scope?.state === "open"
        )
          return;
        // 只有建立被明确拒绝才撤销记录；超时/丢响应不能证明 Main 没有登记。
        if (
          result.scope?.id === connection.controlScopeId &&
          result.scope?.state === "rejected" &&
          connections.get(key) === connection
        ) {
          connections.delete(key);
          if (!connections.size && connectionsBySession.get(route.sessionId) === connections)
            connectionsBySession.delete(route.sessionId);
        }
        throw new Error(result.error?.message ?? "Browser scope admission was not confirmed");
      })().catch((error) => {
        // 未知结果仍保留原 ID 的释放责任；失败 flight 不代表永久失败，下一次业务可幂等重试。
        connection.opening = undefined;
        throw error;
      });
    }
    return connection;
  };

  const sendLifecycle = async (
    sessionId: string,
    turnId: string | undefined,
    command:
      | { method: "turnEnded"; turnId?: string }
      | { method: "closeSession"; closeTabs?: boolean },
  ): Promise<void> => {
    const connections = connectionsBySession.get(sessionId);
    if (!connections) return;
    const results = await Promise.allSettled(
      [...connections].map(async ([key, connection]) => {
        const { browserId, browserGeneration, route, controlScopeId } = connection;
        if (command.method === "closeSession") connection.closing = true;
        // 先等待建立结果；拒绝建立已删除记录，结果未知仍交给 owner 确认释放。
        if (connection.opening) await connection.opening.catch(() => undefined);
        if (connections.get(key) !== connection) return;
        const result = await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...route,
            requestId: randomUUID(),
            ...(turnId ? { turnId } : {}),
            browserId,
            browserGeneration,
            ...(controlScopeId ? { controlScopeId } : {}),
            command:
              controlScopeId && command.method === "closeSession"
                ? { method: "releaseScope", closeTabs: command.closeTabs }
                : command,
          },
          zcodeBrowserExecuteResultSchema,
        );
        if (!result.ok)
          throw new Error(result.error?.message ?? "Browser lifecycle request failed");
        if (
          controlScopeId &&
          command.method === "closeSession" &&
          (result.scope?.id !== controlScopeId ||
            !["released", "absent"].includes(result.scope.state))
        ) {
          throw new Error("Browser scope release was not confirmed by owner");
        }
        // allSettled 不能吞掉失败，也不能让旧关闭回调删掉后续登记的新控制资源。
        if (command.method === "closeSession" && connections.get(key) === connection) {
          connections.delete(key);
        }
      }),
    );
    if (connections.size === 0 && connectionsBySession.get(sessionId) === connections) {
      connectionsBySession.delete(sessionId);
    }
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Browser lifecycle cleanup failed");
  };

  const port: BrowserControlPort = {
    async list({ sessionId, turnId, traceContext, signal }) {
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionBrowserList,
        buildBrowserRequestContext(context, state, { sessionId, turnId, traceContext }),
        zcodeBrowserListResultSchema,
        buildRequestOptions(traceContext, signal),
      );
      for (const browser of result.browsers) {
        if (browser.metadata?.controlScopes === "1")
          state.scopedBackends.add(`${browser.id}\u0000${browser.generation}`);
      }
      return result.browsers;
    },

    async execute({
      browserId,
      browserGeneration,
      sessionId,
      turnId,
      command,
      traceContext,
      signal,
    }) {
      const requestContext = buildBrowserRequestContext(context, state, {
        sessionId,
        turnId,
        traceContext,
      });
      // 先过会话校验再记连接：被拒的请求（未登记 / 已关闭的子会话）不得在共享状态里留下条目。
      // 连接记在实际下发的 tab 归属下：共用父会话 tab 的子代理，其连接要由父会话的生命周期收尾。
      const connection = rememberConnection(requestContext, browserId, browserGeneration);
      if (connection.closing) throw new Error("Browser control scope is closing");
      if (connection.opening) await connection.opening;
      if (connection.closing) throw new Error("Browser control scope is closing");
      const scopeContext = connection.controlScopeId
        ? { controlScopeId: connection.controlScopeId }
        : {};
      const cancelBackendRequest = () => {
        // 只取消 agent 侧 requestClient 会让 host/main 的 CDP 动作继续执行。
        // 这里用同一 backend/generation 发送内部 cancelRequest，main 再按原 requestId 中断 waiter；
        // 已下发动作无法证明无副作用时由 manager 返回 uncertain 标记。
        void context
          .requestClient(
            zcodeProtocolMethods.interactionBrowserExecute,
            {
              // 取消属于已准入请求；即使 runtime 已 stopping，也必须能取消桌面端动作。
              ...requestContext,
              ...scopeContext,
              requestId: randomUUID(),
              browserId,
              browserGeneration,
              command: { method: "cancelRequest", requestId: requestContext.requestId },
            },
            zcodeBrowserExecuteResultSchema,
            buildRequestOptions(traceContext, undefined),
          )
          .catch(() => undefined);
      };
      if (signal?.aborted) cancelBackendRequest();
      else signal?.addEventListener("abort", cancelBackendRequest, { once: true });
      try {
        return await context.requestClient(
          zcodeProtocolMethods.interactionBrowserExecute,
          {
            ...requestContext,
            ...scopeContext,
            browserId,
            browserGeneration,
            command,
          },
          zcodeBrowserExecuteResultSchema,
          buildRequestOptions(traceContext, signal),
        );
      } finally {
        signal?.removeEventListener("abort", cancelBackendRequest);
      }
    },

    async turnEnded({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "turnEnded", turnId });
    },

    async closeSession({ sessionId, turnId }) {
      await sendLifecycle(sessionId, turnId, { method: "closeSession" });
    },

    forChildSession({ childSessionId, parentSessionId, tabOwner = "child" }) {
      const binding = { parentSessionId };
      childSessionParents.set(childSessionId, binding);
      const release = () => {
        if (childSessionParents.get(childSessionId) !== binding) return;
        childSessionParents.delete(childSessionId);
        state.parentTabOwnerChildren.delete(childSessionId);
      };
      if (tabOwner === "parent") {
        state.parentTabOwnerChildren.add(childSessionId);
        // tab 属于当前对话：子代理的轮次结束或运行结束都不能替父会话结束 / 关闭 tab，
        // 那会把用户正在看的 tab 释放掉。收尾由父会话自己的 turnEnded / closeSession 负责。
        return {
          list: port.list,
          execute: port.execute,
          async turnEnded() {},
          async closeSession() {
            release();
          },
        };
      }
      state.parentTabOwnerChildren.delete(childSessionId);
      return {
        list: port.list,
        execute: port.execute,
        turnEnded: port.turnEnded,
        async closeSession({ sessionId, turnId }) {
          if (childSessionParents.get(childSessionId) !== binding) return;
          // 独立子会话的临时 tab 要关闭；失败时保留资源和绑定供 owner 最终收尾重试。
          await sendLifecycle(sessionId, turnId, { method: "closeSession", closeTabs: true });
          release();
        },
      };
    },
  };
  return port;
}

function buildBrowserRequestContext(
  context: ZCodeProtocolAgentServerContext,
  state: ProtocolBrowserBrokerState,
  input: {
    sessionId: string;
    turnId?: string;
    traceContext?: TraceContext;
  },
) {
  // 子会话的 workspace / clientMode 取发起它的客户端会话；下发的 sessionId 是桌面 browser scope 的
  // tab 归属，不是路由身份（docs/zcode-protocol-model-backed-control-requests.md 契约 4）：dwf 子代理用
  // 子会话自己的，core Agent 子代理用父会话的。没有登记就按原 id 找，找不到即拒。
  const parentSessionId = state.childSessionParents.get(input.sessionId)?.parentSessionId;
  const record = requireSession(context, parentSessionId ?? input.sessionId);
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;

  return {
    requestId: randomUUID(),
    // core Agent 子代理共用父会话的 tab：桌面按 sessionId 判断 tab 归属与面板展开，
    // 子会话 id 桌面不认识，用它开的 tab 既不展开面板、也不出现在任何对话里。
    sessionId:
      parentSessionId !== undefined && state.parentTabOwnerChildren.has(input.sessionId)
        ? parentSessionId
        : input.sessionId,
    ...((input.turnId ?? input.traceContext?.turnId)
      ? { turnId: String(input.turnId ?? input.traceContext?.turnId) }
      : {}),
    // workspacePath 可能在不同 remote workspace 中相同，隔离 key 必须优先使用
    // workspaceIdentity，避免 browser backend/tab ownership 跨工作区串线。
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: record.deliveryKind ?? "desktop-continuous",
    sessionContext: "live" as const,
  };
}

function buildRequestOptions(
  traceContext: TraceContext | undefined,
  signal: AbortSignal | undefined,
): ZCodeProtocolClientRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
  };
}
