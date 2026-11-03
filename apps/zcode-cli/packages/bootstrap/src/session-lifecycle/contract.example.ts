/**
 * session-lifecycle 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SessionLifecycle } from "./contract.js";

export async function exampleSessionLifecycle(contract: SessionLifecycle): Promise<void> {
  await contract.ensureReady("existing-session");
  await contract.getState("existing-session");
  await contract.stop("existing-session");
}
