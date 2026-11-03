// A rate-limit helper shared by five call sites: two fan-outs, a top-level call, and a
// call whose callback calls the helper again. `fn()` inside the helper inlines ONLY the
// callback the call being inlined passed (docs/analysis.md "Inlining"): no exhaustive
// choice over every caller's callback, no false `loop recursive` around the helper, and
// each ask's `within` names its own fan-out — ask#1 fan-out#1, ask#2 fan-out#2, the rest
// none. The nested use is two activations with different bindings, not recursion.
async function limited<T>(slots: number, fn: () => Promise<T>): Promise<T> {
  return await fn();
}
const xs0 = ["a", "b"];
const xs1 = ["c", "d"];
const out: string[] = [];
out.push(...(await Promise.all(xs0.map(async (x) => limited(2, async () => agent(`f0-${x}`).ask<string>(`do ${x}`))))));
out.push(...(await Promise.all(xs1.map(async (x) => limited(2, async () => agent(`f1-${x}`).ask<string>(`do ${x}`))))));
out.push(await limited(2, async () => agent("m0").ask<string>("top 0")));
out.push(
  await limited(2, async () => {
    const inner = await limited(2, async () => agent("n1").ask<string>("nested"));
    return agent("m1").ask<string>(`after ${inner}`);
  }),
);
return out;
