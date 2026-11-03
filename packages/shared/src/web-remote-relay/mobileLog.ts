import { z } from "zod";

/**
 * 手机日志通道（远控 app payload）：
 * - `mobile-log`：手机 → 桌面实时推送日志片段，桌面按设备/会话落盘；
 * - `mobile-log-pull-request` / `mobile-log-pull-response`：桌面主动拉取手机本地日志，
 *   cursor 分片续拉，分片可选 gzip 压缩；桌面导出成文件。
 * 规格与线格式说明见 docs/web-remote-control/mobile-log-channel.md。
 * schema 不加 strict：手机新版本多带字段时桌面忽略，保持前向兼容。
 */
export const WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS = {
  /** 推送帧 / 未压缩拉取分片的条数上限。 */
  maxEventsPerFrame: 100,
  /** gzip 分片解压后的条数上限。 */
  maxEntriesPerCompressedShard: 2_000,
  /** gzip 分片 base64 文本上限（含 relay 外壳后仍低于 1 MiB 物理帧）。 */
  maxCompressedShardBase64Chars: 700_000,
  /** gzip 分片解压后字节上限。 */
  maxDecompressedShardBytes: 8 * 1024 * 1024,
  maxNameLength: 200,
  maxTagLength: 100,
  maxMessageLength: 4_000,
  maxCursorLength: 256,
  maxKeywordLength: 200,
  maxPullEntries: 1_000_000,
} as const;

const limits = WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS;

export const webRemoteControlMobileLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type WebRemoteControlMobileLogLevel = z.infer<typeof webRemoteControlMobileLogLevelSchema>;

/** 单条日志：推送帧与拉取分片共用同一 schema。 */
export const webRemoteControlMobileLogEntrySchema = z.object({
  /** 手机侧事件时间（epoch 毫秒）。 */
  ts: z.number().int().positive(),
  level: webRemoteControlMobileLogLevelSchema,
  /** 结构化事件名（可选）。 */
  name: z.string().max(limits.maxNameLength).optional(),
  /** 日志 tag / 模块名（可选）。 */
  tag: z.string().max(limits.maxTagLength).optional(),
  /** 日志正文；手机侧截断到上限，不要求单行。 */
  message: z.string().max(limits.maxMessageLength).optional(),
});
export type WebRemoteControlMobileLogEntry = z.infer<typeof webRemoteControlMobileLogEntrySchema>;

/** 手机自报身份：桌面用它分目录/分文件；缺省时退回 mobile-view-state 里的设备信息。 */
export const webRemoteControlMobileLogDeviceSchema = z.object({
  /** 稳定设备标识（如安装 ID），只用作目录名，桌面会做文件名安全化。 */
  id: z.string().min(1).max(128),
  name: z.string().max(128).optional(),
  platform: z.string().max(32).optional(),
  appVersion: z.string().max(64).optional(),
});
export type WebRemoteControlMobileLogDevice = z.infer<typeof webRemoteControlMobileLogDeviceSchema>;

export const webRemoteControlMobileLogPayloadSchema = z.object({
  zcode_type: z.literal("mobile-log"),
  events: z.array(webRemoteControlMobileLogEntrySchema).min(1).max(limits.maxEventsPerFrame),
  device: webRemoteControlMobileLogDeviceSchema.optional(),
  /** 手机进程/启动会话标识；同一会话的日志落同一组文件。 */
  sessionId: z.string().min(1).max(128).optional(),
});
export type WebRemoteControlMobileLogPayload = z.infer<
  typeof webRemoteControlMobileLogPayloadSchema
>;

export const WEB_REMOTE_CONTROL_MOBILE_LOG_PULL_ENCODINGS = ["gzip"] as const;
export type WebRemoteControlMobileLogPullEncoding =
  (typeof WEB_REMOTE_CONTROL_MOBILE_LOG_PULL_ENCODINGS)[number];

