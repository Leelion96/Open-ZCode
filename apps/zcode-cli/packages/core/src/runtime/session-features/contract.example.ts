import { ModelRequestSessionFeature } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { readSessionFeatures, recordSessionFeature } from "./contract.js";

/** 打点后，同一 runtime 发出的下一次模型请求读到的快照里就有这个标签。 */
export function exampleRecordThenRead(runtime: AgentRuntimeInternal): readonly string[] {
  recordSessionFeature.call(runtime, { feature: ModelRequestSessionFeature.WorkflowCmd });
  return readSessionFeatures(runtime);
}
