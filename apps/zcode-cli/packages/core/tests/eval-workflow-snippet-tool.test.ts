import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR,
  EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR,
  WORKFLOW_SOURCE_MISSING_HINT,
  EvalWorkflowSnippetInputJsonSchema,
  EvalWorkflowSnippetInputSchema,
  HookEventName,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type DynamicWorkflowSnippetEvalRequest,
  type DynamicWorkflowSnippetEvalResult,
  type DynamicWorkflowSnippetPort,
  type EvalWorkflowSnippetOutput,
} from "@zcode/contracts";
import type { HookRunner } from "../src/hooks/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { evalWorkflowSnippetToolEntry } from "../src/tool/handlers/eval-workflow-snippet.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

/** 端口 fake：记录请求、按脚本回结果。编译与执行的真实链路在 bootstrap 的 service 测试里。 */
function stubPort(result: DynamicWorkflowSnippetEvalResult): {
  port: DynamicWorkflowSnippetPort;
  requests: DynamicWorkflowSnippetEvalRequest[];
} {
  const requests: DynamicWorkflowSnippetEvalRequest[] = [];
  return {
    requests,
    port: {
      async evalSnippet(request) {
        requests.push(request);
        return result;
      },
    },
  };
}

function makeContext(port?: DynamicWorkflowSnippetPort): ToolExecutionContext {
  return {
    ...(port === undefined ? {} : { dynamicWorkflowSnippetPort: port }),
    workingDirectory: "/tmp/snippet-test",
    traceId: "trace-1",
    sessionId: "sess_test",
  } as unknown as ToolExecutionContext;
}

async function run(input: unknown, context: ToolExecutionContext): Promise<EvalWorkflowSnippetOutput> {
  return (await evalWorkflowSnippetToolEntry.handler(input, context)) as EvalWorkflowSnippetOutput;
}

describe("EvalWorkflowSnippet tool", () => {
  it("is registered by default via registerBuiltInTools", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    expect(registry.has("EvalWorkflowSnippet")).toBe(true);
  });

  it("fails honestly when the port is absent (nothing pretends to execute)", async () => {
    const output = await run({ code: "return 1;" }, makeContext());
    expect(output.ok).toBe(false);
    expect(output.response).toContain("NOT executed");
    expect(output.response).toContain("not available");
  });

  it("passes code, session cwd and the default 60s timeout to the port", async () => {
    const { port, requests } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    await run({ code: "return 1;" }, makeContext(port));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.code).toBe("return 1;");
    expect(requests[0]?.cwd).toBe("/tmp/snippet-test");
    expect(requests[0]?.timeoutMs).toBe(60_000);
  });

  it("honours an explicit timeoutMs within schema bounds", async () => {
    const { port, requests } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    await run({ code: "return 1;", timeoutMs: 600_000 }, makeContext(port));
    expect(requests[0]?.timeoutMs).toBe(600_000);
  });

  it("rejects timeoutMs beyond the 600s schema ceiling", async () => {
    const { port } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    await expect(run({ code: "return 1;", timeoutMs: 900_000 }, makeContext(port))).rejects.toThrow();
  });

  it("renders diagnostics with the NOT-executed note", async () => {
    const { port } = stubPort({
      kind: "diagnostics",
      diagnostics: [{ code: 2304, column: 14, line: 1, message: "Cannot find name 'agent'." }],
    });
    const output = await run({ code: `await agent("x")` }, makeContext(port));
    expect(output.ok).toBe(false);
    expect(output.diagnostics).toHaveLength(1);
    expect(output.response).toContain("L1:C14 Cannot find name 'agent'.");
    expect(output.response).toContain("NOT executed");
  });

  it("renders the artifact and logs on success", async () => {
    const { port } = stubPort({
      kind: "completed",
      artifact: { files: ["a.ts"], count: 1 },
      logs: ["saw 1"],
      logsTruncated: false,
    });
    const output = await run({ code: "return x;" }, makeContext(port));
    expect(output.ok).toBe(true);
    expect(output.response).toContain("Return value:");
    expect(output.response).toContain('"a.ts"');
    expect(output.response).toContain("- saw 1");
    expect(output.logs).toEqual(["saw 1"]);
  });

  it("says so when the snippet returned no value", async () => {
    const { port } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    const output = await run({ code: 'log("hi");' }, makeContext(port));
    expect(output.ok).toBe(true);
    expect(output.response).toContain("returned no value");
  });

  it("renders structured failures with the stable code, keeping logs", async () => {
    const { port } = stubPort({
      kind: "failed",
      error: { code: "WorldReadCapExceeded", message: "files.grep over cap" },
      logs: ["before the failure"],
      logsTruncated: true,
    });
    const output = await run({ code: "…" }, makeContext(port));
    expect(output.ok).toBe(false);
    expect(output.response).toContain("(WorldReadCapExceeded)");
    expect(output.response).toContain("- before the failure");
    expect(output.response).toContain("logs truncated");
  });
});

