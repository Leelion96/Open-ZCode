import {
  SessionLifecycleError,
  type SessionLifecycle,
  type SessionLifecycleHost,
  type SessionLifecycleOperation,
  type SessionLifecycleSnapshot,
  type SessionLifecycleState,
} from "./contract.js";

interface Entry {
  snapshot: SessionLifecycleSnapshot;
  flight?: { operation: SessionLifecycleOperation; promise: Promise<void> };
  restartAfterStartup?: Promise<void>;
}

/** 每个 session 一个操作所有者，覆盖初始化、部分失败清理及完整重启区间。 */
export class SessionLifecycleController implements SessionLifecycle {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly host: SessionLifecycleHost) {}

  isStopping(sessionId: string): boolean {
    return this.entries.get(sessionId)?.snapshot.state === "stopping";
  }

  /** 同步准入事实；仅供协议/回收适配器使用，不查询或启动持久会话。 */
  isReady(sessionId: string): boolean {
    return (
      !this.entries.get(sessionId)?.restartAfterStartup &&
      (this.entries.get(sessionId)?.snapshot.state ?? this.initialSnapshot(sessionId).state) ===
        "ready"
    );
  }

  async getState(sessionId: string): Promise<SessionLifecycleSnapshot> {
    await this.assertExists(sessionId);
    const snapshot = this.entries.get(sessionId)?.snapshot ?? this.initialSnapshot(sessionId);
    return { ...snapshot, lastError: snapshot.lastError ? { ...snapshot.lastError } : null };
  }

  ensureReady(sessionId: string): Promise<void> {
    const entry = this.entry(sessionId);
    if (entry.restartAfterStartup) return entry.restartAfterStartup;
    if (!entry.flight && entry.snapshot.state === "ready") {
      return this.run(sessionId, "ensureReady", () => this.assertExists(sessionId));
    }
    return this.initialize(sessionId, async () => {
      await this.assertExists(sessionId);
      await this.host.activate(sessionId);
    });
  }

  /** 产品 create/fork/resume 的内部装配入口；调用方负责其存在性规则。 */
  initialize(sessionId: string, activate: () => Promise<void>): Promise<void> {
    const entry = this.entry(sessionId);
    if (entry.flight?.operation === "stop") {
      return entry.flight.promise.then(() => this.initialize(sessionId, activate));
    }
    return this.run(sessionId, "ensureReady", async () => {
      if (entry.snapshot.state === "ready") return;
      await this.activate(sessionId, activate);
    });
  }

  stop(sessionId: string): Promise<void> {
    return this.run(sessionId, "stop", async () => {
      await this.assertExists(sessionId);
      this.host.assertCanStop(sessionId);
      await this.release(sessionId, () => this.host.release(sessionId));
    });
  }

  restart(sessionId: string): Promise<void> {
    const entry = this.entry(sessionId);
    if (entry.restartAfterStartup) return entry.restartAfterStartup;
    if (entry.flight?.operation === "ensureReady") {
      // 初始化尚未支持硬取消时等待其安全收口；同时关闭 ready 准入，不能并行创建实例。
      const afterStartup = () => {
        entry.restartAfterStartup = undefined;
        return this.restart(sessionId);
      };
      entry.restartAfterStartup = entry.flight.promise.then(afterStartup, afterStartup);
      return entry.restartAfterStartup;
    }
    return this.run(sessionId, "restart", async () => {
      await this.assertExists(sessionId);
      this.host.assertCanStop(sessionId);
      // history-first 可以只有 publisher 没有实例；重启仍必须完整失效旧发布链路。
      await this.release(sessionId, () => this.host.release(sessionId));
      await this.activate(sessionId, () => this.host.activate(sessionId));
    });
  }

  /** 已有关闭/删除/进程退出策略使用的内部入口；策略预检必须先由调用方完成。 */
  dispose(sessionId: string, release = () => this.host.release(sessionId)): Promise<void> {
    return this.run(sessionId, "stop", async () => {
      if (this.entry(sessionId).snapshot.state === "unloaded") return;
      await this.release(sessionId, release);
    });
  }

  private run(
    sessionId: string,
    operation: SessionLifecycleOperation,
    work: () => Promise<void>,
  ): Promise<void> {
    const entry = this.entry(sessionId);
    // 重启等待旧启动时已保留操作资格；旧启动的先注册回调不能抢先 stop。
    if (entry.restartAfterStartup && operation === "stop") {
      return Promise.reject(
        new SessionLifecycleError("conflict", "Session lifecycle restart is pending"),
      );
    }
    if (entry.flight) {
      if (
        entry.flight.operation === operation ||
        (operation === "ensureReady" && entry.flight.operation === "restart")
      ) {
        return entry.flight.promise;
      }
      return Promise.reject(
        new SessionLifecycleError(
          "conflict",
          `Session lifecycle ${entry.flight.operation} is in progress`,
        ),
      );
    }
    if (entry.snapshot.state === "faulted") {
      return Promise.reject(
        new SessionLifecycleError(
          "recoveryRequired",
          "Session runtime requires workspace process recovery",
        ),
      );
    }
    const deferred = Promise.withResolvers<void>();
    const flight = { operation, promise: deferred.promise };
    // 先登记，再调用宿主：同步重入和 restart 的 unloaded 间隙不能抢占此操作。
    entry.flight = flight;
    entry.snapshot.lastError = null;
    void work().then(
      () => {
        entry.flight = undefined;
        // 保留轻量版本事实，避免 stop/reopen 后迟到状态拥有更大的 revision。
        deferred.resolve();
      },
      (error: unknown) => {
        entry.snapshot.lastError = {
          operation,
          code:
            error instanceof SessionLifecycleError
              ? error.code
              : entry.snapshot.state === "faulted"
                ? "resourceReleaseFailed"
                : "operationFailed",
          message: error instanceof Error ? error.message : String(error),
        };
        entry.flight = undefined;
        this.publish(entry);
        deferred.reject(error);
      },
    );
    return deferred.promise;
  }

  private async activate(sessionId: string, activate: () => Promise<void>): Promise<void> {
    this.entry(sessionId).snapshot.generation += 1;
    this.transition(sessionId, "starting");
    try {
      await activate();
      this.transition(sessionId, "ready");
    } catch (error) {
      try {
        await this.release(sessionId, () => this.host.release(sessionId, true));
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Session initialization and cleanup failed",
        );
      }
      throw error;
    }
  }

  private async release(sessionId: string, release: () => Promise<void>): Promise<void> {
    this.transition(sessionId, "stopping");
    try {
      await release();
      this.transition(sessionId, "unloaded");
    } catch (error) {
      // 失败/超时并非释放成功。保留隔离状态，迟到回调也不能复活下一实例。
      this.transition(sessionId, "faulted");
      throw error;
    }
  }

  private transition(sessionId: string, state: SessionLifecycleState): void {
    const entry = this.entry(sessionId);
    entry.snapshot.state = state;
    this.publish(entry);
  }

  private publish(entry: Entry): void {
    entry.snapshot.revision += 1;
    this.host.onChange?.({ ...entry.snapshot });
  }

  private initialSnapshot(sessionId: string): SessionLifecycleSnapshot {
    return {
      sessionId,
      state: this.host.hasRuntime(sessionId) ? "ready" : "unloaded",
      generation: 0,
      revision: 0,
      lastError: null,
    };
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { snapshot: this.initialSnapshot(sessionId) };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private async assertExists(sessionId: string): Promise<void> {
    if (!(await this.host.exists(sessionId))) {
      throw new SessionLifecycleError("sessionNotFound", `Session not found: ${sessionId}`);
    }
  }
}
