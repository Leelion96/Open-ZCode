import { LocalTtftRecorder } from "./contract.js";
import type { LocalTtftFacts } from "@zcode/shared";

/** 检查点复用现有协议出口，实际首输出仍由内容帧确认。 */
export function createLocalRecorder(onCheckpoint: (facts: LocalTtftFacts) => void) {
  return new LocalTtftRecorder(undefined, undefined, onCheckpoint);
}
