/**
 * 会话能力标签的公开入口（docs/design/v2/model/session-features-header.md）。
 * 打点只调 recordSessionFeature / recordSessionFeaturesFromToolResults /
 * recordSessionFeatureFromToolSearchExposure；出站请求只读 readSessionFeatures。
 */
export {
  buildSessionFeaturesEntry,
  parseSessionFeaturesEntryData,
  readSessionFeatures,
  recordSessionFeature,
  recordSessionFeatureFromToolSearchExposure,
  recordSessionFeaturesFromToolResults,
  restoreSessionFeaturesOnResume,
  sessionFeatureFromToolSearchExposure,
  sessionFeaturesFromPersistedMessages,
  sessionFeaturesFromToolResult,
  writeSessionFeaturesEntryAfterFirstPersist,
} from "./session-features.js";
export type { SessionFeaturesEntryData } from "./session-features.js";
