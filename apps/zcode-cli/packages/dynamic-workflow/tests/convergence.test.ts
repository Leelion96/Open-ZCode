import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript, collectSites, createWorkflowProgram, interpret } from "../src/index.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

/**
 * Fixpoint convergence pins (docs/analysis.md, "Convergence": the canonical-heap rule).
 *
 * The taint fixpoint is gen-only over a finite lattice, so the only way it fails to settle
 * is a transfer that reports a change every pass without the state growing: a persistent
 * merge INTO a value that is recreated each pass. Each case here is a shape that once did
 * exactly that. The assertion is the analysis completing at all — `analyzeWorkflowScript`
 * throws at ITERATION_CAP — plus, where the fix changed what the graph can see, the fact it
 * now sees.
 */

function analyze(script: string) {
  const result = analyzeWorkflowScript(script);
  expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
  const causality = result.causality;
  if (causality === undefined) throw new Error("expected a causality graph");
  return { causality, result };
}

const hasEdge = (edges: ReadonlyArray<{ from: string; to: string }>, from: string, to: string): boolean =>
  edges.some((edge) => edge.from === from && edge.to === to);

describe("convergence — container literals are allocation-site places", () => {
  it("converges when a callee writes a NEW field through a parameter bound to an inline object literal", () => {
    // The minimal shape: nothing here is exotic. Before literals had a persistent place this
    // failed on every analyzer generation since 2026-08-17.
    analyze(`
function tag(box: { name: string; note?: string }, t: string): void { box.note = t; }
const t = await agent("s").ask<string>("q");
tag({ name: "x" }, t);
return t;
`);
  });

  it("converges for an inline array literal mutated by the callee", () => {
    analyze(`
function fill(xs: string[], t: string): void { xs.push(t); }
const t = await agent("s").ask<string>("q");
fill([], t);
return t;
`);
  });

  it("converges when the write-back carries no taint at all", () => {
    // The re-reported change was the write-back's own doing, not the data it carried.
    analyze(`
function tag(box: { name: string; note?: string }, t: string): void { box.note = t; }
tag({ name: "x" }, "plain");
return await agent("s").ask<string>("q");
`);
  });

  it("converges for a nested literal argument written through two levels", () => {
    analyze(`
function deep(p: { inner: { items: string[] } }, t: string): void { p.inner.items.push(t); }
const t = await agent("s").ask<string>("q");
deep({ inner: { items: [] } }, t);
return t;
`);
  });

  it("makes the field written on the literal visible through the reference the callee returns", () => {
    // Persistence is not only about termination: the note now survives to the reader.
    const { causality } = analyze(`
function tag(box: { name: string; note?: string }, t: string): { name: string; note?: string } {
  box.note = t;
  return box;
}
const t = await agent("writer").ask<string>("draft");
const r = tag({ name: "x" }, t);
return agent("reader").ask<string>(\`use \${r.note}\`);
`);
    expect(hasEdge(causality.edges, "ask#1", "ask#2")).toBe(true);
  });

  it("keeps a literal's field that stores a live place aliased to that place", () => {
    // `{ box }` stores box's slot itself; the persistent literal place must not turn that alias
    // into a copy on later passes (heap-aliasing-param-literal-wrap pins the golden).
    const { causality } = analyze(`
const box: { f: string } = { f: "" };
async function poke(p: { box: { f: string } }): Promise<void> {
  p.box.f = await agent("writer").ask<string>("secret");
}
await poke({ box });
return agent("reader").ask<string>(\`use \${box.f}\`);
`);
    expect(hasEdge(causality.edges, "ask#1", "ask#2")).toBe(true);
  });

  it("re-evaluates the literal every pass (a site inside it is never short-circuited)", () => {
    // The place is reached only through evaluation, never through resolvePlace, so the ask
    // nested in the literal keeps its node and its edge.
    const { causality } = analyze(`
const seed = await agent("seed").ask<string>("s");
const bundle = { text: await agent("writer").ask<string>(seed), tag: "x" };
return agent("reader").ask<string>(bundle.text);
`);
    expect(hasEdge(causality.edges, "ask#1", "ask#2")).toBe(true);
    expect(hasEdge(causality.edges, "ask#2", "ask#3")).toBe(true);
  });
});

