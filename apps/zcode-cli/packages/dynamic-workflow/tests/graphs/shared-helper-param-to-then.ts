// A parameter handed on to a library call: `.then(fn)` inside `later` is an `argument`
// application through later's parameter. Each call of `later` inlines only the callback it
// passed, as a deferred strand with the receiver's barrier for a prologue.
async function later(fn: () => Promise<string>): Promise<string> {
  return Promise.resolve("go").then(fn);
}
const a = await later(async () => agent("a").ask<string>("a"));
const b = await later(async () => agent("b").ask<string>("b"));
return [a, b];
