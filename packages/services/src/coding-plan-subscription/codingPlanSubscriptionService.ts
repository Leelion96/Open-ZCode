import { applyDynamicWorkflowUserMode, type ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import { BigModelCodingPlanSubscriptionProvider } from "./bigmodelCodingPlanSubscriptionProvider.js";
import type { ModelSelectionView } from "@zcode/provider";
import { ZaiCodingPlanSubscriptionProvider } from "./zaiCodingPlanSubscriptionProvider.js";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  /** 应用装配关闭官方套餐；通用 factory 的上游默认行为保持不变。 */
  officialPlansEnabled?: boolean;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  /**
   * 用户在设置里选的动态工作流模式（launch.md「The user's choice」）。只有拥有设置权威的装配
   * （desktop 本地 Host、web/standalone server）注入；缺省时快照只含服务端的「提供」。
   */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
}

/**
 * 原 service 把所有调用直接绑定到单一 BigModelCodingPlanSubscriptionProvider，
 * zai family 没有独立的 Team Plan 定价来源（死代码）。
 *
 * zai 与 bigmodel Team Plan 全链路对称化：
 * 同时持有 bigmodel 和 zai 两个 provider 实例；enterprise 读路径（getEnterprisePricing）按
 * request.family 路由到对应实例；缺省 family 时保持 bigmodel，向后兼容既有调用点。
 *
 * 其余方法（购买/staticConfigs/preview 等）语义与 family 无关或已在 provider 内部按
 * request.providerId 动态路由，统一委托给 bigmodel provider 即可：
 *   - 企业购买闭环（balance/order/pending/cancel/continue/status）按产品决策仍只走 bigmodel 域。
 *   - staticConfigs 是平台级 client/configs，与 family 无关。
 *   - 购买类（Stripe/PayPal/preview/createSign 等）已通过 request.providerId 在 provider 内路由。
 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const bigmodelProvider = new BigModelCodingPlanSubscriptionProvider(dependencies);
  const zaiProvider = new ZaiCodingPlanSubscriptionProvider(dependencies);
  const official = <T>(request: () => Promise<T>): Promise<T> => {
    // 入口隐藏不能防止后台或 RPC 继续请求；在唯一 service 边界拒绝商业调用。
    if (dependencies.officialPlansEnabled === false) return Promise.reject(new Error("Official plan features are disabled in this application"));
    return request();
  };

  // 按 family 选择 enterprise 读路径 provider；缺省（含未指定 family 的历史调用）走 bigmodel。
  const resolveEnterprisePricingProvider = (
    family?: "bigmodel" | "zai",
  ): BigModelCodingPlanSubscriptionProvider => (family === "zai" ? zaiProvider : bigmodelProvider);

  return {
    batchPreview: (request) => official(() => bigmodelProvider.batchPreview(request)),
    getStaticProducts: () => official(() => bigmodelProvider.getStaticProducts()),
    getStaticTeamProducts: () => official(() => bigmodelProvider.getStaticTeamProducts()),
    getStartPlanPreview: () => official(() => bigmodelProvider.getStartPlanPreview()),
    getManualClaimPlanPreviews: () => official(() => bigmodelProvider.getManualClaimPlanPreviews()),
    claimManualPlan: (request) => official(() => bigmodelProvider.claimManualPlan(request)),
    getOffPeakClientConfig: (options) => bigmodelProvider.getOffPeakClientConfig(options),
    // 动态工作流灰度：与 client/configs 同源，
    // 因此和其它平台级配置一样固定走 bigmodel provider，与 family 无关。
    // 用户选择在这里套到「提供」上，renderer 读到的就是生效值；规则只写在 shared 的
    // applyDynamicWorkflowUserMode 里，renderer 不自己算。
    getDynamicWorkflowClientConfig: async (options) => {
      const offer = await bigmodelProvider.getDynamicWorkflowClientConfig(options);
      const resolveUserMode = dependencies.resolveDynamicWorkflowUserMode;
      return resolveUserMode ? applyDynamicWorkflowUserMode(offer, await resolveUserMode()) : offer;
    },
    getModelContextBudgetStrategy: () => official(() => bigmodelProvider.getModelContextBudgetStrategy()),
    getBillingDiscount: () => dependencies.officialPlansEnabled === false ? Promise.resolve(undefined) : bigmodelProvider.getBillingDiscount(),
    getRequestVerificationConfig: () => bigmodelProvider.getRequestVerificationConfig(),
    getForceUpdateConfig: () => bigmodelProvider.getForceUpdateConfig(),
    productInfo: (request) => official(() => bigmodelProvider.productInfo(request)),
    preview: (request) => official(() => bigmodelProvider.preview(request)),
    createSign: (request) => official(() => bigmodelProvider.createSign(request)),
    updateSign: (request) => official(() => bigmodelProvider.updateSign(request)),
    checkPayment: (request) => official(() => bigmodelProvider.checkPayment(request)),
    checkPendingOrders: (request) => official(() => bigmodelProvider.checkPendingOrders(request)),
    queryStripeCards: (request) => official(() => bigmodelProvider.queryStripeCards(request)),
    bindStripeCard: (request) => official(() => bigmodelProvider.bindStripeCard(request)),
    unbindStripeCard: (request) => official(() => bigmodelProvider.unbindStripeCard(request)),
    payStripe: (request) => official(() => bigmodelProvider.payStripe(request)),
    checkPaypalSupport: (request) => official(() => bigmodelProvider.checkPaypalSupport(request)),
    createPaypalSetupToken: (request) => official(() => bigmodelProvider.createPaypalSetupToken(request)),
    subscribePaypal: (request) => official(() => bigmodelProvider.subscribePaypal(request)),
    getEnterprisePricing: (request) =>
      official(() => resolveEnterprisePricingProvider(request?.family).getEnterprisePricing(request)),
    getEnterpriseBalance: () => official(() => bigmodelProvider.getEnterpriseBalance()),
    calculateEnterpriseOrder: (request) => official(() => bigmodelProvider.calculateEnterpriseOrder(request)),
    createEnterpriseOrder: (request) => official(() => bigmodelProvider.createEnterpriseOrder(request)),
    getEnterprisePendingOrders: () => official(() => bigmodelProvider.getEnterprisePendingOrders()),
    cancelEnterpriseOrder: (request) => official(() => bigmodelProvider.cancelEnterpriseOrder(request)),
    continueEnterpriseOrderPayment: (request) =>
      official(() => bigmodelProvider.continueEnterpriseOrderPayment(request)),
    checkEnterpriseOrderStatus: (request) => official(() => bigmodelProvider.checkEnterpriseOrderStatus(request)),
  };
}
