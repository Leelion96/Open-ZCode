import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRequestSessionFeature } from "@zcode/contracts";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";
import { executeAdapterGenerateText, executeAdapterStreamText } from "./test-adapter-model.js";

// 规格：docs/design/v2/model/session-features-header.md。经正式 SDK 发出的 HTTP 请求验证。
const SESSION_FEATURES_HEADER = "x-zcode-session-features";
const CAPTURE_ERROR = "session features captured";
afterEach(() => vi.unstubAllGlobals());
const providerKinds = ["anthropic", "openai", "openai-compatible"] as const;

describe.each(providerKinds)("%s session features HTTP header", (providerKind) => {
  it.each([false, true])("写出排序后的标签，并隔离并发调用，streaming=%s", async (streaming) => {
    const { adapter, requests } = createCapture(providerKind);
    await Promise.all([
      captureCall(adapter, streaming, "sess_both", ["workflow_cmd", "workflow_auto"]),
      captureCall(adapter, streaming, "sess_auto", ["workflow_auto"]),
      captureCall(adapter, streaming, "sess_none", []),
    ]);

    expect(requests).toHaveLength(3);
    const bySession = new Map(
      requests.map((request) => [
        request.headers.get("x-session-id"),
        request.headers.get(SESSION_FEATURES_HEADER),
      ]),
    );
    expect(bySession).toEqual(
      new Map([
        ["both", "workflow_auto,workflow_cmd"],
        ["auto", "workflow_auto"],
        ["none", null],
      ]),
    );
    for (const request of requests) {
      expect(request.headers.get("x-static-marker")).toBe("preserved");
      expect(await request.text()).not.toContain("workflow_auto");
    }
  });

  it.each([false, true])(
    "重试保持标签，静态同名 header 不回退，streaming=%s",
    async (streaming) => {
      const { adapter, requests } = createCapture(providerKind, true);
      await captureCall(adapter, streaming, "sess_retry", ["workflow_cmd"]);
      await captureCall(adapter, streaming, "sess_retry_empty", []);

      expect(requests.map((request) => request.headers.get(SESSION_FEATURES_HEADER))).toEqual([
        "workflow_cmd",
        "workflow_cmd",
        null,
        null,
      ]);
    },
  );
});

function createCapture(providerKind: (typeof providerKinds)[number], retry = false) {
  const requests: Request[] = [];
  const transport: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    // 重试场景：每个调用的第一次返回 503，第二次返回不可重试的 400。
    const retryable = retry && requests.length % 2 === 1;
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: CAPTURE_ERROR } },
      { status: retryable ? 503 : 400 },
    );
  };
  vi.stubGlobal("fetch", transport);
  const registry = new TestProviderConfigFixture({
    env: {},
    defaultHeaders: { "X-ZCode-Session-Features": "stale_default" },
    providers: {
      fixture: {
        kind: providerKind,
        apiKey: "fake-key",
        baseURL: "https://provider.example.test/v1",
        headers: {
          "x-zcode-session-features": "stale_provider",
          "x-static-marker": "preserved",
        },
      },
    },
  });
  const adapter = new TestAiSdkModelAdapter({
    registry,
    retry: { baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxAttempts: retry ? 2 : 1 },
  });
  return { adapter, requests };
}

async function captureCall(
  adapter: TestAiSdkModelAdapter,
  streaming: boolean,
  sessionId: string,
  features: readonly ModelRequestSessionFeature[],
) {
  const request = {
    providerId: "fixture" as never,
    modelId: "model-a" as never,
    modelRequestSessionType: "main" as const,
    modelRequestSessionFeatures: features,
    messages: [{ role: "user" as const, content: "header capture" }],
    metadata: { querySource: "main_turn", sessionId },
  };
  const send = async () => {
    if (streaming) {
      for await (const _event of executeAdapterStreamText(adapter, request)) {
        // 消费到 transport 返回的预期捕获错误。
      }
    } else {
      await executeAdapterGenerateText(adapter, request);
    }
  };
  await expect(send()).rejects.toThrow("Provider rejected the model request.");
}