describe("convergence — the keystone-leak family (recorded real scripts, 2026-09-03)", () => {
  // Seven recorded workflows stopped converging when a library member call started dispatching
  // on tracked functions carried by its receiver: the keystone pot had leaked the callback
  // itself into the result of `sort(cmp)` / `JSON.parse(text, reviver)`, so a later
  // `top.push({ … })` applied the callback with the literal as its actual and hit the
  // write-back above. Two independent tightenings close the path (the pot strips callables,
  // library members never dispatch on receiver fns); the literal place removes the cliff.
  it("sort comparator, then push of a literal into the sorted result", () => {
    analyze(`
interface C { name: string; confidence: number }
const candidates = await agent("s").ask<C[]>("q");
const top = candidates.sort((a, b) => b.confidence - a.confidence);
top.push({ name: "x", confidence: 0.5 });
return top;
`);
  });

  it("JSON.parse reviver (no registry entry), then push of a literal", () => {
    analyze(`
interface C { name: string; confidence: number }
const text = await agent("s").ask<string>("q");
const top = JSON.parse(text, (k, v) => v) as C[];
top.push({ name: "x", confidence: 0.5 });
return top;
`);
  });

  it("String.replace callback, then a literal pushed into a sibling field", () => {
    analyze(`
interface C { name: string; confidence: number }
const text = await agent("s").ask<string>("q");
const holder = { items: [] as C[], text: text.replace(/x/g, (m) => m.toUpperCase()) };
holder.items.push({ name: holder.text, confidence: 0.5 });
return holder;
`);
  });
});

describe("convergence — placeholder resolution is linear in the placeholder graph", () => {
  // 一个被很多处共用的 callback 包装器（`limited(slots, async () => …)` 这类限流 helper）的
  // 摘要是所有 callback 返回值的并集，各调用方的参数占位符原样穿过它，于是每个调用方的实参
  // 都含有每个调用方的占位符——占位符图是完全图。发射期曾按「栈上去重、不记忆」逐条枚举
  // 简单路径，完全图上是 n! 量级（9 个调用方 19 秒，用户脚本 4GB 堆 OOM）。界限故意放得很松：
  // 未修复的实现在 12 个调用方上要跑几个小时，不会因为机器慢而误报。
  function sharedLimiter(callers: number): string {
    let script = `interface Slots { free: number }
const slots: Slots = { free: 4 };
async function limited<T>(slots: Slots, fn: () => Promise<T>): Promise<T> {
  while (slots.free <= 0) await Promise.resolve();
  slots.free -= 1;
  try { return await fn(); } finally { slots.free += 1; }
}
const results: string[] = [];
`;
    for (let i = 0; i < callers; i += 1) {
      script += `async function step${i}(x: string): Promise<string> {
  return limited(slots, async () => (await agent("a${i}").ask<string>(\`do ${i} \${x}\`)) + x);
}
results.push(await step${i}(results.join(",")));
`;
    }
    script += `async function nested(x: string): Promise<string> {
  return limited(slots, async () => {
    let acc = x;
    acc = await limited(slots, async () => agent("n0").ask<string>(\`inner \${acc}\`));
    acc = await limited(slots, async () => agent("n1").ask<string>(\`inner \${acc}\`));
    return acc;
  });
}
results.push(await nested(results.join(",")));
return results;
`;
    return script;
  }

  it("resolves a dozen callers of one shared callback helper without enumerating paths", () => {
    const callers = 12;
    const started = Date.now();
    const { result } = analyze(sharedLimiter(callers));
    expect(Date.now() - started).toBeLessThan(10_000);
    // 提速不改答案：第一个调用方的回答经共用 helper 与 results 流到最后一个调用方的提示，
    // 也流到嵌套闭包里内层调用的提示。
    const dataEdges = (result.graph?.edges ?? []).filter((edge) => edge.kind === "data");
    expect(hasEdge(dataEdges, "ask#1", `ask#${callers}`)).toBe(true);
    expect(hasEdge(dataEdges, "ask#1", `ask#${callers + 1}`)).toBe(true);
  });
});

