import { projectToolReferences } from "./contract.js";

/** 同一份原始历史可以分别生成两种请求，调用方不保存投影结果作为新历史。 */
export function exampleToolSearchModeSwitch(
  entries: Parameters<typeof projectToolReferences>[0],
  tools: Parameters<typeof projectToolReferences>[2],
) {
  return {
    local: projectToolReferences(entries, "local", tools),
    native: projectToolReferences(entries, "native", tools),
  };
}
