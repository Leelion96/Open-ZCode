import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiClient } from "@zcode/shared";

/** 复用已有分享契约 fake，发布、preview、continuation 全程留在隔离测试控制面。 */
export function createConversationShareMockRoute() {
  let client: ApiClient | undefined;
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (!request.url?.startsWith("/api/v1/shares")) return false;
    const origin = `http://${request.headers.host}`;
    // 服务单测夹具不在 Desktop 的 TypeScript rootDir；通过测试期 URL 装载复用，不把它编进产品。
    const fixtureUrl = new URL(
      "../../../../services/test/helpers/conversationShareMockApiClient.ts",
      import.meta.url,
    );
    const { ConversationShareMockApiClient } = await import(fixtureUrl.href);
    client ??= new ConversationShareMockApiClient({
      shareBaseUrl: `${origin}/cn/share`,
      contentBlockVersions: { workflow: 2, "tool-presentation": 1 },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = Object.fromEntries(
      Object.entries(request.headers).flatMap(([name, value]) =>
        typeof value === "string" ? [[name, value]] : [],
      ),
    );
    const bytes = Buffer.concat(chunks);
    // HTTP 上传是二进制 multipart；转成 UTF-8 会丢失 FormData 类型并破坏文件摘要。
    // 用标准解析器还原服务契约 fake 接收的 FormData，JSON 请求仍保留原字符串。
    const body = request.headers["content-type"]?.startsWith("multipart/form-data")
      ? await new Response(bytes, { headers }).formData()
      : bytes.toString("utf8");
    const result = await client!.request(new URL(request.url, origin), {
      method: request.method,
      headers,
      ...(chunks.length ? { body } : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
    return true;
  };
}
