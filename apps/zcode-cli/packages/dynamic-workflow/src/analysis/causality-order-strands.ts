import ts from "typescript";
import { isGlobalLibValue } from "./callbacks.js";
import { boundIdentifiers } from "./causality-order-functions.js";
import type { TraceState } from "./causality-order-state.js";

// 走查原本只有一个全局 `settled` 集合，于是内联的 `async` 体里的 `await` 会替整个
// 脚本把 step 结算掉——把 `A ∥ B → C` 压成一条串行时间线。改成「每条 strand 一个 frame」之后，记账（strand 记录、frame 栈、被 await 的
// 位置扫描、join 解析）本该落在 -state / -settle 两个兄弟模块，但它们已经贴着 oxlint
// max-lines 上限（400 行），所以单开本文件。这里只读写 {@link TraceState}，不递归进 walk；
// 公开面仍从 causality-order.ts 导出。

/**
 * One open activation's settled set. The root body is the first frame and is never a
 * strand; every strand pushes one more. A step is settled FROM A FRAME'S VIEW when some
 * frame on the stack holds it — which is the whole of the fix: a barrier inside a strand
 * no longer settles anything for the spawner, because the spawner's frame is below it and
 * the strand's frame is popped when the strand closes.
 */
export interface Frame {
  readonly region: string;
  readonly settled: Set<string>;
  /** The strand this frame belongs to; absent on the root frame. */
  readonly strand?: StrandRecord;
}

/** One strand the walk spawned, in spawn order. */
export interface StrandRecord {
  /** The `call` / `fanout` region that IS the strand. */
  readonly region: string;
  /**
   * Spawn order: this record's own index in `state.strands`. A barrier joins every strand
   * with `at >= the count it saw when it took its mark`, which is "spawned while the
   * operand was evaluated". Deliberately NOT an event index: a strand that emits no event
   * before the await inside it would then tie with that await's mark, and the barrier
   * would join the very strand it stands in (`await ask()` as the first statement of an
   * `async` helper settled the helper's own summary into its own frame).
   */
  readonly at: number;
  /** Steps issued inside it (the innermost open strand at each issue) — the lift rule. */
  readonly issued: Set<string>;
  /** What the strand itself awaited: its frame's settled set at close. */
  summary: ReadonlySet<string>;
  /** False until the body finished. Only a CLOSED strand can be lifted. */
  closed: boolean;
}

/** The awaited expression a barrier stands over, with the strand count it started at. */
export interface AwaitedOperand {
  /** `state.strands.length` where the operand's evaluation began. */
  mark: number;
  operand: ts.Expression;
}

/** The frame a fresh settle lands in: the innermost open one. */
export function currentFrame(state: TraceState): Frame {
  return state.frames[state.frames.length - 1] as Frame;
}

/** True iff some frame on the stack has settled `step` — the freshness test. */
export function isVisiblySettled(state: TraceState, step: string): boolean {
  return state.frames.some((frame) => frame.settled.has(step));
}

// 修复原因：下面几处查找原本都线性扫 `state.strands`——找最内层的开着的 strand、
// 找某个 mark 之后开的 strand、按 region 找 summary、找可被提升（lift）的 strand——
// 每次 issue / await 都扫一遍目前开过的所有 strand，走查时间是 trace 长度的平方
// （80 个 helper 串成链、800 处调用时走查 16 秒）。strand 严格按嵌套开闭（walk 递归），
// 所以开着的 strand 就是 frame 栈；其余改成索引，结果与原扫描逐项相同。

/** The strand an `issue` belongs to: the innermost one still being walked. */
export function innermostOpenStrand(state: TraceState): StrandRecord | undefined {
  return currentFrame(state).strand;
}

/**
 * Record that `step` was issued inside the innermost open strand, and index the strand
 * under the step for the LIFT rule in {@link joinStrands}.
 */
export function noteIssuedInStrand(state: TraceState, step: string): void {
  const record = innermostOpenStrand(state);
  if (record === undefined) return;
  record.issued.add(step);
  const set = state.strandsByStep.get(step) ?? new Set<StrandRecord>();
  set.add(record);
  state.strandsByStep.set(step, set);
}

/** Spawn a strand on `region`: record it and push its frame. */
export function openStrand(state: TraceState, region: string): StrandRecord {
  const record: StrandRecord = {
    at: state.strands.length,
    closed: false,
    issued: new Set<string>(),
    region,
    summary: new Set<string>(),
  };
  state.strands.push(record);
  if (!state.strandByRegion.has(region)) state.strandByRegion.set(region, record);
  state.frames.push({ region, settled: new Set<string>(), strand: record });
  return record;
}

/** What the first strand spawned on `region` awaited (empty if none was). */
export function strandSummary(state: TraceState, region: string): ReadonlySet<string> {
  return state.strandByRegion.get(region)?.summary ?? new Set<string>();
}

/** Close a strand: pop its frame and keep what it awaited as the strand's summary. */
export function closeStrand(state: TraceState, record: StrandRecord): void {
  const frame = state.frames.pop();
  record.summary = frame?.settled ?? new Set<string>();
  record.closed = true;
}