// docs/dynamic-workflow/launch.md「Script files」→「The `path` source」：片段的第二条来源。
// 整个文件就是代码（不解析元数据块），诊断按文件行报。
describe("EvalWorkflowSnippet — the `path` source", () => {
  const validate = (input: unknown) => evalWorkflowSnippetToolEntry.validateInput!(input, {});
  const resolve = async (input: unknown, cwd: string) =>
    await evalWorkflowSnippetToolEntry.resolveInput!(input, { workingDirectory: cwd });

  it("refuses a call giving both sources, and one giving neither", () => {
    expect(validate({ code: "return 1;", path: "a.ts" })).toMatchObject({ result: false });
    expect(validate({})).toMatchObject({ result: false });
    expect(validate({ code: "return 1;" })).toEqual({ result: true });
    expect(validate({ path: "a.ts" })).toEqual({ result: true });
  });

  // 两种违规原因不同，文案也必须不同：「没给」多半是参数 JSON 没解析出来、被 adapter 恢复成 `{}`，
  // 写了 `code` 的模型读到「两个都给或都没给」只会原样重发同一个坏调用。
  it("tells both sources apart from none", () => {
    expect(validate({ code: "return 1;", path: "a.ts" })).toMatchObject({
      message: EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR,
    });
    for (const input of [{}, { timeoutMs: 5_000 }]) {
      expect(validate(input)).toMatchObject({
        message: EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR,
      });
    }
  });

  it("explains on a missing source that a call which does not parse arrives empty", () => {
    expect(EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR).toContain(WORKFLOW_SOURCE_MISSING_HINT);
    expect(WORKFLOW_SOURCE_MISSING_HINT).toContain("not valid JSON");
    expect(WORKFLOW_SOURCE_MISSING_HINT).toContain("`path`");
    expect(EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR).not.toContain("JSON");
  });

  it("reads the file whole as `code`, metadata block included", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dwf-snippet-path-"));
    try {
      // 恰好以起始标记开头的文件也整个是代码：片段没有保存定义那套语义。
      const source = '/* zcode-workflow\ndescription: not a workflow\n*/\nreturn 1;';
      writeFileSync(join(cwd, "snippet.ts"), source, "utf8");
      const resolution = await resolve({ path: "snippet.ts" }, cwd);
      expect(resolution).toMatchObject({ result: true });
      const input = (resolution as { input: Record<string, unknown> }).input;
      expect(input.code).toBe(source);
      expect(input.path).toBe(join(cwd, "snippet.ts"));
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("names the file when it cannot be read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dwf-snippet-path-"));
    try {
      const resolution = await resolve({ path: "missing.ts" }, cwd);
      expect(resolution).toMatchObject({ result: false });
      expect((resolution as { message: string }).message).toContain("missing.ts could not be read");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("prefixes diagnostics with the file when the snippet came from one", async () => {
    const { port } = stubPort({
      kind: "diagnostics",
      diagnostics: [{ code: 2304, column: 14, line: 1, message: "Cannot find name 'agent'." }],
    });
    const context = makeContext(port);
    const output = await run(
      { code: `await agent("x")`, path: join(context.workingDirectory, "snippet.ts") },
      context,
    );
    expect(output.response).toContain("snippet.ts:L1:C14 Cannot find name 'agent'.");
  });
});

describe("EvalWorkflowSnippet approval gate (world.run)", () => {
  const gate = (input: unknown) => evalWorkflowSnippetToolEntry.prepareApproval!(input);

  it("proceeds silently for a pure read snippet", () => {
    expect(gate({ code: `return await files.glob("*.ts");` })).toEqual({ gate: "proceed" });
  });

  it("asks when the snippet carries world.run commands", () => {
    expect(gate({ code: `const r = await world.run("lean", ["a.lean"]); return r.exitCode;` })).toEqual({
      gate: "ask",
    });
  });

  it("proceeds for invalid input and for snippets that do not compile", () => {
    // handler / 端口负责把这两种失败变成可读的诊断；打断用户批准一段编不过的代码没有意义。
    expect(gate({ notCode: true })).toEqual({ gate: "proceed" });
    expect(gate({ code: `await agent("x").ask("y");` })).toEqual({ gate: "proceed" });
    expect(gate({ code: `const c = "node"; await world.run(c, []);` })).toEqual({ gate: "proceed" });
  });

  it("stays a standard-permission tool: no alwaysAsk, no always-allow suppression", () => {
    // 2026-08-26 复议（docs/dynamic-workflow/authoring.md「EvalWorkflowSnippet」）：alwaysAsk 只属于
    // CreateWorkflow——load-bearing 且昂贵。snippet 按标准模式 / 规则流程裁决。
    expect(evalWorkflowSnippetToolEntry.permission.alwaysAsk).toBeUndefined();
    expect(evalWorkflowSnippetToolEntry.permission.askOptions).toBeUndefined();
  });
});

// 归一化后 `script` 恒等于 `code`（docs/dynamic-workflow/authoring.md「EvalWorkflowSnippet」）：
// 另外三个提交脚本的工具字段都叫 `script`，一条只读 `tool_input.script` 的 PreToolUse hook
// 原先在这里读不到任何东西，片段就绕开了它。
describe("EvalWorkflowSnippet — `script` mirrors `code` after resolution", () => {
  const resolve = async (input: unknown, cwd: string) =>
    await evalWorkflowSnippetToolEntry.resolveInput!(input, { workingDirectory: cwd });
  const resolvedInput = (resolution: unknown) =>
    (resolution as { input: Record<string, unknown> }).input;

  it("adds `script` for an inline snippet", async () => {
    const resolution = await resolve({ code: "return 1;" }, "/tmp/snippet-test");
    expect(resolution).toMatchObject({ result: true });
    expect(resolvedInput(resolution)).toEqual({ code: "return 1;", script: "return 1;" });
  });

  it("adds `script` for a snippet read from a file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dwf-snippet-script-"));
    try {
      writeFileSync(join(cwd, "snippet.ts"), "return 2;", "utf8");
      const input = resolvedInput(await resolve({ path: "snippet.ts" }, cwd));
      expect(input.code).toBe("return 2;");
      expect(input.script).toBe("return 2;");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("overwrites a `script` the model supplied: it is a resolution result, not a parameter", async () => {
    const input = resolvedInput(
      await resolve({ code: "return 1;", script: "return 2;" }, "/tmp/x"),
    );
    expect(input.script).toBe("return 1;");
  });

  it("keeps `script` off the model-facing schema, and the runtime schema accepts it", () => {
    const properties = (EvalWorkflowSnippetInputJsonSchema as { properties?: object }).properties;
    expect(Object.keys(properties ?? {}).sort()).toEqual(["code", "path", "timeoutMs"]);
    expect(
      EvalWorkflowSnippetInputSchema.safeParse({ code: "return 1;", script: "return 1;" }).success,
    ).toBe(true);
  });

  it("gives PreToolUse hooks the snippet as `script`, as for the other workflow tools", async () => {
    const seen: unknown[] = [];
    const hookRunner: HookRunner = {
      async run(input) {
        if (input.hookEventName === HookEventName.PreToolUse) {
          seen.push((input as unknown as { toolInput?: unknown }).toolInput);
        }
        return { additionalContexts: [] };
      },
    };
    const { port, requests } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    const sessionId = createSessionId("eval-snippet-hook");
    const turnId = createTurnId("eval-snippet-hook");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register(evalWorkflowSnippetToolEntry);
    const executor = createToolExecutor({
      dynamicWorkflowSnippetPort: port,
      emitEvent: async () => {},
      hookRunner,
      mode: "yolo",
      permissionBroker: {
        async requestPermission() {
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workingDirectory: "/tmp/snippet-test",
    });

    const result = await executor.execute(
      {
        id: createToolCallId("eval-snippet-hook"),
        input: { code: "return 1;" },
        name: "EvalWorkflowSnippet",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { script?: string }).script).toBe("return 1;");
    expect(requests[0]?.code).toBe("return 1;");
  });
});

// 参数不是合法 JSON 时，adapter 记 `model.tool_input.normalize_failed` 并把调用恢复成 `{}`
// （adapters/src/model/tool-input-normalization.ts）；本工具字段全可选，`{}` 能过 schema。
// 这条从 executor 走一遍：拿到的必须是「没给来源」那句带解析提示的话，且什么都没执行。
describe("EvalWorkflowSnippet — a call whose arguments did not parse", () => {
  it("answers the recovered empty input with the missing-source hint, before hooks and the port", async () => {
    const hookEvents: string[] = [];
    const hookRunner: HookRunner = {
      async run(input) {
        hookEvents.push(input.hookEventName);
        return { additionalContexts: [] };
      },
    };
    const { port, requests } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    const sessionId = createSessionId("eval-snippet-empty");
    const turnId = createTurnId("eval-snippet-empty");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register(evalWorkflowSnippetToolEntry);
    const executor = createToolExecutor({
      dynamicWorkflowSnippetPort: port,
      emitEvent: async () => {},
      hookRunner,
      mode: "yolo",
      permissionBroker: {
        async requestPermission() {
          return { decision: "allow" as const };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
      workingDirectory: "/tmp/snippet-test",
    });

    const result = await executor.execute(
      { id: createToolCallId("eval-snippet-empty"), input: {}, name: "EvalWorkflowSnippet" },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR);
    expect(hookEvents).not.toContain(HookEventName.PreToolUse);
    expect(requests).toHaveLength(0);
  });
});
