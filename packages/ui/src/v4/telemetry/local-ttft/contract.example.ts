import { LocalTtftObserver } from "./contract.js";
import type { LocalTtftRecord } from "@zcode/shared";

/** 桌面本地观测默认不进入云端出口。 */
export function createLocalObserver(onRecord: (record: LocalTtftRecord) => void) {
  const observer = new LocalTtftObserver(onRecord);
  observer.enabled = true;
  observer.localOnly = true;
  return observer;
}
