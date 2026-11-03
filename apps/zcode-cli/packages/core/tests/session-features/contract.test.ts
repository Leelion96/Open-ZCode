import { expectTypeOf, it } from "vitest";
import type { ModelRequestSessionFeature } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../../src/runtime/internal.js";
import {
  readSessionFeatures,
  recordSessionFeature,
  recordSessionFeatureFromToolSearchExposure,
  sessionFeatureFromToolSearchExposure,
  sessionFeaturesFromToolResult,
} from "../../src/runtime/session-features/contract.js";

// 行为与失败路径见 session-features.test.ts；本契约钉住打点入口与读取快照的形状。
it("打点入口绑定 runtime this，读取返回只读的标签数组", () => {
  expectTypeOf(recordSessionFeature).thisParameter.toEqualTypeOf<AgentRuntimeInternal>();
  expectTypeOf(recordSessionFeature).returns.toEqualTypeOf<boolean>();
  expectTypeOf(
    recordSessionFeatureFromToolSearchExposure,
  ).thisParameter.toEqualTypeOf<AgentRuntimeInternal>();
  expectTypeOf(readSessionFeatures).returns.toEqualTypeOf<readonly ModelRequestSessionFeature[]>();
  expectTypeOf(sessionFeaturesFromToolResult).returns.toEqualTypeOf<ModelRequestSessionFeature[]>();
  expectTypeOf(sessionFeatureFromToolSearchExposure).returns.toEqualTypeOf<
    ModelRequestSessionFeature | undefined
  >();
});
