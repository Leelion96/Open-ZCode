import {
  dropTrailingHighSurrogate,
  type ModelUsage,
  type SubagentResultMeta,
  type SubagentStopOptions,
} from "@zcode/contracts";
import { formatTaskNotification } from "../runtime-task/notification.js";

export type LocalAgentTaskNotificationStatus = "completed" | "failed" | "killed";

const UNKNOWN_ERROR = "Unknown error";
/** 结构化 error 的上限，与 workflow 行的 error 相同。 */
const SUBAGENT_RESULT_ERROR_MAX_CHARS = 2_000;

export interface LocalAgentTaskNotificationInput {
  agentId: string;
  description: string;
  error?: string;
  outputFile: string;
  parentToolCallId: string;
  result?: string;
  status: LocalAgentTaskNotificationStatus;
  /** killed 时的停止者；缺席表示系统停止。 */
  stoppedBy?: SubagentStopOptions["initiator"];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: ModelUsage;
}

export function formatLocalAgentTaskNotification(
  input: LocalAgentTaskNotificationInput,
): string {
  return formatTaskNotification({
    agentId: input.agentId,
    description: input.description,
    outputFile: input.outputFile,
    result: input.result,
    status: input.status,
    summary: `Agent "${input.description}" ${formatLocalAgentOutcome(input)}`,
    taskId: input.agentId,
    taskType: "local_agent",
    toolUseId: input.parentToolCallId,
    // 只有 completed 通知带 <usage>；failed / killed 不带。
    usage:
      input.status === "completed"
        ? {
            durationMs: input.totalDurationMs,
            modelUsage: input.usage,
            toolUseCount: input.totalToolUseCount,
            totalTokens: input.totalTokens,
          }
        : undefined,
  });
}

/**
 * 与通知文本同一份输入生成的结构化终态，随 originMeta 下发。
 * App 的“执行失败”hover 读这里的 error，不解析 summary 文本。
 */
export function localAgentSubagentResult(
  input: Pick<LocalAgentTaskNotificationInput, "error" | "status">,
): SubagentResultMeta {
  return input.status === "failed"
    ? { status: "failed", error: boundStructuredError(failureReason(input.error)) }
    : { status: input.status };
}

// 修复原因：结构化 error 随 originMeta 进入轮头和每一帧快照，原样复制超长的 provider 原文
// 会让快照和持久化 metadata 膨胀。只截这里；模型看到的 summary 仍是全文。
function boundStructuredError(error: string): string {
  if (error.length <= SUBAGENT_RESULT_ERROR_MAX_CHARS) return error;
  return `${dropTrailingHighSurrogate(error.slice(0, SUBAGENT_RESULT_ERROR_MAX_CHARS - 1))}…`;
}

// 修复原因：用 `||` 兜底时，只有空白的 error 不会变成 Unknown error，
// summary 会以 "failed: " 加空白结尾，hover 也是空白。
function failureReason(error: string | undefined): string {
  return error?.trim() ? error : UNKNOWN_ERROR;
}

// summary 措辞。失败原因直接跟在 "failed: " 后面，与 localAgentSubagentResult 的 error 相同。
function formatLocalAgentOutcome(
  input: Pick<LocalAgentTaskNotificationInput, "error" | "status" | "stoppedBy">,
): string {
  if (input.status === "completed") return "finished";
  if (input.status === "failed") return `failed: ${failureReason(input.error)}`;
  // TaskStop 是模型自己停的。
  if (input.stoppedBy === "model") return "was stopped by the application";
  if (input.stoppedBy === "user") return "was stopped by user";
  return "was stopped";
}
