import { expect, it, vi } from "vitest";
import { createCodingPlanSubscriptionService } from "#src/coding-plan-subscription/codingPlanSubscriptionService.js";

it("disables official plan calls before credential or network access", async () => {
  const request = vi.fn();
  const load = vi.fn();
  const service = createCodingPlanSubscriptionService({
    apiClient: { request },
    credentialService: { load },
    officialPlansEnabled: false,
  });
  expect(await service.getBillingDiscount()).toBeUndefined();
  await expect(service.getStaticProducts()).rejects.toThrow("disabled");
  await expect(service.getEnterpriseBalance()).rejects.toThrow("disabled");
  expect(request).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});
