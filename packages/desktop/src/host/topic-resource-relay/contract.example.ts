import { createWindowTopicResourceRelay } from "./contract.js";

/** 宿主注入实时连接解析函数，窗口释放时调用返回对象的 dispose。 */
export function exampleWindowTopicResourceRelay(
  deps: Parameters<typeof createWindowTopicResourceRelay>[0],
) {
  return createWindowTopicResourceRelay(deps);
}
