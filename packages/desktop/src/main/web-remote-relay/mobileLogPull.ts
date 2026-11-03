// 桌面主动拉取手机日志（mobile-log-pull-request/response）的会话编排：
// 一次拉取 = 同一 requestId 的多片请求；每片应答到达后先交给 onShard 落盘，
// 落盘完成才发下一片（天然背压，桌面不在内存里囤全部日志）。
// 手机不支持时：回 app-error(requestId, unsupported-action) 或 success:false(reason=unsupported-action)
// 立即失败；完全不回（旧版本忽略未知报文）时由单片超时兜住。
// 本模块不依赖 manager 内部结构：发送函数与 owner 由调用方注入，便于单测。

import { randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS,
  webRemoteControlMobileLogCompressedEntriesSchema,
  type WebRemoteControlAppErrorPayload,
  type WebRemoteControlMobileLogEntry,
  type WebRemoteControlMobileLogLevel,
  type WebRemoteControlMobileLogPullRequestPayload,
  type WebRemoteControlMobileLogPullResponsePayload,
} from "@zcode/shared";

const gunzipAsync = promisify(gunzip);

/** 单片应答超时：手机读本地文件 + 压缩，留足余量。 */
export const MOBILE_LOG_PULL_SHARD_TIMEOUT_MS = 30_000;
/** 单次拉取最多分片数（防手机 cursor 死循环）。 */
export const MOBILE_LOG_PULL_MAX_SHARDS = 5_000;

export interface MobileLogPullQuery {
  sinceTs?: number;
  untilTs?: number;
  minLevel?: WebRemoteControlMobileLogLevel;
  keyword?: string;
  maxEntries?: number;
}

export interface MobileLogPullShard {
  entries: WebRemoteControlMobileLogEntry[];
  sources: string[];
  compressed: boolean;
}

export interface MobileLogPullSummary {
  requestId: string;
  entryCount: number;
  totalMatched: number;
  shardCount: number;
  compressedShardCount: number;
  truncated: boolean;
  sources: string[];
}

export type MobileLogPullErrorCode =
  | "not-paired"
  | "busy"
  | "unsupported"
  | "timeout"
  | "disconnected"
  | "mobile-error"
  | "invalid-shard";

export class MobileLogPullError extends Error {
  constructor(
    readonly code: MobileLogPullErrorCode,
    message: string,
    /** 失败前已落盘的条数（导出方据此决定是否保留部分文件）。 */
    readonly entryCount = 0,
  ) {
    super(message);
    this.name = "MobileLogPullError";
  }
}

/** gzip 分片解码：base64 → gunzip（限制解压字节）→ JSON 数组 → 逐条 schema 校验。 */
export async function decodeCompressedMobileLogShard(
  data: string,
  expectedCount: number,
): Promise<WebRemoteControlMobileLogEntry[]> {
  const raw = await gunzipAsync(Buffer.from(data, "base64"), {
    maxOutputLength: WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS.maxDecompressedShardBytes,
  });
  const parsed = webRemoteControlMobileLogCompressedEntriesSchema.safeParse(
    JSON.parse(raw.toString("utf8")),
  );
  if (!parsed.success) throw new Error("compressed shard entries failed schema validation");
  if (parsed.data.length !== expectedCount) {
    throw new Error(
      `compressed shard entryCount mismatch: declared ${expectedCount}, got ${parsed.data.length}`,
    );
  }
  return parsed.data;
}

interface PullSession {
  owner: object;
  requestId: string;
  baseRequest: Omit<WebRemoteControlMobileLogPullRequestPayload, "cursor">;
  send: (payload: WebRemoteControlMobileLogPullRequestPayload) => void;
  onShard: (shard: MobileLogPullShard) => Promise<void>;
  resolve: (summary: MobileLogPullSummary) => void;
  reject: (error: MobileLogPullError) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** true = 正在处理上一片（解压/落盘），这期间到达的同 requestId 应答视为重复丢弃。 */
  processing: boolean;
  entryCount: number;
  shardCount: number;
  compressedShardCount: number;
  truncated: boolean;
  sources: string[];
}

export interface MobileLogPullCoordinatorOptions {
  shardTimeoutMs?: number;
  maxShards?: number;
  createRequestId?: () => string;
}

