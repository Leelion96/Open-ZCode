import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NodeReplRequestMeta } from "@zcode/core/repl";

const SAME_CALL_FIRST_HINT = 5;
const NO_PROGRESS_FIRST_HINT = 10;
const STREAK_HINT_GROWTH = 3;
const CALL_VOLUME_HINTS = [30, 80, 200];
const CALL_VOLUME_HINT_INTERVAL = 200;
const END_TURN_PERMISSION = "You may end this turn.";

export type NoProgressHintKind = "same_call" | "no_progress" | "call_volume";

export interface NoProgressHint {
  kind: NoProgressHintKind;
  count: number;
  text: string;
}

export interface NoProgressGuard {
  observe(input: {
    requestMeta: NodeReplRequestMeta;
    code: string;
    result: CallToolResult;
  }): NoProgressHint | undefined;
}

interface TurnProgress {
  turnId: string;
  calls: number;
  codeHash?: string;
  codeStreak: number;
  resultHash?: string;
  resultStreak: number;
}

// js 永不因「没有进展」而失败，弱模型会在一个 turn 内反复调用直到额度耗尽；core 的重复调用提醒按完整
// input 计签名，模型改一个字符就重置。这里补上「结果没变」这个维度。文案只授权结束、不要求换做法：
// 现场模型已在反复写「本轮结束」，换做法式文案只会把它推回去继续调用。
export function createNoProgressGuard(): NoProgressGuard {
  const turns = new Map<string, TurnProgress>();
  return {
    observe({ requestMeta, code, result }) {
      const sessionId = requestMeta.session_id;
      const turnId = requestMeta.turn_id;
      if (typeof sessionId !== "string" || typeof turnId !== "string" || !turnId) return undefined;

      let turn = turns.get(sessionId);
      if (!turn || turn.turnId !== turnId) {
        turn = { turnId, calls: 0, codeStreak: 0, resultStreak: 0 };
        turns.set(sessionId, turn);
      }

      const codeHash = digest(code);
      const resultHash = digest(
        JSON.stringify({ content: result.content, isError: result.isError === true }),
      );
      turn.calls += 1;
      turn.codeStreak = turn.codeHash === codeHash ? turn.codeStreak + 1 : 1;
      turn.resultStreak = turn.resultHash === resultHash ? turn.resultStreak + 1 : 1;
      turn.codeHash = codeHash;
      turn.resultHash = resultHash;

      if (isStreakHint(turn.codeStreak, SAME_CALL_FIRST_HINT)) {
        return hint("same_call", turn.codeStreak, `Same call ×${turn.codeStreak}.`);
      }
      if (isStreakHint(turn.resultStreak, NO_PROGRESS_FIRST_HINT)) {
        return hint("no_progress", turn.resultStreak, `No progress ×${turn.resultStreak}.`);
      }
      if (isCallVolumeHint(turn.calls)) {
        return hint("call_volume", turn.calls, `${turn.calls} calls this turn.`);
      }
      return undefined;
    },
  };
}

function hint(kind: NoProgressHintKind, count: number, reason: string): NoProgressHint {
  return { kind, count, text: `[node_repl] ${reason} ${END_TURN_PERMISSION}` };
}

function isStreakHint(streak: number, first: number): boolean {
  let milestone = first;
  while (milestone < streak) milestone *= STREAK_HINT_GROWTH;
  return milestone === streak;
}

function isCallVolumeHint(calls: number): boolean {
  const last = CALL_VOLUME_HINTS[CALL_VOLUME_HINTS.length - 1] ?? CALL_VOLUME_HINT_INTERVAL;
  if (calls <= last) return CALL_VOLUME_HINTS.includes(calls);
  return calls % CALL_VOLUME_HINT_INTERVAL === 0;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
