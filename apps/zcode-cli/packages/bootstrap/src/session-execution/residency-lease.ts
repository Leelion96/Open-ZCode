import type { SessionResidencyFinalizationOwner } from "./contract.js";
export type { SessionResidencyFinalizationOwner } from "./contract.js";

const finalizationWaiters = new WeakMap<SessionResidencyFinalizationOwner, Set<() => void>>();

/** 只等待原 record 的执行收尾；调用者须先关闭新执行准入。 */
export function waitForSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): Promise<void> {
  if (!record.residencyFinalizationCount) return Promise.resolve();
  return new Promise((resolve) => {
    let waiters = finalizationWaiters.get(record);
    if (!waiters) finalizationWaiters.set(record, (waiters = new Set()));
    waiters.add(resolve);
  });
}

/**
 * residency lease 只覆盖 Bootstrap detached runner 的收尾窗口，避免 pool 回收仍在使用的
 * record。Prompt admission 的 busy/idle authority 已归 Core；activeAbortController 仅是旧命令
 * 路径的兼容取消句柄，不能再作为 prompt 调度锁。
 */
export function acquireSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): () => void {
  record.residencyFinalizationCount = (record.residencyFinalizationCount ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.residencyFinalizationCount = Math.max(0, (record.residencyFinalizationCount ?? 1) - 1);
    if (record.residencyFinalizationCount === 0) {
      const waiters = finalizationWaiters.get(record);
      finalizationWaiters.delete(record);
      for (const resolve of waiters ?? []) resolve();
    }
  };
}

/** 同步登记 lease，再启动 detached runner；同步抛错和异步终态都保证释放。 */
export function runWithSessionResidencyFinalization<T>(
  record: SessionResidencyFinalizationOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquireSessionResidencyFinalization(record);
  try {
    return run().finally(release);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
}
