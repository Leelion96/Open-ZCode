// Two wrapper layers over one callback: `retry` hands `limited` a fresh arrow that calls
// retry's own parameter. The arrow is bound at retry's call to limited; `fn()` inside it
// resolves through the enclosing activation of retry, so each caller's chain inlines
// retry → limited → arrow → its own callback: 4 call regions per caller, no choice.
async function limited(fn: () => Promise<string>): Promise<string> {
  return await fn();
}
async function retry(fn: () => Promise<string>): Promise<string> {
  return await limited(() => fn());
}
const a = await retry(async () => agent("a").ask<string>("a"));
const b = await retry(async () => agent("b").ask<string>("b"));
const c = await retry(async () => agent("c").ask<string>("c"));
return [a, b, c];
