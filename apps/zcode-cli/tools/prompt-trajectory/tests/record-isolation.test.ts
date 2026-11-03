import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { PromptTrajectoryFixture } from "../src/fixture.js";
import { recordPromptTrajectoryFromFixture } from "../src/record.js";
import type { RequestEntry, TrajectoryJsonlEntry } from "../src/types.js";

// 本文件跑真实录制，与 `record` 命令一样依赖已构建的 bootstrap dist。
// 临时目录指向测试自己的沙箱：录制用的隔离家目录和工作区都落在沙箱里，结束后整体删除。

const ENV_KEYS = ["HOME", "USERPROFILE", "ZCODE_STORAGE_DIR", "TMPDIR", "TMP", "TEMP"] as const;
const ISOLATED_HOME_PREFIX = "zcode-prompt-trajectory-home-";

function fixture(overrides: Partial<PromptTrajectoryFixture> = {}): PromptTrajectoryFixture {
  return {
    name: "record-isolation",
    model: {
      apiKey: "test-key",
      apiKeyRequired: false,
      id: "mock/mock-model",
      kind: "openai-compatible",
      upstreamBaseURL: "http://127.0.0.1:9/v1",
    },
    runtimeConfig: { mode: "yolo", modelStreaming: "off" },
    mockResponses: [
      {
        id: "mock-response",
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ],
    steps: [{ type: "submitPrompt", text: "hello recorder" }],
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("prompt trajectory recording environment", () => {
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  let sandbox: string;
  let runIndex = 0;

  before(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "zcode-prompt-trajectory-record-test-"));
    for (const key of ["TMPDIR", "TMP", "TEMP"] as const) process.env[key] = sandbox;
  });

  after(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  const isolatedHomes = async () =>
    (await readdir(sandbox)).filter((name) => name.startsWith(ISOLATED_HOME_PREFIX));

  const record = async (input: PromptTrajectoryFixture) => {
    runIndex += 1;
    const outDir = join(sandbox, `out-${runIndex}`);
    await recordPromptTrajectoryFromFixture({ fixture: input, outDir });
    return outDir;
  };

  const firstRequestToolNames = async (outDir: string) => {
    const entries = (await readFile(join(outDir, "trajectory.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrajectoryJsonlEntry);
    const request = entries.find((entry): entry is RequestEntry => entry.kind === "request");
    ok(request, "录制没有写出请求");
    const tools = request.bodyWithoutMessages.tools as Array<{ function?: { name?: string } }>;
    return tools.map((tool) => tool.function?.name);
  };

  it("writes the session store under an isolated home and restores the environment afterwards", async () => {
    const home = join(sandbox, "user-home");
    const storage = join(sandbox, "user-storage");
    process.env.HOME = home;
    delete process.env.USERPROFILE;
    process.env.ZCODE_STORAGE_DIR = storage;
    const homesBefore = await isolatedHomes();

    await record(fixture());

    // 录制期间的会话库落在新建的隔离家目录，录制前的家目录和存储目录都没有被创建。
    const created = (await isolatedHomes()).filter((name) => !homesBefore.includes(name));
    equal(created.length, 1);
    ok(await exists(join(sandbox, created[0]!, ".zcode", "cli", "db", "db.sqlite")));
    equal(await exists(home), false);
    equal(await exists(storage), false);
    // 恢复原值；原来没有的变量要删掉，不能留下字符串 "undefined"。
    equal(process.env.HOME, home);
    equal(Object.hasOwn(process.env, "USERPROFILE"), false);
    equal(process.env.ZCODE_STORAGE_DIR, storage);
  });

  it("restores the environment when recording fails", async () => {
    const home = join(sandbox, "failing-home");
    const profile = join(sandbox, "failing-profile");
    process.env.HOME = home;
    process.env.USERPROFILE = profile;
    delete process.env.ZCODE_STORAGE_DIR;

    await rejects(record({ name: "missing-model", steps: [] }), /missing upstreamBaseURL/u);

    deepStrictEqual(
      [process.env.HOME, process.env.USERPROFILE, Object.hasOwn(process.env, "ZCODE_STORAGE_DIR")],
      [home, profile, false],
    );
  });

  it("exposes WebSearch only when the fixture declares native web search", async () => {
    process.env.HOME = join(sandbox, "web-search-home");

    // 能力只来自 fixture 的 modelProperties 写进 Registry 的模型声明。
    const withSearch = await firstRequestToolNames(
      await record(fixture({ modelProperties: { supportsNativeWebSearch: true } })),
    );
    const withoutSearch = await firstRequestToolNames(await record(fixture()));

    ok(withSearch.includes("WebSearch"));
    equal(withoutSearch.includes("WebSearch"), false);
    deepStrictEqual(
      withSearch.filter((name) => name !== "WebSearch"),
      withoutSearch,
    );
  });
});
