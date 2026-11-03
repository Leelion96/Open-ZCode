import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript, serializeCore } from "../src/index.js";
import type { OrderRegion } from "../src/analysis/causality-order.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

/**
 * Callback invocation (docs/analysis.md): the ordering walk inlines
 * exactly the bodies the interpreter applied at each call — the CALL ORACLE — and the callback
 * registry says how often a library invokes a callback. These are the behavioural pins the
 * corpus goldens cannot state as invariants: each case names the shape, the region the body
 * must land in, and the phase its steps must belong to.
 */

function trace(script: string) {
  const result = analyzeWorkflowScript(script);
  expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
  const core = result.core;
  const causality = result.causality;
  if (core === undefined || causality === undefined) throw new Error("expected a clean analysis");
  return { causality, core, regions: core.trace.regions, result };
}

function regionsOf(regions: readonly OrderRegion[], kind: OrderRegion["kind"]): OrderRegion[] {
  return regions.filter((region) => region.kind === kind);
}

function phaseOfStep(result: ReturnType<typeof trace>, id: string): string | undefined {
  return result.causality.steps.find((step) => step.id === id)?.phase;
}

describe("callback invocation — the call oracle", () => {
  it("never leaves a function value that reaches a call to the sweep", () => {
    const { regions } = trace(`
const paths = await files.glob("*.md");
const review = (p: string) => agent("reviewer").ask<string>(\`review \${p}\`);
const helper = (fn: () => Node<string>) => fn();
const a = await Promise.all(paths.map(review));
const b = await helper(() => agent("b").ask<string>("b"));
const c = await Promise.resolve(a).then(() => agent("c").ask<string>("c"));
const d = await new Promise<string>((resolve) => { agent("d").ask<string>("d").then(resolve); });
const e = await Array.from(paths, (p) => agent("e").ask<string>(p)).length;
return [a, b, c, d, e];
`);
    expect(regions.filter((region) => region.detached === true)).toEqual([]);
  });

  it("sweeps ONLY a body no call ever applies", () => {
    const { regions } = trace(`
const unused = () => agent("ghost").ask<string>("never");
return await agent("w").ask<string>("w");
`);
    const detached = regions.filter((region) => region.detached === true);
    expect(detached.map((region) => region.label)).toEqual(["unused"]);
  });

  it("phases a callback body by the phase current at the invoking call", () => {
    const result = trace(`
phase("scan");
const paths = await files.glob("*.md");
const review = (p: string) => agent("reviewer").ask<string>(\`review \${p}\`);
const out = await Promise.all(paths.map(review));
phase("report");
return await agent("summarizer").ask<string>(JSON.stringify(out));
`);
    expect(phaseOfStep(result, "ask#1")).toBe("phase#1");
    expect(phaseOfStep(result, "ask#2")).toBe("phase#2");
    // The named callback's ask sits inside the map's fanout, as an inlined call.
    const fanout = regionsOf(result.regions, "fanout").find((region) => region.label === "map");
    expect(fanout).toBeDefined();
    expect(regionsOf(result.regions, "call").some((region) => region.parent === fanout?.id && region.label === "review")).toBe(true);
    // And the summarizer runs AFTER the reviewers, never before (the sweep artifact).
    expect(result.causality.edges.some((edge) => edge.from === "ask#2" && edge.to === "ask#1")).toBe(false);
  });

  it("inlines a callback invoked through a helper's parameter", () => {
    const result = trace(`
phase("work");
async function withRetry(job: () => Node<string>): Promise<string> { return await job(); }
const a = await withRetry(() => agent("worker").ask<string>("do it"));
phase("check");
return await agent("checker").ask<string>(a);
`);
    expect(phaseOfStep(result, "ask#1")).toBe("phase#1");
    const calls = regionsOf(result.regions, "call");
    const outer = calls.find((region) => region.label === "withRetry");
    expect(outer).toBeDefined();
    expect(calls.some((region) => region.parent === outer?.id)).toBe(true);
  });

  it("opens a skippable choice around a deferred continuation and settles its receiver first", () => {
    const { core, regions } = trace(`
const draft = agent("writer").ask<string>("draft");
const edited = await draft.then((t) => agent("editor").ask<string>(t));
return edited;
`);
    const call = regionsOf(regions, "call").find((region) => region.label === "then");
    expect(call).toBeDefined();
    const arm = regions.find((region) => region.id === call?.parent);
    expect(arm?.kind).toBe("branch");
    expect(arm?.entered).toBe(false);
    expect(regions.find((region) => region.id === arm?.parent)?.kind).toBe("choice");
    // A deferred continuation is a STRAND: the `call` region is its frame, and the
    // receiver barrier is its prologue — an ordinary barrier, so a singleton exact
    // receiver settles CERTAINLY (the strand model replaced `settleLocally`'s blanket
    // may-claim with frame scoping, analyzer-strands-plan.md「The walk」).
    expect(call?.strand).toBe(true);
    const events = core.trace.events;
    const settle = events.findIndex((event) => event.at === "settle" && event.steps.includes("ask#1"));
    const issue = events.findIndex((event) => event.at === "issue" && event.step === "ask#2");
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(settle).toBeLessThan(issue);
    expect(events[settle]).toMatchObject({ maybe: false });
    // It settled INSIDE the strand, so it says nothing to the main line: the frame is the
    // callback's own `call` region, not the root.
    expect(events[settle]?.regions).toContain(call?.id);
    // The main line's own await settles the editor for real, and joins the strand.
    const outer = events.find(
      (event) => event.at === "settle" && !event.maybe && event.steps.includes("ask#2"),
    );
    expect(outer).toBeDefined();
    expect(outer?.at === "settle" ? outer.joins : undefined).toContain(call?.id);
  });

  it("records a join-only settle when the joined strand's summary is already settled", () => {
    // A JOIN IS A CONTROL-FLOW FACT whether or not it settles anything: it is where the
    // strand's parked exits reconnect. Here the strand awaits a step the MAIN LINE awaits
    // first, so by `await p` the whole summary is already visible in the root frame and the
    // barrier settles nothing new. Dropping the event would leave the strand parked forever
    // in the control-flow projection, so it is recorded with no steps to its name.
    const { core, regions } = trace(`
const first = agent("a").ask<string>("x");
async function h(): Promise<void> {
  await first;
}
const p = h();
await first;
await p;
return first;
`);
    const call = regionsOf(regions, "call").find((region) => region.label === "h");
    expect(call).toBeDefined();
    expect(call?.strand).toBe(true);
    const settles = core.trace.events.filter((event) => event.at === "settle");
    expect(settles[settles.length - 1]).toMatchObject({
      joins: [call?.id],
      maybe: false,
      steps: [],
    });
    // A step-less settle prints without the step token, so the line keeps single spaces.
    const text = serializeCore(core);
    expect(text).toContain(`settle in=seq#1 joins=${call?.id ?? ""}`);
    expect(text).not.toContain("settle  in=");
  });

  it("keeps an ordering edge from receiver steps into a continuation that ignores the value", () => {
    const result = trace(`
const a = agent("a").ask<string>("x");
const b = agent("b").ask<string>("y");
const r = await Promise.all([a, b]).catch(() => agent("fallback").ask<string>("recover"));
return r;
`);
    const into = result.causality.edges.filter((edge) => edge.to === "ask#3").map((edge) => edge.from).sort();
    expect(into).toEqual(["ask#1", "ask#2"]);
  });

  it("does not smear sibling callbacks into a callback's parameters as callables", () => {
    // `Promise.resolve(text)` inside the outer continuation must not re-apply the outer
    // continuation to itself (phantom recursion → a `loop` region).
    const { regions } = trace(`
const draft = agent("writer").ask<string>("draft");
const out = await draft.then((text) =>
  Promise.resolve(text).then((inner) => agent("editor").ask<string>(\`edit \${inner}\`)),
);
return out;
`);
    expect(regionsOf(regions, "loop")).toEqual([]);
    expect(regionsOf(regions, "call").map((region) => region.label)).toEqual(["then", "then"]);
  });

  it("never dispatches a library member on the callables its receiver value carries", () => {
    // `.finally` on a `.then(a, b)` result: a and b are the receiver's contents, not the callee.
    const { regions } = trace(`
const draft = agent("writer").ask<string>("draft");
const settled = await Promise.resolve(draft)
  .then((t) => agent("editor").ask<string>(t), (e) => agent("fixer").ask<string>(String(e)))
  .finally(() => log("done"));
return settled;
`);
    expect(regionsOf(regions, "call").map((region) => region.label)).toEqual(["then", "then", "finally"]);
    expect(regionsOf(regions, "choice").filter((region) => region.exhaustive === true)).toEqual([]);
  });

  it("inlines an indirect dispatch over several targets as one exhaustive choice", () => {
    const { regions, causality } = trace(`
const seed = await agent("seed").ask<string>("seed");
const fast = (s: string) => agent("fast").ask<string>(s);
const slow = (s: string) => agent("slow").ask<string>(s);
const pick = seed.length > 3 ? fast : slow;
return await pick(seed);
`);
    // The ternary is a choice too; the dispatch is the one whose arms hold inlined calls.
    const calls = regionsOf(regions, "call");
    const choice = regionsOf(regions, "choice").find(
      (region) =>
        region.exhaustive === true &&
        regions.some((arm) => arm.parent === region.id && calls.some((call) => call.parent === arm.id)),
    );
    expect(choice).toBeDefined();
    const arms = regions.filter((region) => region.parent === choice?.id);
    expect(arms.every((arm) => arm.kind === "branch" && arm.entered === false)).toBe(true);
    const labels = arms.map((arm) => calls.find((call) => call.parent === arm.id)?.label).sort();
    expect(labels).toEqual(["fast", "slow"]);
    expect(causality.steps.filter((step) => step.id !== "ask#1").every((step) => step.certainty === "maybe")).toBe(true);
  });

  it("inlines a script class constructor at `new`, labelled by the class", () => {
    const { regions } = trace(`
class Judge {
  verdict: Node<string>;
  constructor(s: string) { this.verdict = agent("judge").ask<string>(s); }
}
const j = new Judge("case");
return await j.verdict;
`);
    expect(regionsOf(regions, "call").map((region) => region.label)).toEqual(["Judge"]);
    expect(regions.filter((region) => region.detached === true)).toEqual([]);
  });
});

