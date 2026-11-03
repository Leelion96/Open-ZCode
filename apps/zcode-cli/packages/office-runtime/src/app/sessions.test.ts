import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentOwner, MAX_SESSIONS, type Parser } from "#office/app/documents.ts";
import { createWorkspaceFiles } from "#office/adapters/files.ts";
import { FILE_CHUNK_BYTES, OfficeError } from "#office/contract.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// 一个工作区共用一个 server：查看状态按 session 划分，解析缓存共享（spec §8）。
function setup(options: { root?: string; gate?: Promise<void> } = {}) {
  const parsed: string[] = [];
  const parse: Parser = async (file) => {
    parsed.push(file.path);
    await options.gate;
    return {
      kind: file.kind,
      title: null,
      units: 1,
      outline: [],
      read: () => ({ text: "", next: null }),
      search: () => [],
      check: (locator) => locator,
    };
  };
  const owner = createDocumentOwner({
    files: createWorkspaceFiles(options.root ?? resolve(import.meta.dirname, "../../fixtures")),
    parse,
  });
  return { owner, parsed };
}

const invalidToken = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof OfficeError && error.code === "invalid_token";
  }
  return false;
};

describe("sessions sharing one server", () => {
  it("keep the viewer's document per session and share parsed documents", async () => {
    const { owner, parsed } = setup();
    const first = owner.session("s1");
    const second = owner.session("s2");
    await first.open("paper.pdf");
    expect(second.current()).toBeNull();
    expect(second.snapshot().document).toBeNull();
    await second.open("report.docx");
    expect(first.current()?.path).toBe("paper.pdf");
    expect(second.current()?.path).toBe("report.docx");
    await second.open("paper.pdf");
    expect(parsed.filter((path) => path === "paper.pdf")).toHaveLength(1);
  });

  it("number reveals per session", async () => {
    const { owner } = setup();
    const first = await owner.session("s1").open("paper.pdf", "page:1");
    const second = await owner.session("s2").open("paper.pdf", "page:1");
    expect(first.reveal?.seq).toBe(1);
    expect(second.reveal?.seq).toBe(1);
  });

  it("keep view reports per session", async () => {
    const { owner } = setup();
    const first = owner.session("s1");
    const second = owner.session("s2");
    await first.report({ viewId: "a", path: "paper.pdf", at: "page:2" });
    await second.report({ viewId: "b", path: "report.docx", at: "p:1" });
    expect(first.views().map((view) => view.viewId)).toEqual(["a"]);
    expect(first.view().path).toBe("paper.pdf");
    expect(second.view().path).toBe("report.docx");
    second.releaseView("a");
    expect(first.views()).toHaveLength(1);
  });

  it("never let one session's loads expire another session's file handle", async () => {
    const { owner } = setup();
    const first = owner.session("s1");
    const second = owner.session("s2");
    const { file } = await first.load("paper.pdf");
    for (let i = 0; i < 6; i++) await second.load("report.docx");
    expect(owner.chunk(file.token, 0)).not.toBe("");
    for (let i = 0; i < 4; i++) await first.load("report.docx");
    expect(invalidToken(() => owner.chunk(file.token, 0))).toBe(true);
  });

  it("use one default session for calls that name none", async () => {
    const { owner } = setup();
    await owner.session().open("paper.pdf");
    expect(owner.session(undefined).current()?.path).toBe("paper.pdf");
    expect(owner.session("").current()?.path).toBe("paper.pdf");
    expect(owner.session("s1").current()).toBeNull();
  });

  it("drop the least recently used session and its handles beyond the limit", async () => {
    const { owner } = setup();
    const { file } = await owner.session("old").load("paper.pdf");
    await owner.session("kept").open("paper.pdf");
    for (let i = 0; i < MAX_SESSIONS - 2; i++) owner.session(`filler-${i}`);
    owner.session("kept");
    owner.session("newest");
    expect(invalidToken(() => owner.chunk(file.token, 0))).toBe(true);
    expect(owner.session("kept").current()?.path).toBe("paper.pdf");
    expect(owner.session("old").current()).toBeNull();
  });

  it("free a file handle once the panel reads its last chunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "office-sessions-"));
    roots.push(root);
    await writeFile(join(root, "big.pdf"), new Uint8Array(FILE_CHUNK_BYTES + 1));
    const { owner } = setup({ root });
    const { file } = await owner.session("s1").load("big.pdf");
    expect(file.chunks).toBe(2);
    owner.chunk(file.token, 0);
    owner.chunk(file.token, 0);
    owner.chunk(file.token, 1);
    expect(invalidToken(() => owner.chunk(file.token, 1))).toBe(true);
    expect(invalidToken(() => owner.chunk(file.token, 0))).toBe(true);
  });

  it("refuse a load whose session was dropped while the file parsed", async () => {
    let open!: () => void;
    const { owner } = setup({ gate: new Promise<void>((resolve) => (open = resolve)) });
    const loading = owner.session("old").load("paper.pdf");
    for (let i = 0; i < MAX_SESSIONS; i++) owner.session(`filler-${i}`);
    open();
    await expect(loading).rejects.toMatchObject({ code: "invalid_token" });
  });
});
