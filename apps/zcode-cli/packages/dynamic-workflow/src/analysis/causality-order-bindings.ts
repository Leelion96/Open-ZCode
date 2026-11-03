import ts from "typescript";
import type { ApplicationVia, ArgBinding, ParamRef, ThroughParam } from "./state.js";
import type { IterationCandidate } from "./sites.js";
import { isFunctionLike } from "./sites.js";
import { asScriptFunction, resolveCallDeclaration, type ScriptFunction } from "./causality-order-functions.js";
import type { OrderOracle } from "./causality-order-types.js";

// 走查按调用点的绑定解析「经参数应用」的函数（docs/analysis.md「The call oracle」「Inlining」）。
// 不动点把一个 helper 的函数体每遍只求值一次、参数槽里是所有调用者传过的回调，所以神谕在
// `fn()` 处记下的是全部回调；这里把其中记明"来自参数 k"的那部分换成当前正在内联的那次调用
// 实际绑定的函数。本文件不读事件，只读神谕与激活栈；递归预计算（collectRecursiveActivations）
// 用同一套解析在不发事件的情况下跑一遍调用点。

/** One inlined body: which function, and what the call bound to each of its parameters. */
export interface Activation {
  decl: ts.Node;
  /** Per parameter, the functions the call bound; absent when the call left it unfilled. */
  bindings: readonly (ReadonlySet<ts.Node> | undefined)[];
  /**
   * decl + own bindings + the resolution of every OUTER parameter the body names. Two
   * activations with equal keys inline identical subtrees; a key already on the stack is
   * recursion.
   */
  key: string;
}

/** What resolution reads: the oracle, the open activations, and a cache of each body's outer refs. */
export interface BindingContext {
  oracle: OrderOracle;
  activations: readonly Activation[];
  /** Fan-out callback literals, walked inline under the enclosing activation. */
  candByCallback: ReadonlyMap<ts.Node, IterationCandidate>;
  outerRefsCache: Map<ts.Node, ParamRef[]>;
}

/** The binding of `ref` in the innermost open activation of its function, if any. */
function resolveThrough(ctx: BindingContext, ref: ParamRef): ReadonlySet<ts.Node> | undefined {
  for (let i = ctx.activations.length - 1; i >= 0; i -= 1) {
    const activation = ctx.activations[i] as Activation;
    if (activation.decl === ref.fn) return activation.bindings[ref.param];
  }
  return undefined;
}

/**
 * Swap the functions a merged list owes to resolvable parameters for their bindings: keep
 * what no resolved record accounts for (or what an UNRESOLVED record still owes — the same
 * function may have arrived through two parameters), then add the bindings.
 */
function swapThrough(
  ctx: BindingContext,
  merged: Iterable<ts.Node>,
  records: Iterable<ThroughParam>,
): ts.Node[] {
  const drop = new Set<ts.Node>();
  const keep = new Set<ts.Node>();
  const add: ts.Node[] = [];
  for (const record of records) {
    const bound = resolveThrough(ctx, record);
    if (bound === undefined) {
      for (const fn of record.accounted) keep.add(fn);
      continue;
    }
    for (const fn of record.accounted) drop.add(fn);
    for (const fn of bound) add.push(fn);
  }
  const out: ts.Node[] = [];
  const seen = new Set<ts.Node>();
  const push = (fn: ts.Node): void => {
    if (seen.has(fn)) return;
    seen.add(fn);
    out.push(fn);
  };
  for (const fn of merged) if (!drop.has(fn) || keep.has(fn)) push(fn);
  for (const fn of add) push(fn);
  return out;
}

/** The script functions applied at `node` as `via`, resolved against the open activations. */
export function resolveApplications(
  ctx: BindingContext,
  scriptFile: ts.SourceFile,
  node: ts.Node,
  via: ApplicationVia,
): ScriptFunction[] {
  const merged: ts.Node[] = [];
  for (const [fn, how] of ctx.oracle.applications.get(node) ?? []) if (how === via) merged.push(fn);
  const records = [...(ctx.oracle.throughParams.get(node)?.values() ?? [])].filter((r) => r.via === via);
  const fns = records.length === 0 ? merged : swapThrough(ctx, merged, records);
  const out: ScriptFunction[] = [];
  for (const fn of fns) {
    const decl = asScriptFunction(fn, scriptFile);
    if (decl !== undefined) out.push(decl);
  }
  return out;
}

/** What inlining `decl` at `site` binds to each parameter, resolved against the open activations. */
export function resolveBindings(
  ctx: BindingContext,
  site: ts.Node,
  decl: ts.Node,
): (ReadonlySet<ts.Node> | undefined)[] {
  const recorded = ctx.oracle.bindings.get(site)?.get(decl);
  if (recorded === undefined) return [];
  const out: (ReadonlySet<ts.Node> | undefined)[] = [];
  for (let param = 0; param < recorded.length; param += 1) {
    const binding: ArgBinding | undefined = recorded[param];
    out.push(binding === undefined ? undefined : new Set(swapThrough(ctx, binding.fns, binding.through)));
  }
  return out;
}

/**
 * The parameters of OTHER functions a body names at its call sites — lexically, including
 * fan-out callback literals (walked inline) and excluding other nested functions (entered
 * through their own activations). Their resolution is part of the activation's key.
 */