/** The walk's strand counter: the mark a caller takes before evaluating an expression. */
export function strandMark(state: TraceState): number {
  return state.strands.length;
}

/** Strand regions spawned at or after `mark`, in spawn order. */
export function strandsSince(state: TraceState, mark: number): string[] {
  // `at` is the record's index, so the records at or after `mark` are a suffix.
  return state.strands.slice(mark).map((record) => record.region);
}

/**
 * Bind strand regions to the identifiers a declaration or assignment introduces — the
 * syntactic half of the join, the exact shape `bindSteps` gives steps and for the same
 * reason: `const work = ids.map(async …)` issues nothing at the declaration, so only the
 * binding can tell a later `await Promise.all(work)` which strands `work` stands for.
 */
export function bindStrands(
  state: TraceState,
  name: ts.BindingName,
  regions: readonly string[],
): void {
  if (regions.length === 0) return;
  for (const identifier of boundIdentifiers(name)) {
    const symbol = state.checker.getSymbolAtLocation(identifier);
    if (symbol === undefined) continue;
    const set = state.strandsBySymbol.get(symbol) ?? new Set<string>();
    for (const region of regions) set.add(region);
    state.strandsBySymbol.set(symbol, set);
  }
}

/** True iff the applied function carries the `async` modifier — what makes a body a strand. */
export function isAsyncFunction(decl: ts.Node): boolean {
  const { modifiers } = decl as { modifiers?: ts.NodeArray<ts.ModifierLike> };
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/** The promise combinators that adopt each argument, so each argument is an awaited position. */
const COMBINATORS: ReadonlySet<string> = new Set(["all", "allSettled", "race", "any"]);

function isPromiseCombinator(state: TraceState, node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !COMBINATORS.has(callee.name.text)) return false;
  return isGlobalLibValue(callee.expression, "Promise", state.checker, state.program);
}

/**
 * The identifiers in an AWAITED POSITION of an awaited expression: the operand itself,
 * each argument of `Promise.all` / `allSettled` / `race` / `any`, each element of an array
 * literal, a spread's operand, and through parentheses and type assertions. Every other
 * expression is OPAQUE — this mirrors how the runtime adopts promises, and it is what
 * keeps `await f(aWork.length)` from joining the strands `aWork` holds.
 */
function awaitedIdentifiers(state: TraceState, operand: ts.Expression): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const scan = (node: ts.Expression): void => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSpreadElement(node)
    ) {
      scan(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      out.push(node);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) scan(element);
      return;
    }
    if (ts.isCallExpression(node) && isPromiseCombinator(state, node)) {
      for (const argument of node.arguments) scan(argument);
    }
  };
  scan(operand);
  return out;
}

/**
 * The strands a barrier waits for, split by the certainty each one's summary settles with,
 * and MARKED JOINED so a second await of the same promise adds nothing (exactly as a
 * second settle of one step already does).
 *
 * Two ways in. SYNTACTIC — spawned while the operand was evaluated, or bound to an
 * identifier in an awaited position of it — settles the summary certainly: the await
 * provably waits for that activation. LIFTED — a closed, not-yet-joined strand one of whose
 * issued steps this barrier claims — settles it with the certainty the claim came in with:
 * the promise reached the await through a container or a helper, and all we know is that
 * something the strand issued has settled.
 */
export function joinStrands(
  state: TraceState,
  certain: readonly string[],
  maybe: readonly string[],
  awaited: AwaitedOperand | undefined,
): { certain: string[]; maybe: string[] } {
  const joins: { certain: string[]; maybe: string[] } = { certain: [], maybe: [] };
  const take = (region: string, side: string[]): void => {
    if (state.joined.has(region)) return;
    state.joined.add(region);
    side.push(region);
  };
  if (awaited !== undefined) {
    for (const region of strandsSince(state, awaited.mark)) take(region, joins.certain);
    for (const identifier of awaitedIdentifiers(state, awaited.operand)) {
      const symbol = state.checker.getSymbolAtLocation(identifier);
      const bound = symbol === undefined ? undefined : state.strandsBySymbol.get(symbol);
      for (const region of bound ?? []) take(region, joins.certain);
    }
  }
  // The lift candidates are the strands that issued a claimed step, taken in spawn order;
  // a strand reached through a certain step is lifted certainly even if a maybe step also
  // names it. A joined strand never lifts again, so it leaves the index for good.
  const viaCertain = new Set<StrandRecord>();
  const candidates = new Set<StrandRecord>();
  const collect = (steps: readonly string[], side: Set<StrandRecord> | undefined): void => {
    for (const step of steps) {
      const set = state.strandsByStep.get(step);
      if (set === undefined) continue;
      for (const record of set) {
        if (state.joined.has(record.region)) {
          set.delete(record);
          continue;
        }
        if (!record.closed) continue;
        candidates.add(record);
        side?.add(record);
      }
    }
  };
  collect(certain, viaCertain);
  collect(maybe, undefined);
  const ordered = [...candidates].sort((a, b) => a.at - b.at);
  for (const record of ordered) take(record.region, viaCertain.has(record) ? joins.certain : joins.maybe);
  return joins;
}
