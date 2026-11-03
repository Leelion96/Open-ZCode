import { toolSearchComparisonMessages, type OpenAiMessage } from "./contract.js";

/** 比较副本与原始请求分别保留，导出方继续使用 original。 */
export function exampleToolSearchComparison(original: readonly OpenAiMessage[]) {
  return { original, comparison: toolSearchComparisonMessages(original) };
}
