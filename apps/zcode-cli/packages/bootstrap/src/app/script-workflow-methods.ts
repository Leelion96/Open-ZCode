import type { SubmitPromptOptions, ZCodeApp } from "./types.js";
import {
  ScriptWorkflowRuntime,
  type ScriptWorkflowRuntimeDeps,
} from "./script-workflow-runtime.js";
import { createScriptWorkflowToolPort } from "./script-workflow-tool-port.js";

type ScriptWorkflowFacade = Pick<
  ZCodeApp,
  | "listScriptWorkflows"
  | "resumeWorkflowScript"
  | "runWorkflowScript"
  | "scriptWorkflowStatus"
  | "validateWorkflowScript"
>;

interface ScriptWorkflowBridge extends ScriptWorkflowFacade {
  closeScriptWorkflowRuns(): Promise<void>;
  workflowPort: ReturnType<typeof createScriptWorkflowToolPort>;
}

type ScriptWorkflowBridgeDeps = Omit<ScriptWorkflowRuntimeDeps, "runtime"> & {
  getRuntime: () => ScriptWorkflowRuntimeDeps["runtime"];
};

type ScriptWorkflowRuntimeOptions = Pick<SubmitPromptOptions, "abortSignal" | "traceContext"> & {
  onEvent?: (event: unknown) => void | Promise<void>;
};

export function createScriptWorkflowBridge(deps: ScriptWorkflowBridgeDeps): ScriptWorkflowBridge {
  let runtime: ScriptWorkflowRuntime | undefined;
  const getRuntime = () => {
    runtime ??= new ScriptWorkflowRuntime({ ...deps, runtime: deps.getRuntime() });
    return runtime;
  };
  const workflowPort = createScriptWorkflowToolPort({
    fileSystemPort: deps.fileSystemPort,
    getRuntime,
    logger: deps.logger,
    sessionId: deps.sessionId,
    sessionStore: deps.sessionStore,
    storageRoot: deps.storageRoot,
    traceContext: deps.traceContext,
    workingDirectory: deps.workingDirectory,
  });
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Workflow bridge closed");
  };
  return {
    listScriptWorkflows: (input) => getRuntime().list(input),
    resumeWorkflowScript: async (input, options) => {
      assertOpen();
      return getRuntime().resume(input, toRuntimeOptions(options));
    },
    runWorkflowScript: async (input, options) => {
      assertOpen();
      return getRuntime().run(input, toRuntimeOptions(options));
    },
    scriptWorkflowStatus: (input) => getRuntime().status(input),
    validateWorkflowScript: (input) => getRuntime().validate(input),
    workflowPort,
    async closeScriptWorkflowRuns() {
      closed = true;
      const results = await Promise.allSettled([workflowPort.close(), runtime?.close()]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Script workflow cleanup failed");
    },
  };
}

function createScriptWorkflowFacade(runtime: ScriptWorkflowRuntime): ScriptWorkflowFacade {
  return {
    listScriptWorkflows: runtime.list.bind(runtime),
    resumeWorkflowScript: async (input, options) =>
      runtime.resume(input, toRuntimeOptions(options)),
    runWorkflowScript: async (input, options) => runtime.run(input, toRuntimeOptions(options)),
    scriptWorkflowStatus: runtime.status.bind(runtime),
    validateWorkflowScript: runtime.validate.bind(runtime),
  };
}

function toRuntimeOptions(
  options: Parameters<NonNullable<ZCodeApp["runWorkflowScript"]>>[1],
): ScriptWorkflowRuntimeOptions | undefined {
  if (!options) return undefined;
  return {
    abortSignal: options.abortSignal,
    onEvent: options.onEvent as ((event: unknown) => void | Promise<void>) | undefined,
    traceContext: options.traceContext,
  };
}
