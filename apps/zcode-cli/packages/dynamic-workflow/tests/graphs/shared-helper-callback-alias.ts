// The known over-approximation (docs/analysis.md "Open questions"): the callback reaches
// the call through a local alias, not as the bare parameter, so provenance is lost and the
// merged record applies — each call of `viaAlias` inlines BOTH callers' callbacks as an
// exhaustive choice. Sound, and the shape the oracle's syntactic rule does not cover.
async function viaAlias(fn: () => Promise<string>): Promise<string> {
  const h = fn;
  return await h();
}
const a = await viaAlias(async () => agent("a").ask<string>("a"));
const b = await viaAlias(async () => agent("b").ask<string>("b"));
return [a, b];
