import {
  CoreErrorType,
  HookEventName,
  dropTrailingHighSurrogate,
  isCoreError,
  type CollaborationMode,
  type PermissionBrokerResult,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionDecisionResult } from "../../permission/service.js";
import { hookMatcherToolNamesForTool } from "../compat.js";
import { formatCompactPersistedOutputContent } from "../result-persistence-format.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { previewHookValue } from "./utils.js";

export async function runPreToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  entry: ToolEntry,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PreToolUse,
      mode,
      riskLevel: entry.metadata.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: entry.metadata.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPermissionRequestHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  requestId: string,
  permissionDecision: PermissionDecisionResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult | undefined> {
  if (!deps.hookRunner) return undefined;
  const hookResult = await deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PermissionRequest,
      mode,
      reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
      requestId,
      riskLevel: permissionDecision.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: permissionDecision.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
  const decision = hookResult.permissionRequestResult;
  if (hookResult.preventContinuation) {
    return {
      decision: "deny",
      reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
    };
  }
  if (!decision) {
    if (hookResult.permissionBehavior === "deny") {
      return {
        decision: "deny",
        reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
      };
    }
    return hookResult.permissionBehavior === "allow"
      ? {
          decision: "allow",
          reason: "Allowed by PermissionRequest hook",
        }
      : undefined;
  }
  if (decision.behavior === "deny") {
    return {
      decision: "deny",
      reason: decision.message ?? "Denied by PermissionRequest hook",
    };
  }
  const permissionUpdates = decision.permissionUpdates ?? decision.updatedPermissions;
  return decision.updatedInput === undefined
    ? {
        decision: "allow",
        permissionUpdates,
        reason: "Allowed by PermissionRequest hook",
      }
    : {
        decision: "modify",
        modifiedInput: decision.updatedInput,
        permissionUpdates,
        reason: "Allowed with modified input by PermissionRequest hook",
      };
}

export async function runPostToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  output: unknown,
  artifactPath: string | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      artifactRefs: artifactPath ? [artifactPath] : undefined,
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PostToolUse,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      toolResponse: output,
      toolResultPreview: previewHookValue(output),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPostToolUseFailureHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  error: unknown,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  const normalized = error instanceof Error ? error : new Error(String(error));
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      error: {
        message: normalized.message,
        type: isCoreError(normalized) ? normalized.type : normalized.name,
      },
      hookEventName: HookEventName.PostToolUseFailure,
      isInterrupt: isCoreError(normalized) && normalized.type === CoreErrorType.ToolCancelled,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export function applyPreToolPermissionDecision(
  permissionDecision: PermissionDecisionResult,
  hookResult: HookRunResult,
  mode: CollaborationMode,
): PermissionDecisionResult {
  if (permissionDecision.decision === "deny") return permissionDecision;
  // alwaysAsk 声明出来的确认（如 workflow 运行确认）不能被 PreToolUse hook
  // 的整体 allow 悄悄抹掉——那等于给"任何模式都要问"开了一个静默后门。自动化仍有正规出口：
  // PermissionRequest hook 可以应答这次弹窗（见 runPermissionRequestHooks）。
  if (
    hookResult.permissionBehavior === "allow" &&
    permissionDecision.decision === "ask" &&
    !permissionDecision.alwaysAsk
  ) {
    return {
      ...permissionDecision,
      allowed: true,
      decision: "allow",
      escalated: false,
      mode,
      reason: hookResult.hookPermissionDecisionReason ?? "Tool was allowed by PreToolUse hook",
      ruleId: "hook.PreToolUse.allow",
    };
  }
  if (hookResult.permissionBehavior === "ask" && permissionDecision.decision === "allow") {
    return {
      ...permissionDecision,
      allowed: false,
      decision: "ask",
      escalated: true,
      mode,
      reason:
        hookResult.hookPermissionDecisionReason ?? "Tool requires approval by PreToolUse hook",
      ruleId: "hook.PreToolUse.ask",
    };
  }
  return permissionDecision;
}

type ToolHookEventName =
  | typeof HookEventName.PreToolUse
  | typeof HookEventName.PostToolUse
  | typeof HookEventName.PostToolUseFailure;

const TOOL_HOOK_CONTEXT_MAX_CHARS = 10_000;
const TOOL_HOOK_CONTEXT_CONTENT_TYPE = "text/plain";
const MISSING_ARTIFACT_STORE_REASON = "no artifact store";

/**
 * 每条 context 单独成文，多个 Hook 不合并，多行原样保留。
 * 修复原因：Hook 文本移出 tool result 后不再受 tool result 预算约束，一条超长 context 会整段进入
 * 每次请求。现在单条超过 10000 字符先落盘，模型只看到外壳和预览（hooks.md「聚合规则」）。
 * 调用方先做官方 CUA 凭据过滤再调用这里，被过滤的 context 不会写进文件。
 */
export async function formatToolHookAdditionalContexts(
  deps: ToolExecutorDeps,
  hookEventName: ToolHookEventName,
  toolCall: ExecutableToolCall,
  additionalContexts: readonly string[],
  traceContext: TraceContext,
): Promise<string[]> {
  return Promise.all(
    additionalContexts.map(
      async (context) =>
        `${hookEventName}:${toolCall.name} hook additional context: ${await boundToolHookContext(
          deps,
          toolCall,
          context,
          traceContext,
        )}`,
    ),
  );
}

async function boundToolHookContext(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  context: string,
  traceContext: TraceContext,
): Promise<string> {
  if (context.length <= TOOL_HOOK_CONTEXT_MAX_CHARS) return context;
  let failureReason = MISSING_ARTIFACT_STORE_REASON;
  if (deps.artifactStore) {
    try {
      const artifact = await deps.artifactStore.writeToolResultArtifact({
        content: context,
        contentType: TOOL_HOOK_CONTEXT_CONTENT_TYPE,
        retention: "session",
        sessionId: deps.sessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        trace: traceContext,
        turnId: traceContext.turnId ?? deps.turnId,
      });
      return formatCompactPersistedOutputContent({
        content: context,
        originalBytes: context.length,
        persistedPath: artifact.path ?? artifact.uri,
      });
    } catch (error) {
      // 写入失败不让工具调用失败：退回截断，并把原因告诉模型。
      failureReason = error instanceof Error ? error.message : String(error);
    }
  }
  const head = dropTrailingHighSurrogate(context.slice(0, TOOL_HOOK_CONTEXT_MAX_CHARS));
  return `${head}\n\n[Hook additionalContext truncated at ${TOOL_HOOK_CONTEXT_MAX_CHARS} chars — persist-to-disk failed: ${failureReason}]`;
}