export const webRemoteControlMobileLogPullRequestPayloadSchema = z.object({
  zcode_type: z.literal("mobile-log-pull-request"),
  requestId: z.string().min(1).max(128),
  /** 事件时间窗（epoch 毫秒，闭区间），缺省不限。 */
  sinceTs: z.number().int().positive().optional(),
  untilTs: z.number().int().positive().optional(),
  /** 级别下限 debug < info < warn < error，缺省全部。 */
  minLevel: webRemoteControlMobileLogLevelSchema.optional(),
  /** 对 name/tag/message 的大小写不敏感子串过滤。 */
  keyword: z.string().max(limits.maxKeywordLength).optional(),
  /** 条数安全阀；超出时保新弃旧并在应答标 truncated。 */
  maxEntries: z.number().int().min(1).max(limits.maxPullEntries).optional(),
  /** 续拉游标（opaque），首片不带。 */
  cursor: z.string().min(1).max(limits.maxCursorLength).optional(),
  /** 桌面能解的分片压缩格式；手机可以忽略并回未压缩分片。 */
  acceptEncodings: z.array(z.enum(WEB_REMOTE_CONTROL_MOBILE_LOG_PULL_ENCODINGS)).max(4).optional(),
});
export type WebRemoteControlMobileLogPullRequestPayload = z.infer<
  typeof webRemoteControlMobileLogPullRequestPayloadSchema
>;

const pullShardMetaShape = {
  zcode_type: z.literal("mobile-log-pull-response"),
  requestId: z.string().min(1).max(128),
  success: z.literal(true),
  /** 过滤后、截断前的匹配总数。 */
  totalMatched: z.number().int().nonnegative(),
  /** 含本片在内累计已返回条数。 */
  returnedCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  /** hasMore=true 时必带，桌面原样带回。 */
  cursor: z.string().min(1).max(limits.maxCursorLength).optional(),
  truncated: z.boolean().optional(),
  /** 本次覆盖的日志源（自由字符串，如 "memory-ring"、"log-files"）。 */
  sources: z.array(z.string().min(1).max(64)).max(8),
} as const;

/** 成功分片 A：明文条目（≤100）。 */
export const webRemoteControlMobileLogPullPlainShardSchema = z.object({
  ...pullShardMetaShape,
  entries: z.array(webRemoteControlMobileLogEntrySchema).max(limits.maxEventsPerFrame),
});

/** 成功分片 B：gzip(UTF-8 JSON 数组<entry>) 后 base64；仅在请求声明 acceptEncodings 含 gzip 时允许。 */
export const webRemoteControlMobileLogPullCompressedShardSchema = z.object({
  ...pullShardMetaShape,
  encoding: z.literal("gzip"),
  data: z.string().min(1).max(limits.maxCompressedShardBase64Chars),
  /** 本片解压后条数（桌面用来校验）。 */
  entryCount: z.number().int().nonnegative().max(limits.maxEntriesPerCompressedShard),
});

/** gzip 分片解压后的 JSON 数组（桌面解码后校验用）。 */
export const webRemoteControlMobileLogCompressedEntriesSchema = z
  .array(webRemoteControlMobileLogEntrySchema)
  .max(limits.maxEntriesPerCompressedShard);

export const webRemoteControlMobileLogPullFailureSchema = z.object({
  zcode_type: z.literal("mobile-log-pull-response"),
  requestId: z.string().min(1).max(128),
  success: z.literal(false),
  /** 机器可读原因：unsupported-action（不支持）/ busy / unexpected-error 等。 */
  reason: z.string().max(64).optional(),
  error: z.string().max(2_000),
});

export type WebRemoteControlMobileLogPullPlainShard = z.infer<
  typeof webRemoteControlMobileLogPullPlainShardSchema
>;
export type WebRemoteControlMobileLogPullCompressedShard = z.infer<
  typeof webRemoteControlMobileLogPullCompressedShardSchema
>;
export type WebRemoteControlMobileLogPullResponsePayload =
  | WebRemoteControlMobileLogPullPlainShard
  | WebRemoteControlMobileLogPullCompressedShard
  | z.infer<typeof webRemoteControlMobileLogPullFailureSchema>;

/** 进入 app payload 总 union 的 schema（顺序：压缩分片先于明文，避免被宽松对象吞掉）。 */
export const webRemoteControlMobileLogAppPayloadSchemas = [
  webRemoteControlMobileLogPayloadSchema,
  webRemoteControlMobileLogPullRequestPayloadSchema,
  webRemoteControlMobileLogPullCompressedShardSchema,
  webRemoteControlMobileLogPullPlainShardSchema,
  webRemoteControlMobileLogPullFailureSchema,
] as const;

export type WebRemoteControlMobileLogAppPayload =
  | WebRemoteControlMobileLogPayload
  | WebRemoteControlMobileLogPullRequestPayload
  | WebRemoteControlMobileLogPullResponsePayload;
