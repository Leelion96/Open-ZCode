import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface BashBackgroundLifecycleExecutionPort extends ExecutionPort {
  runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options?: ExecutionRunOptions,
  ): Promise<BashBackgroundLifecycleResult>;
}

export function supportsBashBackgroundLifecycle(
  executionPort: ExecutionPort,
): executionPort is BashBackgroundLifecycleExecutionPort {
  return (
    typeof (executionPort as Partial<BashBackgroundLifecycleExecutionPort>)
      .runBashWithBackgroundLifecycle === "function"
  );
}

/**
 * 后台任务终态等待：与上面的后台生命周期一样在 ExecutionPort 接口之外，
 * 由 executor 的后台追踪按鸭子类型探测。缺这个能力时追踪只能退回 1 秒轮询。
 */
export interface BackgroundTaskWaiterExecutionPort extends ExecutionPort {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundExecutionSnapshot | undefined>;
}

export function supportsBackgroundTaskWaiter(
  executionPort: ExecutionPort,
): executionPort is BackgroundTaskWaiterExecutionPort {
  return (
    typeof (executionPort as Partial<BackgroundTaskWaiterExecutionPort>).waitForBackgroundTask ===
    "function"
  );
}
