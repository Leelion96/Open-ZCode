import assert from "node:assert/strict";
import test from "node:test";
import { parseProductConfig, productKey } from "../../packages/shared/src/product.ts";
import { loadProductConfig } from "../product-config.mjs";

test("desktop product has five fields and derives Open-ZCode's namespace", async () => {
  const product = await loadProductConfig();
  assert.deepEqual(product, {
    name: "Open-ZCode",
    appId: "dev.openzcode.app",
    customizeIdentity: true,
    isolateUserData: true,
    isolateProjectData: true,
  });
  assert.equal(productKey(product), "open-zcode");
});

test("another enabled isolation product derives its own name", () => {
  const product = parseProductConfig({
    name: "Team Studio",
    appId: "org.example.studio",
    customizeIdentity: true,
    isolateUserData: true,
    isolateProjectData: true,
  });
  assert.equal(productKey(product), "team-studio");
  assert.throws(() => parseProductConfig({ ...product, name: "../unsafe" }), /safe ASCII/);
  assert.throws(() => parseProductConfig({ ...product, appId: "bad/id" }), /application ID/);
});
