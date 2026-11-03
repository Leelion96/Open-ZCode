import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { seedPersonalProviderConfig } from "../test/e2e/helpers/model-provider-restart-config.js";

describe("E2E Personal Provider seed", () => {
  it("persists a disabled model without disabling its visible sibling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-provider-seed-"));
    const filePath = join(directory, "provider_config.json");
    const repository = new NodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: false,
    });
    try {
      await seedPersonalProviderConfig(filePath, {
        id: "e2e-model-filter",
        label: "Model filter",
        apiFormat: "anthropic-messages",
        apiKey: "e2e-key",
        baseURL: "https://provider.example.com",
        models: [{ id: "visible-model" }, { id: "disabled-model", enabled: false }],
      });
      const config = await repository.read();
      expect(config.models.getExact("e2e-model-filter", "visible-model")?.enabled).toBe(true);
      expect(config.models.getExact("e2e-model-filter", "disabled-model")?.enabled).toBe(false);
    } finally {
      repository.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
