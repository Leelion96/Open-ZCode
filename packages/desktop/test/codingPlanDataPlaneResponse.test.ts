import { describe, expect, it } from "vitest";
import { createCodingPlanDataPlaneResponse } from "./e2e/helpers/coding-plan-data-plane-response.js";

const fallbackBody = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const title = { id: "e2e-title", text: '{"title":"Worker selection"}' };

describe("Coding Plan E2E 数据面响应协议", () => {
  it.each([undefined, false])("默认账号标题请求 stream=%s 返回可解析的非流式响应", (stream) => {
    const mock = createCodingPlanDataPlaneResponse(null, { fallbackBody, title });
    const request = JSON.stringify({ stream, messages: [{ role: "user", content: "title" }] });
    expect(mock.headers(request)["content-type"]).toContain("application/json");
    const response = JSON.parse(mock.body(request));
    expect(response).toMatchObject({ type: "message", role: "assistant", stop_reason: "end_turn" });
    expect(JSON.parse(response.content[0].text)).toEqual({ title: "Worker selection" });
  });

  it("普通流式正文保留 SSE，与标题旁路互不影响", () => {
    const mock = createCodingPlanDataPlaneResponse(null, { fallbackBody, title });
    const request = JSON.stringify({ stream: true });
    expect(mock.headers(request)["content-type"]).toContain("text/event-stream");
    expect(mock.body(request)).toBe(fallbackBody);
  });

  it("按最后一轮匹配流式 fixture，标题请求仍返回 JSON", () => {
    const body = 'event: content_block_delta\ndata: {"delta":{"text":"next turn"}}\n\n';
    const mock = createCodingPlanDataPlaneResponse(
      [{ match: { lastUserMessageIncludes: ["NEXT"] }, response: { body } }],
      { fallbackBody, title },
    );
    const messages = [{ role: "user", content: "NEXT" }];
    expect(mock.body(JSON.stringify({ stream: true, messages }))).toBe(body);
    expect(
      mock.body(
        JSON.stringify({
          stream: true,
          messages: [...messages, { role: "user", content: "OTHER" }],
        }),
      ),
    ).toBe(fallbackBody);
    const titleRequest = JSON.stringify({ messages });
    expect(mock.headers(titleRequest)["content-type"]).toContain("application/json");
    expect(JSON.parse(mock.body(titleRequest)).content[0].text).toBe(title.text);
  });
});
