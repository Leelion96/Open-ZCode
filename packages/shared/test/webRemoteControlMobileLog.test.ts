import { describe, expect, it } from "vitest";
import { parseWebRemoteControlAppPayload } from "../src/validation.js";
import { WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS } from "../src/web-remote-relay/index.js";

const entry = { ts: 1_700_000_000_000, level: "info", tag: "rc", message: "hello" };

describe("web remote control mobile log payloads", () => {
  it("接受实时 mobile-log 帧，忽略未知字段（前向兼容）", () => {
    const parsed = parseWebRemoteControlAppPayload({
      zcode_type: "mobile-log",
      device: { id: "install-1", platform: "android", appVersion: "1.0.0" },
      sessionId: "boot-1",
      events: [{ ...entry, extra: true }],
      futureField: 1,
    });
    expect(parsed).toEqual({
      zcode_type: "mobile-log",
      device: { id: "install-1", platform: "android", appVersion: "1.0.0" },
      sessionId: "boot-1",
      events: [entry],
    });
  });

  it("拒绝空帧、超条数与非法级别", () => {
    expect(parseWebRemoteControlAppPayload({ zcode_type: "mobile-log", events: [] })).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-log",
        events: Array.from(
          { length: WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS.maxEventsPerFrame + 1 },
          () => entry,
        ),
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-log",
        events: [{ ...entry, level: "verbose" }],
      }),
    ).toBeNull();
  });

  it("解析拉取请求与三种应答（明文 / gzip / 失败）", () => {
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-log-pull-request",
        requestId: "r1",
        sinceTs: 1,
        minLevel: "warn",
        acceptEncodings: ["gzip"],
      }),
    ).toMatchObject({ zcode_type: "mobile-log-pull-request", requestId: "r1" });

    const meta = {
      zcode_type: "mobile-log-pull-response",
      requestId: "r1",
      success: true,
      totalMatched: 1,
      returnedCount: 1,
      hasMore: false,
      sources: ["memory-ring"],
    };
    expect(parseWebRemoteControlAppPayload({ ...meta, entries: [entry] })).toMatchObject({
      entries: [entry],
    });
    expect(
      parseWebRemoteControlAppPayload({ ...meta, encoding: "gzip", data: "H4sI", entryCount: 1 }),
    ).toMatchObject({ encoding: "gzip", entryCount: 1 });
    expect(
      parseWebRemoteControlAppPayload({
        zcode_type: "mobile-log-pull-response",
        requestId: "r1",
        success: false,
        reason: "unsupported-action",
        error: "not supported",
      }),
    ).toMatchObject({ success: false, reason: "unsupported-action" });
  });

  it("拒绝超限的 gzip 分片与超长 cursor", () => {
    const meta = {
      zcode_type: "mobile-log-pull-response",
      requestId: "r1",
      success: true,
      totalMatched: 1,
      returnedCount: 1,
      hasMore: true,
      sources: [],
    };
    expect(
      parseWebRemoteControlAppPayload({
        ...meta,
        encoding: "gzip",
        data: "a".repeat(WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS.maxCompressedShardBase64Chars + 1),
        entryCount: 1,
      }),
    ).toBeNull();
    expect(
      parseWebRemoteControlAppPayload({
        ...meta,
        cursor: "c".repeat(WEB_REMOTE_CONTROL_MOBILE_LOG_LIMITS.maxCursorLength + 1),
        entries: [],
      }),
    ).toBeNull();
  });
});
