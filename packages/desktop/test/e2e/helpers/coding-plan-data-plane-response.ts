export interface DataPlaneTurnFixture {
  match: { lastUserMessageIncludes: string[] };
  response: { body: string };
}

/** 账号数据面按最后一条 user message 回放；非流式标题旁路返回 JSON message。 */
function createDataPlaneTurnResponder(
  fixtures: readonly DataPlaneTurnFixture[],
  options: { fallbackBody: string; title: { id: string; text: string } },
) {
  return (requestBody: string) => {
    const request = JSON.parse(requestBody) as {
      stream?: boolean;
      messages?: Array<{ role: string; content: unknown }>;
    };
    if (request.stream !== true)
      return JSON.stringify({
        id: options.title.id,
        type: "message",
        role: "assistant",
        model: "GLM-5.2",
        content: [{ type: "text", text: options.title.text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 },
      });
    const messages = request.messages ?? [];
    const lastUser = JSON.stringify(
      messages.findLast((message) => message.role === "user")?.content,
    );
    return (
      fixtures.find((fixture) =>
        fixture.match.lastUserMessageIncludes.every((marker) => lastUser?.includes(marker)),
      )?.response.body ?? options.fallbackBody
    );
  };
}

export function createCodingPlanDataPlaneResponse(
  fixtures: readonly DataPlaneTurnFixture[] | null,
  options: { fallbackBody: string; title: { id: string; text: string } },
) {
  // 原因：默认账号 mock 曾无条件返回 SSE，非流式标题请求无法解析；统一按请求协议响应。
  return {
    body: createDataPlaneTurnResponder(fixtures ?? [], options),
    headers: (requestBody: string) => ({
      "content-type":
        JSON.parse(requestBody).stream !== true
          ? "application/json; charset=utf-8"
          : "text/event-stream; charset=utf-8",
    }),
  };
}
