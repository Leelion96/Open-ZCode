import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "../methods/turn-loop-state.js";
import { rebuildContextPrefix } from "../methods/context-refresh.js";
import { createTurnModel, sameModelSelection } from "../methods/turn-model.js";
import { getOffPeakModelBinding } from "./model-binding.js";
import { getOffPeakExecution } from "./runtime.js";

/** 用户接纳只改变归属；主轮在完整请求边界应用新选择，子轮不调用本钩子。 */
export function refreshOffPeakTurnAfterTakeover(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): boolean {
  if (!state.offPeakExecutionId) return false;
  const execution = getOffPeakExecution(runtime);
  if (!execution?.lifecycle.ownedByUser || execution.executionId !== state.offPeakExecutionId)
    return false;
  const model = createTurnModel(runtime);
  getOffPeakModelBinding(state.subagentModelOverride?.requestDependencies)?.release();
  // 修复原因：Context Prefix 的 Harness 文案按请求模型的 mid-conversation system 能力生成；
  // 只换 state.model 时，接管后的请求仍带闲时模型的文案，与实际的 reminder 通道不一致。
  const selectionChanged = !sameModelSelection(state.model, model);
  state.model = model;
  if (selectionChanged) {
    state.turnRequestState.entries = rebuildContextPrefix(runtime, {
      model,
      turnRequestEntries: state.turnRequestState.entries,
    });
  }
  state.modelSelectionScope = undefined;
  state.subagentModelOverride = undefined;
  state.offPeakTaskId = undefined;
  state.offPeakExecutionId = undefined;
  return true;
}

export function isOffPeakUserTakeover(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "off_peak_user_takeover"
  );
}