describe("analysis cost — shapes that once grew exponentially or as a high power", { timeout: 30_000 }, () => {
  // 界限都放得很松（10 秒）：修复前这些形状要跑十几秒到几小时，修复后在一秒上下，不会因机器慢而误报。
  // vitest 的超时另放宽到 30 秒：分析是同步的，满载跑全套时单个用例会被拖慢，超时只防真正卡死。
  const BOUND_MS = 10_000;
  const dataEdges = (result: ReturnType<typeof analyzeWorkflowScript>) =>
    (result.graph?.edges ?? []).filter((edge) => edge.kind === "data");

  function timed(script: string) {
    const started = Date.now();
    const out = analyze(script);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    return out.result;
  }

  // 方法链：每一环曾把接收者求值两到三遍，k 环就是 2^k / 3^k（`.trim()` × 20 用了 13 秒）。
  it("evaluates each receiver of a long method chain once", () => {
    const trim = timed(`const draft = await agent("w").ask<string>("write");
const clean = draft${".trim()".repeat(30)};
return await agent("r").ask<string>(\`review \${clean}\`);
`);
    expect(hasEdge(dataEdges(trim), "ask#1", "ask#2")).toBe(true);

    const then = timed(`const p = agent("w").ask<string>("write")${'.then((x) => x + "!")'.repeat(20)};
return await agent("r").ask<string>(\`review \${await p}\`);
`);
    expect(hasEdge(dataEdges(then), "ask#1", "ask#2")).toBe(true);

    const sets = Array.from({ length: 24 }, (_, i) => `.set("k${i}", draft)`).join("");
    const mapSet = timed(`const draft = await agent("w").ask<string>("write");
const m = new Map<string, string>();
m${sets};
return await agent("r").ask<string>(\`review \${m.get("k0")}\`);
`);
    expect(hasEdge(dataEdges(mapSet), "ask#1", "ask#2")).toBe(true);

    // 名为 add 的方法同时走堆变更与普通调用两条路，曾是 3^k。
    const builder = timed(`class Pipe {
  items: string[] = [];
  add(x: string): Pipe { this.items.push(x); return this; }
}
const draft = await agent("w").ask<string>("write");
const pipe = new Pipe()${".add(draft)".repeat(20)};
return await agent("r").ask<string>(\`review \${pipe.items.join(",")}\`);
`);
    expect(hasEdge(dataEdges(builder), "ask#1", "ask#2")).toBe(true);
  });

  // 一个攒着 n 个标签的值被读 n 次：每加一个标签曾扫一遍整个标签集，约 n^3（n=600 用了 5.7 秒，n=800 约 13 秒）。
  it("reads a value that carries hundreds of labels hundreds of times", () => {
    const n = 800;
    let script = `const ps = [${Array.from({ length: n }, (_, i) => `agent("a${i}").ask<string>("q${i}")`).join(", ")}];\n`;
    for (let j = 0; j < n; j += 1) script += `const v${j}: string = "s" + ps.length;\n`;
    script += "return await Promise.all(ps);\n";
    const result = timed(script);
    expect(hasEdge(dataEdges(result), "ask#1", "sink")).toBe(true);
    expect(hasEdge(dataEdges(result), `ask#${n}`, "sink")).toBe(true);
  });

  // 被许多阶段共用的 helper：每个 step 按认领它的阶段拷成 k 份，边按拷贝对逐对判时间可行性。
  // 每对都调一次 sharesIteration，它曾每次重新过滤站点出现过的全部 region（共用 helper 有
  // 上千个），代价是拷贝对数 × region 数（25/25/250 用了 33 秒）。
  it("projects phase copies of a helper shared by hundreds of phases", () => {
    const fanouts = 25;
    const helpers = 25;
    const calls = 250;
    let script = `const items: string[] = ["a", "b", "c"];
async function helper0(x: string): Promise<string> { return agent(\`h0-\${x}\`).ask<string>(\`do \${x}\`); }
`;
    for (let i = 1; i < helpers; i += 1) {
      script += `async function helper${i}(x: string): Promise<string> {
  const r = await helper${i - 1}(x);
  return agent(\`h${i}-\${x}\`).ask<string>(\`step ${i} \${r}\`);
}
`;
    }
    script += "const out: string[] = [];\n";
    for (let f = 0; f < fanouts; f += 1) {
      script += `phase("f${f}");\nout.push(...(await Promise.all(items.map(async (x) => helper${helpers - 1}(x + "${f}")))));\n`;
    }
    for (let m = 0; m < calls; m += 1) script += `phase("m${m}");\nout.push(await helper${m % helpers}("m${m}"));\n`;
    script += "return out;\n";
    const result = timed(script);
    expect(result.causality?.phases?.length).toBe(fanouts + calls);
    // helper0 的 ask 在每个阶段都被发出，所以它有一份拷贝对应每个阶段。
    const copies = (result.causality?.steps ?? []).filter((step) => step.source === "ask#1");
    expect(copies).toHaveLength(fanouts + calls);
  });

  // 一串互相 await 的 async helper 被很多处调用：每个 await 曾扫一遍目前开过的所有 strand，
  // 走查时间是 trace 长度的平方（80/80/800 时走查 16 秒）。只计时不动点加走查（interpret）：
  // 这个形状的控制流投影另有平方级的边数（顺序 await 的每一步连到之后每一步），那是投影规则的事。
  it("walks a long chain of awaiting helpers called from many places", () => {
    const fanouts = 80;
    const helpers = 80;
    const calls = 800;
    let script = `const items: string[] = ["a", "b", "c"];
async function helper0(x: string): Promise<string> { return agent(\`h0-\${x}\`).ask<string>(\`do \${x}\`); }
`;
    for (let i = 1; i < helpers; i += 1) {
      script += `async function helper${i}(x: string): Promise<string> {
  const r = await helper${i - 1}(x);
  return agent(\`h${i}-\${x}\`).ask<string>(\`step ${i} \${r}\`);
}
`;
    }
    script += "const out: string[] = [];\n";
    for (let f = 0; f < fanouts; f += 1) {
      script += `out.push(...(await Promise.all(items.map(async (x) => helper${helpers - 1}(x + "${f}")))));\n`;
    }
    for (let m = 0; m < calls; m += 1) script += `out.push(await helper${m % helpers}("m${m}"));\n`;
    script += "return out;\n";
    const workflow = createWorkflowProgram(script);
    const started = Date.now();
    const core = interpret(workflow, collectSites(workflow));
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    expect(core.trace.events.length).toBeGreaterThan(calls);
  });

  // 一个 helper 被 k 处调用、各传一个回调：`fn()` 曾把每个调用者的回调都内联一遍（k² 份函数体，
  // 40 处 4.4 秒、80 处跑不完）。现在按调用点的绑定只内联自己的那一个：call 区域正好 2k 个。
  it("inlines one callback per call of a helper shared by hundreds of callers", () => {
    const callers = 200;
    let script = "async function limited(fn: () => Promise<string>): Promise<string> { return await fn(); }\nconst out: string[] = [];\n";
    for (let i = 0; i < callers; i += 1) {
      script += `out.push(await limited(async () => agent("c${i}").ask<string>("do ${i}")));\n`;
    }
    script += "return out;\n";
    const workflow = createWorkflowProgram(script);
    const started = Date.now();
    const core = interpret(workflow, collectSites(workflow));
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    expect(core.trace.regions.filter((region) => region.kind === "call")).toHaveLength(2 * callers);
    expect(core.trace.regions.filter((region) => region.kind === "choice")).toEqual([]);
  });

  // L 层包装（每层把自己的参数包成新箭头交给下一层）、n 个调用者：曾是 n^(L+1) 份函数体
  // （8 × 3 层 50 秒、2.2 GB）。现在每个调用者的链是 2L 个 call 区域。
  it("inlines one chain per caller through nested wrapper layers", () => {
    const callers = 8;
    const layers = 3;
    let script = "async function w1(fn: () => Promise<string>): Promise<string> { return await fn(); }\n";
    for (let l = 2; l <= layers; l += 1) {
      script += `async function w${l}(fn: () => Promise<string>): Promise<string> { return await w${l - 1}(() => fn()); }\n`;
    }
    script += "const out: string[] = [];\n";
    for (let i = 0; i < callers; i += 1) {
      script += `out.push(await w${layers}(async () => agent("c${i}").ask<string>("do ${i}")));\n`;
    }
    script += "return out;\n";
    const workflow = createWorkflowProgram(script);
    const started = Date.now();
    const core = interpret(workflow, collectSites(workflow));
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    expect(core.trace.regions.filter((region) => region.kind === "call")).toHaveLength(2 * layers * callers);
  });
});