describe("callback invocation — the registry", () => {
  it("treats `Array.from(xs, fn)` as a per-element fan-out over its first argument", () => {
    const { core, regions } = trace(`
const paths = await files.glob("*.md");
const out = await Promise.all(Array.from(paths, (p) => agent("r").ask<string>(p)));
return out;
`);
    expect(regionsOf(regions, "fanout").map((region) => region.label)).toEqual(["from"]);
    expect(core.sites.fanouts).toHaveLength(1);
    expect(core.sites.asks[0]?.within).toBe("fan-out#1");
    // The iterated collection feeds the fan-out relay.
    expect(core.facts.fanoutIn.get("fan-out#1")?.map((occ) => occ.site)).toEqual(["world-read#1"]);
  });

  it("gives an object-length fan-out no cardinality but a `many` family", () => {
    const { core, result } = trace(`
const TOTAL = 3;
const items = await Promise.all(Array.from({ length: TOTAL }, (_, i) => agent(\`w-\${i}\`).ask<string>(String(i))));
return items;
`);
    expect(core.sites.fanouts[0]?.cardinality).toBeUndefined();
    expect(result.handoff?.participants.map((participant) => participant.many)).toEqual([true]);
  });

  it("binds both comparator parameters of `sort` to the element", () => {
    const { core } = trace(`
const paths = await files.glob("*.md");
const sorted = paths.sort((a, b) => a.localeCompare(b));
const picked = [...sorted].sort((a, b) => {
  agent("cmp").ask<string>(a + b);
  return 0;
});
return picked;
`);
    // The second sort's comparator reaches a facade site and promotes; its ask reads the element.
    expect(core.sites.fanouts).toHaveLength(1);
    expect(core.facts.askData.get("ask#1")?.some((occ) => occ.site === "fan-out#1")).toBe(true);
  });

  it("leaves a script-declared `.map` / `.then` to the callee path", () => {
    const { regions } = trace(`
const pipeline = {
  map(fn: (x: string) => Node<string>) { return fn("x"); },
  then(fn: (x: string) => Node<string>) { return fn("y"); },
};
const a = await pipeline.map((x) => agent("a").ask<string>(x));
const b = await pipeline.then((y) => agent("b").ask<string>(y));
return [a, b];
`);
    expect(regionsOf(regions, "fanout")).toEqual([]);
    // Each user method inlines as a call; the callback inlines inside it through the parameter.
    expect(regionsOf(regions, "call").map((region) => region.label)).toEqual(["map", undefined, "then", undefined]);
    expect(regions.filter((region) => region.detached === true)).toEqual([]);
  });

  it("runs a Promise executor once, certainly", () => {
    const result = trace(`
const gate = await new Promise<string>((resolve) => { agent("g").ask<string>("go").then(resolve); });
return gate;
`);
    const call = regionsOf(result.regions, "call").find((region) => region.label === "Promise");
    expect(call?.entered).toBe(true);
    expect(result.causality.steps[0]?.certainty).toBe("always");
  });
});

