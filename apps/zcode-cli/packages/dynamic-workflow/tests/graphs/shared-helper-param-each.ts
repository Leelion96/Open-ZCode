// A parameter handed to a per-element library call: `xs.map(fn)` inside `each` is one
// fan-out site reached from both calls, and each call's activation inlines only its own
// callback inside that fan-out. Both asks are within fan-out#1: they run per element of the
// one map site.
async function each(xs: string[], fn: (x: string) => Promise<string>): Promise<string[]> {
  return Promise.all(xs.map(fn));
}
const ids = ["1", "2"];
const a = await each(ids, async (x) => agent(`a-${x}`).ask<string>(`a ${x}`));
const b = await each(ids, async (x) => agent(`b-${x}`).ask<string>(`b ${x}`));
return [...a, ...b];
