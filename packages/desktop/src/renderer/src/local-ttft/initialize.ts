import type { IPlatformService, LocalTtftRecord } from "@zcode/shared";
import { LocalTtftObserver, setLocalTtftObserver } from "@zcode/ui";

/** 本地日志默认开启；原有云端出口选择在发送开始时冻结。 */
export function initializeDesktopLocalTtft(platform: IPlatformService): () => void {
  const rendererInstanceId = crypto.randomUUID();
  let records: LocalTtftRecord[] = [];
  let sequence = 0;
  let dropped = 0;
  const observer = new LocalTtftObserver(
    (record) => {
      if (record.localOnly) return;
      if (records.length >= 128) {
        dropped++;
        return;
      }
      records.push(record);
    },
    undefined,
    undefined,
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  observer.enabled = true;
  observer.logLocally = true;
  observer.localOnly = true;
  setLocalTtftObserver(observer);
  const flush = () => {
    observer.sampleClock();
    observer.expire();
    while (records.length) {
      const batch = records.splice(0, 32);
      try {
        platform.reportLocalTtftBatch?.({
          version: 1,
          rendererInstanceId,
          sequence: sequence++,
          records: batch,
          dropped,
        });
        dropped = 0;
      } catch {
        dropped += batch.length;
      }
    }
  };
  const apply = (config: { localTtftEnabled?: boolean }) => {
    observer.localOnly = config.localTtftEnabled !== true;
  };
  void platform
    .getRendererActionTraceConfig?.()
    ?.then(apply)
    .catch(() => {});
  const off = platform.onRendererActionTraceConfigChanged?.(apply);
  const background = () => observer.background();
  const foreground = () => {
    if (document.visibilityState === "visible") observer.foreground();
  };
  const visibility = () => {
    if (document.visibilityState !== "visible") background();
    else foreground();
  };
  if (!document.hasFocus() || document.visibilityState !== "visible") background();
  window.addEventListener("blur", background);
  window.addEventListener("focus", foreground);
  document.addEventListener("visibilitychange", visibility);
  const timer = setInterval(flush, 1000);
  return () => {
    observer.interrupt();
    flush();
    records = [];
    clearInterval(timer);
    off?.();
    setLocalTtftObserver(undefined);
    window.removeEventListener("blur", background);
    window.removeEventListener("focus", foreground);
    document.removeEventListener("visibilitychange", visibility);
  };
}
