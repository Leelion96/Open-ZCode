interface RetainedPage {
  visible: boolean;
  busy(): boolean;
  running(): boolean;
  suspend(): Promise<boolean>;
}

const BACKGROUND_LIMIT = 4;
const INACTIVE_MS = 30 * 60_000;

/** 只管理显式声明的 MCP 页面；不接管共享容量或 Gen UI 的五分钟回收。 */
export class PluginUiBackgroundRetention<T extends RetainedPage> {
  private readonly pages = new Map<T, number>();
  private readonly pending = new Set<T>();
  private cancelTimer: (() => void) | undefined;
  private evaluating = false;
  private changedDuringEvaluation = false;
  private windowVisible = true;

  constructor(
    private readonly timer: (run: () => void, ms: number) => () => void,
    private readonly now: () => number = Date.now,
  ) {}

  register(page: T): void {
    if (!this.pages.has(page)) this.pages.set(page, this.now());
    this.changed();
  }
  release(page: T): void {
    this.pages.delete(page);
    this.pending.delete(page);
    this.changed();
  }
  activity(page: T): void {
    if (this.pages.has(page)) this.pages.set(page, this.now());
    this.changed();
  }
  setWindowVisible(visible: boolean): void {
    if (this.windowVisible === visible) return;
    // 可见期间不累计闲置时间；最小化从当前时刻开始计时。
    for (const page of this.pages.keys()) if (page.visible) this.pages.set(page, this.now());
    this.windowVisible = visible;
    this.changed();
  }
  canRecycle(page: T): boolean {
    const lastActive = this.pages.get(page);
    if (lastActive === undefined) return true;
    return (
      this.background().length > BACKGROUND_LIMIT &&
      !(this.windowVisible && page.visible) &&
      !page.busy() &&
      this.now() - lastActive >= INACTIVE_MS
    );
  }
  claim(page: T): boolean {
    if (!this.pages.has(page)) return true;
    if (this.pending.has(page) || !this.canRecycle(page)) return false;
    // 五分钟定时器和忙闲回调也会请求回收；先预占名额再等 Agent，避免同时淘汰到四页以下。
    this.pending.add(page);
    return true;
  }
  finish(page: T): void {
    this.pending.delete(page);
  }
  changed(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.evaluating) {
      this.changedDuringEvaluation = true;
      return;
    }
    this.evaluating = true;
    // 合并同一轮可见性/忙闲变化；回收前读取最终状态，不在事件回调中重入页面释放。
    void Promise.resolve().then(async () => {
      try {
        for (const [page] of this.background().sort((a, b) => a[1] - b[1])) {
          if (!this.pages.has(page) || !page.running() || !this.canRecycle(page)) continue;
          await page.suspend().catch(() => false);
        }
      } finally {
        this.evaluating = false;
        if (this.changedDuringEvaluation) {
          this.changedDuringEvaluation = false;
          this.changed();
        } else this.schedule();
      }
    });
  }
  private background(): [T, number][] {
    return [...this.pages].filter(
      ([page]) =>
        page.running() && !this.pending.has(page) && !(this.windowVisible && page.visible),
    );
  }
  private schedule(): void {
    const background = this.background();
    if (background.length <= BACKGROUND_LIMIT) return;
    const remaining = background
      .filter(([page]) => !page.busy())
      .map(([, lastActive]) => lastActive + INACTIVE_MS - this.now())
      .filter((ms) => ms > 0);
    // 到期但被 Agent 拒绝的候选等待下一次状态事件，不能用零延时循环重试。
    if (remaining.length)
      this.cancelTimer = this.timer(() => this.changed(), Math.min(...remaining));
  }
}
