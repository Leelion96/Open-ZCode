import { requiresRequestVerification, type RequestVerificationConfig } from "./contract.js";

/** Host 先判定账号是否需要交互，再以读取到的同一配置快照决定投递。 */
export function exampleRequestVerificationPolicy(snapshot: RequestVerificationConfig): boolean {
  return requiresRequestVerification({ mode: "start-plan" }, snapshot);
}