/**
 * Callbacks bound through a parameter (docs/analysis.md "The call oracle", "Inlining"): the
 * oracle records WHICH parameter a call applies and WHAT each call site bound to it, and the
 * walk resolves the two against the activation it is inlining. These pins state what the
 * corpus goldens show for shared-helper-*.ts as invariants on the trace.
 */
describe("callbacks bound through a parameter", () => {
  const LIMITED = "async function limited(fn: () => Promise<string>): Promise<string> { return await fn(); }\n";

  it("inlines only the callback the call being inlined passed", () => {
    const { core, regions } = trace(`
${LIMITED}const xs0 = ["a", "b"];
const xs1 = ["c", "d"];
const out: string[] = [];
out.push(...(await Promise.all(xs0.map(async (x) => limited(async () => agent(\`f0-\${x}\`).ask<string>(\`do \${x}\`))))));
out.push(...(await Promise.all(xs1.map(async (x) => limited(async () => agent(\`f1-\${x}\`).ask<string>(\`do \${x}\`))))));
out.push(await limited(async () => agent("m0").ask<string>("top 0")));
out.push(await limited(async () => {
  const inner = await limited(async () => agent("n1").ask<string>("nested"));
  return agent("m1").ask<string>(\`after \${inner}\`);
}));
return out;
`);
    // Five calls of the helper, each inlining exactly one callback: ten call regions, no
    // choice (no "one of every caller's callback"), no loop (the nested use is not recursion).
    expect(regionsOf(regions, "call")).toHaveLength(10);
    expect(regionsOf(regions, "choice")).toEqual([]);
    expect(regionsOf(regions, "loop")).toEqual([]);
    // Each step belongs to the fan-out that passed its callback, or to none.
    expect(core.sites.asks.map((ask) => [ask.label, ask.within])).toEqual([
      ["ask", "fan-out#1"],
      ["ask", "fan-out#2"],
      ["m0", undefined],
      ["n1", undefined],
      ["m1", undefined],
    ]);
    expect(core.sites.actors.map((actor) => actor.within)).toEqual(["fan-out#1", "fan-out#2", undefined, undefined, undefined]);
  });

  it("resolves a callback through two wrapper layers", () => {
    const { regions } = trace(`
${LIMITED}async function retry(fn: () => Promise<string>): Promise<string> { return await limited(() => fn()); }
const a = await retry(async () => agent("a").ask<string>("a"));
const b = await retry(async () => agent("b").ask<string>("b"));
const c = await retry(async () => agent("c").ask<string>("c"));
return [a, b, c];
`);
    // retry → limited → arrow → callback: four call regions per caller, nothing else.
    expect(regionsOf(regions, "call")).toHaveLength(12);
    expect(regionsOf(regions, "choice")).toEqual([]);
  });

  it("resolves a parameter handed on to a library call", () => {
    const { regions } = trace(`
async function later(fn: () => Promise<string>): Promise<string> { return Promise.resolve("go").then(fn); }
const a = await later(async () => agent("a").ask<string>("a"));
const b = await later(async () => agent("b").ask<string>("b"));
return [a, b];
`);
    // later + its own `.then` callback, twice.
    expect(regionsOf(regions, "call")).toHaveLength(4);
  });

  it("resolves a parameter handed to a per-element library call", () => {
    const { core, regions } = trace(`
async function each(xs: string[], fn: (x: string) => Promise<string>): Promise<string[]> { return Promise.all(xs.map(fn)); }
const ids = ["1", "2"];
const a = await each(ids, async (x) => agent(\`a-\${x}\`).ask<string>(\`a \${x}\`));
const b = await each(ids, async (x) => agent(\`b-\${x}\`).ask<string>(\`b \${x}\`));
return [...a, ...b];
`);
    // each + its own callback inside the one map site, twice; both asks run per element of it.
    expect(regionsOf(regions, "call")).toHaveLength(4);
    expect(regionsOf(regions, "fanout")).toHaveLength(2);
    expect(core.sites.asks.map((ask) => ask.within)).toEqual(["fan-out#1", "fan-out#1"]);
  });

  it("keeps recursion when the re-entrant call rebinds the same callback", () => {
    const { regions } = trace(`
interface Tree { name: string; children: Tree[] }
async function walkTree(node: Tree, visit: (n: Tree) => Promise<string>): Promise<void> {
  await visit(node);
  for (const child of node.children) await walkTree(child, visit);
}
const root: Tree = { name: "r", children: [] };
await walkTree(root, async (n) => agent(\`v-\${n.name}\`).ask<string>(\`visit \${n.name}\`));
return "done";
`);
    expect(regionsOf(regions, "loop").filter((region) => region.recursive === true)).toHaveLength(1);
    // walkTree once, visit once; the re-entrant call is a recur jump, not a third call.
    expect(regionsOf(regions, "call")).toHaveLength(2);
  });

  it("falls back to every caller's callback when the parameter reaches the call through an alias", () => {
    const { regions } = trace(`
async function viaAlias(fn: () => Promise<string>): Promise<string> { const h = fn; return await h(); }
const a = await viaAlias(async () => agent("a").ask<string>("a"));
const b = await viaAlias(async () => agent("b").ask<string>("b"));
return [a, b];
`);
    // Provenance is lost through `h`, so each call inlines both callbacks as an exhaustive choice.
    expect(regionsOf(regions, "choice")).toHaveLength(2);
    expect(regionsOf(regions, "call")).toHaveLength(6);
  });

  it("keeps within as a may-fact for a helper called inside and outside a fan-out", () => {
    const { core } = trace(`
async function step(x: string): Promise<string> { return agent("w").ask<string>(x); }
const ids = ["1", "2"];
const a = await Promise.all(ids.map((x) => step(x)));
const b = await step("solo");
return [...a, b];
`);
    expect(core.sites.asks[0]?.within).toBe("fan-out#1");
  });
});
