import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { WorkflowScriptDocument } from "./script-workflow-meta.js";
import { SCRIPT_WORKFLOW_CHILD_SOURCE } from "./script-workflow-child-source.js";

const WORKFLOW_CHILD_STDERR_LIMIT = 64 * 1024;

export interface ScriptWorkflowChildRequest {
  id: string;
  payload: unknown;
  type: string;
}

interface ScriptWorkflowChildEvent {
  payload: unknown;
  type: string;
}

interface ScriptWorkflowChildRunResult {
  stderr: string;
  value: unknown;
}

export async function runScriptWorkflowChild(input: {
  args?: unknown;
  budgetTotal?: number;
  document: WorkflowScriptDocument;
  handleEvent(event: ScriptWorkflowChildEvent): Promise<void> | void;
  handleRequest(request: ScriptWorkflowChildRequest): Promise<unknown>;
  signal?: AbortSignal;
  workingDirectory: string;
}): Promise<ScriptWorkflowChildRunResult> {
  input.signal?.throwIfAborted();
  const pending = new Set<Promise<void>>();
  const payload = Buffer.from(
    JSON.stringify({
      args: input.args,
      budgetTotal: input.budgetTotal,
      scriptBody: input.document.body,
      scriptUrl: pathToFileURL(input.document.path).href,
    }),
    "utf8",
  ).toString("base64url");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", SCRIPT_WORKFLOW_CHILD_SOURCE, "--", payload],
    {
      cwd: input.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";
  let completed:
    | {
        error?: string;
        ok: boolean;
        stack?: string;
        value?: unknown;
      }
    | undefined;
  let settled = false;

  const abort = (): void => {
    child.kill();
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();

  // 子进程退出与宿主 agent 收尾可并发。管道错误必须留在本 run，不能冒泡成进程级异常。
  child.stdin.on("error", (error: Error) => {
    completed = { error: error.message, ok: false };
    child.kill();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = trimStderr(stderr + chunk.toString("utf8"));
  });

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const handling = handleChildLine(line, {
      child,
      complete: (message) => {
        completed = message;
      },
      handleEvent: input.handleEvent,
      handleRequest: input.handleRequest,
    }).catch((error) => {
      completed = {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
      child.kill();
    });
    pending.add(handling);
    void handling.finally(() => pending.delete(handling));
  });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    settled = true;
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("Workflow script run cancelled");
    }
    if (!completed) {
      throw new Error(stderr || `Workflow child exited without completion: ${exitCode}`);
    }
    if (!completed.ok) {
      throw new Error(completed.error || "Workflow script failed", {
        cause: completed.stack,
      });
    }
    if (exitCode !== 0) {
      throw new Error(stderr || `Workflow child exited with code ${exitCode}`);
    }
    return {
      stderr,
      value: completed.value,
    };
  } finally {
    input.signal?.removeEventListener("abort", abort);
    if (!settled) child.kill();
    reader.close();
    // 脚本进程已退出，先前派发到宿主的 agent / journal 写入仍可能在飞。
    while (pending.size > 0) await Promise.allSettled(pending);
  }
}

async function handleChildLine(
  line: string,
  deps: {
    child: ReturnType<typeof spawn>;
    complete(message: { error?: string; ok: boolean; stack?: string; value?: unknown }): void;
    handleEvent(event: ScriptWorkflowChildEvent): Promise<void> | void;
    handleRequest(request: ScriptWorkflowChildRequest): Promise<unknown>;
  },
): Promise<void> {
  if (!line.trim()) return;
  const message = JSON.parse(line) as
    | {
        id: string;
        kind: "request";
        payload: unknown;
        type: string;
      }
    | {
        kind: "event";
        payload: unknown;
        type: string;
      }
    | {
        error?: string;
        kind: "complete";
        ok: boolean;
        stack?: string;
        value?: unknown;
      };

  if (message.kind === "event") {
    await deps.handleEvent({ payload: message.payload, type: message.type });
    return;
  }
  if (message.kind === "complete") {
    deps.complete(message);
    return;
  }

  try {
    const value = await deps.handleRequest(message);
    writeResponse(deps.child, {
      id: message.id,
      ok: true,
      value,
    });
  } catch (error) {
    writeResponse(deps.child, {
      error: error instanceof Error ? error.message : String(error),
      id: message.id,
      ok: false,
    });
  }
}

function writeResponse(
  child: ReturnType<typeof spawn>,
  message: { error?: string; id: string; ok: boolean; value?: unknown },
): void {
  if (
    child.killed ||
    child.exitCode !== null ||
    !child.stdin ||
    child.stdin.destroyed ||
    child.stdin.writableEnded
  )
    return;
  child.stdin.write(`${JSON.stringify({ kind: "response", ...message })}\n`);
}

function trimStderr(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= WORKFLOW_CHILD_STDERR_LIMIT) return value;
  return value.slice(-WORKFLOW_CHILD_STDERR_LIMIT);
}
