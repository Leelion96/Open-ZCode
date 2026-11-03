// 新源码原来散落在 legacy 根目录，CI 无法确认归属；公开入口统一收口到受管模块。
export * from "#src/web-remote-relay/contract.js";
export * from "#src/web-remote-relay/domain/retry.js";
export * from "#src/web-remote-relay/domain/heartbeatTiming.js";
export * from "#src/web-remote-relay/domain/webRemoteControlActions.js";
// 手机日志通道（mobile-log / mobile-log-pull）报文 schema 与上限。
export * from "#src/web-remote-relay/mobileLog.js";
export { WebRemoteControlV2Heartbeat } from "#src/web-remote-relay/adapters/heartbeat.js";

export {
  collectMobilePushEvents,
  type MobilePushObservation,
} from "#src/web-remote-relay/domain/notification.js";