export function createMobileLogPullCoordinator(options: MobileLogPullCoordinatorOptions = {}) {
  const shardTimeoutMs = options.shardTimeoutMs ?? MOBILE_LOG_PULL_SHARD_TIMEOUT_MS;
  const maxShards = options.maxShards ?? MOBILE_LOG_PULL_MAX_SHARDS;
  const createRequestId = options.createRequestId ?? (() => `mobile-log-pull-${randomUUID()}`);
  const sessions = new Map<string, PullSession>();

  function finish(
    session: PullSession,
    outcome: { error: MobileLogPullError } | { totalMatched: number },
  ): void {
    if (sessions.get(session.requestId) !== session) return;
    clearTimeout(session.timer);
    sessions.delete(session.requestId);
    if ("error" in outcome) {
      session.reject(
        new MobileLogPullError(outcome.error.code, outcome.error.message, session.entryCount),
      );
      return;
    }
    session.resolve({
      requestId: session.requestId,
      entryCount: session.entryCount,
      totalMatched: outcome.totalMatched,
      shardCount: session.shardCount,
      compressedShardCount: session.compressedShardCount,
      truncated: session.truncated,
      sources: session.sources,
    });
  }

  function fail(session: PullSession, code: MobileLogPullErrorCode, message: string): void {
    finish(session, { error: new MobileLogPullError(code, message) });
  }

  function sendShardRequest(session: PullSession, cursor?: string): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      fail(
        session,
        "timeout",
        `mobile did not answer within ${Math.round(shardTimeoutMs / 1000)}s`,
      );
    }, shardTimeoutMs);
    session.send(
      cursor === undefined ? { ...session.baseRequest } : { ...session.baseRequest, cursor },
    );
  }

  async function processShard(
    session: PullSession,
    payload: Extract<WebRemoteControlMobileLogPullResponsePayload, { success: true }>,
  ): Promise<void> {
    let entries: WebRemoteControlMobileLogEntry[];
    const compressed = "encoding" in payload;
    try {
      entries = compressed
        ? await decodeCompressedMobileLogShard(payload.data, payload.entryCount)
        : payload.entries;
    } catch (error) {
      fail(session, "invalid-shard", error instanceof Error ? error.message : String(error));
      return;
    }
    if (sessions.get(session.requestId) !== session) return;
    session.shardCount += 1;
    if (compressed) session.compressedShardCount += 1;
    session.sources = payload.sources;
    if (payload.truncated) session.truncated = true;
    try {
      await session.onShard({ entries, sources: payload.sources, compressed });
    } catch (error) {
      fail(
        session,
        "invalid-shard",
        `write shard failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    session.entryCount += entries.length;
    if (sessions.get(session.requestId) !== session) return;
    session.processing = false;
    if (payload.hasMore && payload.cursor !== undefined) {
      if (session.shardCount >= maxShards) {
        // 防御：手机 cursor 不收敛时停在这里，结果标截断而不是无限续拉。
        session.truncated = true;
        finish(session, { totalMatched: payload.totalMatched });
        return;
      }
      sendShardRequest(session, payload.cursor);
      return;
    }
    finish(session, { totalMatched: payload.totalMatched });
  }

  return {
    /** 发起一次拉取；同一 owner 同时只允许一个拉取会话。 */
    start(input: {
      owner: object;
      query: MobileLogPullQuery;
      send: (payload: WebRemoteControlMobileLogPullRequestPayload) => void;
      onShard: (shard: MobileLogPullShard) => Promise<void>;
    }): Promise<MobileLogPullSummary> {
      for (const session of sessions.values()) {
        if (session.owner === input.owner) {
          return Promise.reject(
            new MobileLogPullError("busy", "a mobile log pull is already running"),
          );
        }
      }
      const requestId = createRequestId();
      const { query } = input;
      return new Promise<MobileLogPullSummary>((resolve, reject) => {
        const session: PullSession = {
          owner: input.owner,
          requestId,
          baseRequest: {
            zcode_type: "mobile-log-pull-request",
            requestId,
            ...(query.sinceTs !== undefined ? { sinceTs: query.sinceTs } : {}),
            ...(query.untilTs !== undefined ? { untilTs: query.untilTs } : {}),
            ...(query.minLevel !== undefined ? { minLevel: query.minLevel } : {}),
            ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
            ...(query.maxEntries !== undefined ? { maxEntries: query.maxEntries } : {}),
            acceptEncodings: ["gzip"],
          },
          send: input.send,
          onShard: input.onShard,
          resolve,
          reject,
          processing: false,
          entryCount: 0,
          shardCount: 0,
          compressedShardCount: 0,
          truncated: false,
          sources: [],
        };
        sessions.set(requestId, session);
        sendShardRequest(session);
      });
    },

    /** 处理手机应答；返回是否属于在途拉取。 */
    handleResponse(payload: WebRemoteControlMobileLogPullResponsePayload): boolean {
      const session = sessions.get(payload.requestId);
      if (!session) return false; // 超时/取消后的迟到分片：丢弃。
      if (session.processing) return true; // 重复应答：丢弃，不打乱分片顺序。
      clearTimeout(session.timer);
      if (!payload.success) {
        fail(
          session,
          payload.reason === "unsupported-action" ? "unsupported" : "mobile-error",
          payload.error,
        );
        return true;
      }
      session.processing = true;
      void processShard(session, payload);
      return true;
    },

    /** 手机对拉取请求回 app-error（如不认识该报文的 unsupported-action）；返回是否消费。 */
    handleAppError(payload: WebRemoteControlAppErrorPayload): boolean {
      const session = payload.requestId ? sessions.get(payload.requestId) : undefined;
      if (!session) return false;
      fail(
        session,
        payload.reason === "unsupported-action" ? "unsupported" : "mobile-error",
        payload.error,
      );
      return true;
    },

    /** 连接停止/失败时终止该 owner 的在途拉取。 */
    cancelOwner(owner: object, message: string): void {
      for (const session of sessions.values()) {
        if (session.owner === owner) {
          fail(session, "disconnected", message);
        }
      }
    },
  };
}

export type MobileLogPullCoordinator = ReturnType<typeof createMobileLogPullCoordinator>;
