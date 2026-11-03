/** 是否需要交互由发行策略决定；配置缺失的失败处理由 Host 负责。 */
export {
  requiresRequestVerification,
  requestVerificationInteractionAvailable,
  type RequestVerificationConfig,
} from "./verification-policy.js";
