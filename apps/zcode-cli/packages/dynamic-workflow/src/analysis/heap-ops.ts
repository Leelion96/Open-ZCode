import ts from "typescript";
import { adoptFields, collapse, emptyValue, mergeInto, replayMayAliasMerge, type AbstractValue } from "./domain.js";
import { mergeIntoRootIdentifier } from "./assign.js";
import type { EvalContext, Evaluator } from "./taint.js";

/**
 * In-place heap-mutation transfers: `Object.assign` and the receiver-mutating array /
 * collection methods (`push`, `Map.set`, …). Extracted from calls.ts (pure move, no
 * behavior change) to keep that file under the line cap.
 */

/** `Object.assign` — a free function (not a method) that mutates its target in place. */
export function isObjectAssign(access: ts.PropertyAccessExpression): boolean {
  return ts.isIdentifier(access.expression) && access.expression.text === "Object" && access.name.text === "assign";
}

export function handleHeapMutator(
  ev: Evaluator,
  node: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  ctx: EvalContext,
): AbstractValue {
  // Resolve the receiver to its LIVE value so a mutator on a nested place
  // (`wrap.items.push(x)`, `state.map.set(k, v)`) writes the shared container, visible
  // through every alias. `Map.set`/`Set.add` fold their args in the same way as the
  // array mutators (key taint included — a sound over-approximation).
  const container = ev.resolvePlace(access.expression, true);
  // An unresolvable receiver (computed element access `state.buffers[i].push(x)`,
  // a call result `log().push(x)`) used to skip BOTH halves of the transfer — the argument
  // taint merged nowhere (a silent total drop of the flow) and the receiver expression was
  // never evaluated, so a facade sink sitting in receiver position was never visited at
  // all. Mirror writeTarget's unresolvable-receiver path (assign.ts): the receiver is
  // evaluated for effect (evalCall evaluates every member call's receiver once, before
  // dispatching here) and each argument is smeared into the chain's root identifier.
  for (const arg of node.arguments) {
    const argVal = collapse(ev.evalExpr(arg, ctx));
    if (container !== undefined) {
      if (mergeInto(container, argVal)) ev.s.changed = true;
      // A conditional-binding / join-element receiver mutated in place reaches every
      // candidate place it may BE (weak, inexact).
      if (replayMayAliasMerge(container, argVal)) ev.s.changed = true;
    } else {
      mergeIntoRootIdentifier(ev, access.expression, argVal);
    }
  }
  return emptyValue();
}

/** `Object.assign(target, ...sources)`: merge each source into the target's live value. */
export function handleObjectAssign(ev: Evaluator, node: ts.CallExpression, ctx: EvalContext): AbstractValue {
  const [targetArg, ...sources] = node.arguments;
  if (targetArg === undefined) return emptyValue();
  const targetLive = ev.resolvePlace(targetArg, true);
  const result = ev.evalExpr(targetArg, ctx); // Object.assign returns the target
  for (const src of sources) {
    const srcPlace = ev.resolvePlace(src);
    const srcVal = srcPlace ?? ev.evalExpr(src, ctx);
    if (targetLive !== undefined) {
      // Object.assign shallow-copies: an object-valued source field is copied by
      // REFERENCE, so after the call `target.f` and `src.f` are one shared object and a
      // write through either is visible through the other. When the source is a place,
      // adopt its field objects by reference; container-level occs (and any non-place
      // source, e.g. `{ f: secret }`) still weak-merge in as before, so
      // `Object.assign(target, { f: secret })` makes `target.f` observe secret.
      // The old deep `mergeInto` materialized independent target
      // fields, so a mutation through target's shared sub-object was invisible via src.
      if (srcPlace !== undefined && adoptFields(targetLive, srcPlace)) ev.s.changed = true;
      if (mergeInto(targetLive, srcVal)) ev.s.changed = true;
    }
    mergeInto(result, srcVal);
  }
  return result;
}
