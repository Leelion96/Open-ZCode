import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { createDocumentOwner } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
import { PARSERS } from "#office/adapters/parsers.ts";
import { createOfficeServer, sessionOf } from "#office/adapters/server.ts";
import { OfficeError } from "#office/contract.ts";

const fixtures = resolve(import.meta.dirname, "../../fixtures");
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function connect() {
  const owner = createDocumentOwner({
    files: createWorkspaceFiles(fixtures),
    async parse(file) {
      const parse = PARSERS[file.kind];
      if (!parse) throw new OfficeError("unsupported_type", file.path);
      return parse(file.bytes, file.path, { cMapUrl: "", standardFontDataUrl: "" });
    },
  });
  const server = createOfficeServer({ owner, assetRoot: fixtures });
  const client = new Client({ name: "test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());
  // 宿主在每次 tools/call 的 _meta 里写 session_id（agent 与面板调用相同）。
  const call = async (
    session: string | null | Record<string, string>,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const result = await client.callTool({
      name,
      arguments: args,
      ...(typeof session === "string" ? { _meta: { session_id: session } } : {}),
      ...(session && typeof session === "object" ? { _meta: session } : {}),
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result.structuredContent as Record<string, any>;
  };
  return { call, client };
}

it("says read and search serve the panel and names the skills for other work", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const describe = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
  // 默认 profile 打开全部格式：面板标题为 Office，生产技能为四个格式各自的技能。
  for (const name of ["read_document", "search_document"]) {
    expect(describe(name)).toContain("Office panel");
    expect(describe(name)).toContain("Open the document with open_document first.");
    expect(describe(name)).toContain("`docx`, `xlsx`, `pptx` or `pdf` skill");
  }
  expect(describe("read_document")).toContain("an anchor the panel understands");
  // 修复原因：Excel 未缓存的公式在 server 文字里没有结果，面板却会计算显示，
  // 所以描述不能声称文字与面板显示完全一致。
  expect(describe("read_document")).not.toContain("matches what the panel shows");
});

it("keeps the viewer's document and views of each session apart", async () => {
  const { call } = await connect();
  await call("s1", "open_document", { path: "report.docx" });
  expect((await call("s2", "get_viewer")).document).toBeNull();
  expect((await call("s1", "get_viewer")).document.path).toBe("report.docx");

  await call("s1", "report_view", { viewId: "w1", path: "report.docx", at: "p:1" });
  const second = await call("s2", "get_view");
  expect(second.view.path).toBeNull();
  const first = await call("s1", "get_view");
  expect(first.view.path).toBe("report.docx");
});

it("treats calls without a session as one default session", async () => {
  const { call } = await connect();
  await call(null, "open_document", { path: "report.docx" });
  expect((await call(null, "get_viewer")).document.path).toBe("report.docx");
  expect((await call("s1", "get_viewer")).document).toBeNull();
});

it("puts a subagent's calls in the viewer state of its root session", async () => {
  const { call } = await connect();
  const subagent = { session_id: "subagent-1", root_session_id: "s1" };
  await call(subagent, "open_document", { path: "report.docx" });
  expect((await call("s1", "get_viewer")).document.path).toBe("report.docx");
  await call("s1", "report_view", { viewId: "w1", path: "report.docx", at: "p:1" });
  expect((await call(subagent, "get_view")).view.path).toBe("report.docx");
  expect((await call("s2", "get_viewer")).document).toBeNull();
});

it("reads the session only from a non-empty string", () => {
  expect(sessionOf({ session_id: "s1" })).toBe("s1");
  expect(sessionOf({ session_id: "child", root_session_id: "s1" })).toBe("s1");
  expect(sessionOf({ session_id: "s1", root_session_id: "" })).toBe("s1");
  expect(sessionOf({ session_id: "" })).toBeUndefined();
  expect(sessionOf({ session_id: 7 })).toBeUndefined();
  expect(sessionOf(undefined)).toBeUndefined();
});