function outerRefsOf(ctx: BindingContext, decl: ts.Node): ParamRef[] {
  const cached = ctx.outerRefsCache.get(decl);
  if (cached !== undefined) return cached;
  const refs: ParamRef[] = [];
  const seen = new Set<string>();
  const note = (ref: ParamRef): void => {
    if (ref.fn === decl) return;
    const key = `${ref.fn.pos}:${ref.param}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  const scan = (node: ts.Node): void => {
    if (node !== decl && isFunctionLike(node) && !ctx.candByCallback.has(node)) return;
    for (const record of ctx.oracle.throughParams.get(node)?.values() ?? []) note(record);
    for (const list of ctx.oracle.bindings.get(node)?.values() ?? []) {
      for (const binding of list) for (const through of binding?.through ?? []) note(through);
    }
    ts.forEachChild(node, scan);
  };
  const body = (decl as ts.SignatureDeclaration & { body?: ts.Node }).body;
  if (body !== undefined) scan(body);
  ctx.outerRefsCache.set(decl, refs);
  return refs;
}

const setKey = (fns: ReadonlySet<ts.Node> | undefined): string =>
  fns === undefined ? "?" : [...fns].map((fn) => fn.pos).sort((a, b) => a - b).join(",");

/** The key of inlining `decl` with `bindings` under the open activations (see {@link Activation.key}). */
export function activationKey(
  ctx: BindingContext,
  decl: ts.Node,
  bindings: readonly (ReadonlySet<ts.Node> | undefined)[],
): string {
  const own = bindings.map(setKey).join("|");
  const outer = outerRefsOf(ctx, decl)
    .map((ref) => `${ref.fn.pos}:${ref.param}=${setKey(resolveThrough(ctx, ref))}`)
    .join("|");
  return `${decl.pos}(${own})${outer}`;
}

/** Open an activation for inlining `decl` at `site`: its resolved bindings and its key. */
export function activationFor(ctx: BindingContext, decl: ts.Node, site: ts.Node): Activation {
  const bindings = resolveBindings(ctx, site, decl);
  return { bindings, decl, key: activationKey(ctx, decl, bindings) };
}

/**
 * Activations that can reach themselves: the keys the walk turns into `loop` regions instead
 * of unrolling. The same resolution the walk performs, run over each body's call sites without
 * emitting events and memoized per key, yields the activation graph; every member of a cycle in
 * it is recursive (Tarjan), so whichever member the walk enters first gets the `loop` the
 * re-entrant call `recur`s to. Mirrors the walk's entry rules: callee and argument applications
 * at every call-like node, the checker's declaration when the oracle has no callee, fan-out
 * callback literals scanned inline, other function literals entered only through applications.
 */
export function collectRecursiveActivations(
  oracle: OrderOracle,
  scriptFile: ts.SourceFile,
  checker: ts.TypeChecker,
  body: ts.Node,
  candByCallback: ReadonlyMap<ts.Node, IterationCandidate>,
  outerRefsCache: Map<ts.Node, ParamRef[]>,
): Set<string> {
  const stack: Activation[] = [];
  const ctx: BindingContext = { activations: stack, candByCallback, oracle, outerRefsCache };
  const edges = new Map<string, Set<string>>();
  const finished = new Set<string>();
  const ROOT = "";

  const enter = (decl: ts.Node, site: ts.Node): void => {
    const activation = activationFor(ctx, decl, site);
    const from = stack.length === 0 ? ROOT : (stack[stack.length - 1] as Activation).key;
    let out = edges.get(from);
    if (out === undefined) {
      out = new Set();
      edges.set(from, out);
    }
    out.add(activation.key);
    if (finished.has(activation.key) || stack.some((open) => open.key === activation.key)) return;
    stack.push(activation);
    const inner = (decl as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (inner !== undefined) scan(inner, decl);
    stack.pop();
    finished.add(activation.key);
  };
  const scan = (node: ts.Node, owner: ts.Node | undefined): void => {
    if (node !== owner && isFunctionLike(node) && !candByCallback.has(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const callees = resolveApplications(ctx, scriptFile, node, "callee");
      if (callees.length === 0 && ts.isCallExpression(node)) {
        const decl = resolveCallDeclaration(node, checker, scriptFile);
        if (decl !== undefined) callees.push(decl);
      }
      for (const fn of callees) enter(fn, node);
      for (const fn of resolveApplications(ctx, scriptFile, node, "argument")) enter(fn, node);
    }
    ts.forEachChild(node, (child) => scan(child, undefined));
  };
  scan(body, body);
  return cyclicKeys(edges);
}

/** The nodes of `edges` that lie on a cycle: members of a non-trivial SCC, or with a self-edge. */
function cyclicKeys(edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  let next = 0;
  const visit = (key: string): void => {
    index.set(key, next);
    low.set(key, next);
    next += 1;
    stack.push(key);
    onStack.add(key);
    for (const to of edges.get(key) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(key, Math.min(low.get(key) as number, low.get(to) as number));
      } else if (onStack.has(to)) {
        low.set(key, Math.min(low.get(key) as number, index.get(to) as number));
      }
    }
    if (low.get(key) !== index.get(key)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop() as string;
      onStack.delete(member);
      component.push(member);
      if (member === key) break;
    }
    if (component.length > 1 || edges.get(key)?.has(key) === true) {
      for (const member of component) if (member !== "") cyclic.add(member);
    }
  };
  for (const key of edges.keys()) if (!index.has(key)) visit(key);
  return cyclic;
}
