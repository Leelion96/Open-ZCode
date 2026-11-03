import ts from "typescript";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { HoleSite, IterationCandidate, SiteTable } from "./sites.js";
import {
  addOcc,
  addPlaceholder,
  collapse,
  emptyValue,
  isActorSite,
  isFunctionLike,
  mergeInto,
  phKey,
  provisionalFanoutId,
  type AbstractValue,
  type Placeholder,
  type PromotedFanout,
  type TaintFacts,
  type TaintOcc,
} from "./domain.js";
import { findWorkflowBody } from "./domain.js";

/**
 * The mutable fixpoint state of the taint pass: the site lookups, the global
 * environment, function summaries, the reachability/promotion sets, and the sink
 * accumulators. The evaluator (taint.ts) drives it; this module owns the storage,
 * the monotone update primitives (each reports growth via `changed`), and the final
 * placeholder-resolving emission of {@link TaintFacts}.
 */
/** How a function reached a call site: as the thing called, or as an argument a library may invoke. */
export type ApplicationVia = "callee" | "argument";

/** Parameter `param` of the tracked script function `fn`. */
export interface ParamRef {
  fn: ts.Node;
  param: number;
}

/**
 * A parameter named at a site, with the functions the site's merged record owes to it: what
 * the parameter's slot held when the record was made (docs/analysis.md "The call oracle").
 */
export interface ThroughParam extends ParamRef {
  accounted: Set<ts.Node>;
}

/** What an argument binds to the parameter it fills at a callee application. */
export interface ArgBinding {
  /** Every tracked function the argument's value held — the merged answer. */
  fns: Set<ts.Node>;
  /** The argument was itself a parameter of its enclosing function: resolve it there. */
  through: ThroughParam[];
}

export class TaintState {
  readonly checker: ts.TypeChecker;
  readonly program: ts.Program;
  readonly scriptFile: ts.SourceFile;
  readonly body: ts.Block;

  // Site lookups keyed by their raw AST nodes (the table resolved them via the checker).
  readonly askByCall = new Map<ts.CallExpression, string>();
  readonly askSites = new Map<string, { receiver: ts.Expression; instructions: ts.Expression | undefined }>();
  readonly worldByCall = new Map<ts.CallExpression, { id: string; args: readonly ts.Expression[] }>();
  readonly joinByCall = new Map<ts.CallExpression, { id: string; arg: ts.Expression | undefined }>();
  readonly actorByCall = new Map<ts.CallExpression, string>();
  /** 留白调用 → 站点（开放与已补全都在；transfer 规则按有无 body 分派）。 */
  readonly holeByCall = new Map<ts.CallExpression, HoleSite>();
  /** Per-element callback calls (`xs.map(fn)`, `Array.from(xs, fn)`, …), keyed by the CALL. */
  readonly candByCall = new Map<ts.CallExpression, IterationCandidate>();
  readonly candByForOf = new Map<ts.Node, IterationCandidate>();
  /**
   * THE CALL ORACLE: for every call / `new` /
   * tagged-template node, the script-local functions this pass applied there and HOW —
   * `callee` (the node's callee value held the function: direct call, through a parameter,
   * a field, a class member) or `argument` (the node handed the function to a library callee
   * that may invoke it: a registry entry or the keystone rule). Monotone like every other
   * accumulator; read after convergence by the ordering walk, which inlines exactly these
   * bodies at exactly these sites instead of guessing from syntax.
   */
  readonly applications = new Map<ts.Node, Map<ts.Node, ApplicationVia>>();
  /**
   * PROVENANCE for {@link applications}: at this site, the functions applied as `via` came
   * from the named parameter of an enclosing function (the callee, or a function-valued
   * argument, was syntactically that parameter). Keyed by `fnId:param:via`. The merged
   * record stays beside it; the walk swaps the accounted functions for the binding of the
   * activation it is inlining (docs/analysis.md "Inlining").
   */
  readonly throughParams = new Map<ts.Node, Map<string, ThroughParam & { via: ApplicationVia }>>();
  /** Per callee application: what each argument bound to the callee's parameters. */
  readonly bindings = new Map<ts.Node, Map<ts.Node, ArgBinding[]>>();
  /** Parameters assigned somewhere in their function's body, per function; see {@link parameterRefOf}. */
  private readonly reassignedParams = new Map<number, Set<ts.Symbol>>();
  /**
   * The live abstract result of each `Promise.all` join call, keyed by the join CALL NODE
   * and PERSISTENT across fixpoint passes (see {@link joinResultOf}). A join result IS a
   * place whose element fields carry may-alias back-references to the (place) inputs, so
   * resolvePlace returns it — letting `const [a, b] = await Promise.all([…])`
   * destructure-alias the elements and a write through `res[k]` reach the original input.
   */
  readonly joinResults = new Map<ts.CallExpression, AbstractValue>();
  /**
   * The live abstract place of each conditional expression used as a place
   * (`flag ? box1 : box2`), keyed by the ConditionalExpression NODE and persistent across
   * passes (see {@link condPlaceOf}). Same canonical-heap requirement as {@link joinResults}.
   */
  readonly condPlaces = new Map<ts.ConditionalExpression, AbstractValue>();
  /** Allocation-site places of container literals; see {@link literalPlaceOf}. */
  readonly literalPlaces = new Map<ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, AbstractValue>();

  // Script-local functions (excluding iteration callbacks, handled inline).
  readonly fnId = new Map<ts.Node, number>();
  readonly fnParamSymbols = new Map<number, (ts.Symbol | undefined)[]>();
  readonly functions: ts.Node[] = [];
  readonly callbackNodes = new Set<ts.Node>();
  /**
   * Object-literal set accessors, keyed by property name -> setter fn ids. Crude but
   * sound: an assignment to ANY property of that name (on any object) records the
   * assigned value as the setter's param-0 actual, so the setter body's flow is seen.
   */
  readonly settersByProp = new Map<string, number[]>();

  /**
   * One shared abstract instance per class declaration/expression, keyed by the class
   * node. Static AND instance members conflate into this ONE value (a deliberate sound
   * over-approximation: per-instance and static/instance precision are out of scope, so
   * a write through any instance, through `this`, or through the class name is visible
   * through every other). Persistent across fixpoint passes — growth is signalled like
   * any env slot.
   */
  readonly classInstances = new Map<ts.Node, AbstractValue>();
  /** Class declarations/expressions in the workflow body, in discovery order. */
  readonly classes: ts.Node[] = [];

  // Persistent fixpoint state.
  readonly env = new Map<ts.Symbol, AbstractValue>();
  readonly summaries = new Map<number, AbstractValue>();
  readonly paramActuals = new Map<string, AbstractValue>();
  /**
   * Per-placeholder-parameter set of values that MAY be passed to an INVOCATION of that
   * parameter (keyed by `${fnId}:${param}`). Two capture sites (calls.ts handleUnknownCall):
   * a direct call of a placeholder callee (`resolve(draft)` — resolve is param 0), and a
   * placeholder-valued argument to an unknown call (`draft.then(onOk)` — the unknown `.then`
   * may invoke onOk with the receiver pot). Consumed by the promise machinery: `new
   * Unknown(fn)` and `await thenable` resolve to whatever fn's / then's callback params
   * receive (the resolve/reject/continuation pattern). Distinct from {@link paramActuals},
   * which records what a function receives when IT is called.
   */
  readonly phCallActuals = new Map<string, AbstractValue>();
  readonly reachSet = new Set<string>();
  readonly calledFns = new Map<string, Set<number>>();
  readonly promotedOrders = new Set<number>();
  /**
   * Per-`reduce`-candidate accumulator taint (keyed by candidate `order`), carried
   * ACROSS fixpoint passes. The callback-return value that reduce threads into the
   * accumulator param is a fresh local each pass, so binding the param from it
   * directly never observed the return taint; this persistent slot fixes that.
   */
  readonly reduceAcc = new Map<number, AbstractValue>();

  // Sink accumulators (may contain placeholders; resolved at emission).
  readonly askInstr = new Map<string, AbstractValue>();
  readonly askRecv = new Map<string, AbstractValue>();
  readonly worldRead = new Map<string, AbstractValue>();
  /** 开放留白的提示 sink（docs/analysis.md「Sites」：提示流入留白，如 ask 的 instructions）。 */
  readonly holePrompt = new Map<string, AbstractValue>();
  readonly joinInByPort = new Map<string, Map<number, AbstractValue>>();
  readonly fanoutInVal = new Map<string, AbstractValue>();
  /**
   * The ORACLE accumulators, keyed by source START OFFSET rather than by site id: the
   * value each `await` operand carries, and the value each guard expression reads. They
   * feed {@link emitOracle}, which only the temporal walk (causality-order.ts) consumes —
   * nothing here changes a transfer rule, and a position keys nothing in the site
   * vocabulary, which is what keeps the site-id stability rule untouched: no `order`
   * counter and no per-kind counter is consulted.
   */
  readonly awaitVal = new Map<number, AbstractValue>();
  readonly guardVal = new Map<number, AbstractValue>();
  readonly returnVal = emptyValue();
  /**
   * One script-global thrown-value set: every `throw` joins its operand into it and
   * every `catch` binding reads all of it. A flow-insensitive over-approximation of
   * exception routing — sound under gen-only, deliberately imprecise across disjoint
   * `try` blocks. Persistent across passes so throws in one iteration reach catches
   * in the next (fixpoint-safe).
   */
  readonly thrownVal = emptyValue();

  changed = false;

  constructor(
    workflow: WorkflowProgram,
    readonly table: SiteTable,
  ) {
    this.checker = workflow.program.getTypeChecker();
    this.program = workflow.program;
    this.scriptFile = workflow.scriptFile;
    this.body = findWorkflowBody(workflow.scriptFile);
    this.buildLookups();
    this.collectFunctions();
  }

  private buildLookups(): void {
    for (const site of this.table.asks) {
      this.askByCall.set(site.call, site.id);
      this.askSites.set(site.id, { instructions: site.instructions, receiver: site.receiver });
    }
    for (const site of this.table.worldReads) this.worldByCall.set(site.call, { args: site.args, id: site.id });
    for (const site of this.table.joins) this.joinByCall.set(site.call, { arg: site.arg, id: site.id });
    for (const site of this.table.actors) this.actorByCall.set(site.call, site.id);
    for (const site of this.table.holes) this.holeByCall.set(site.call, site);
    for (const cand of this.table.iterations) {
      if (cand.form === "array-method" && cand.call !== undefined) {
        this.candByCall.set(cand.call, cand);
        // An inline callback literal is evaluated in place (array-methods.ts), never as a
        // tracked function; a non-literal callback's functions are tracked and applied.
        if (cand.callback !== undefined) this.callbackNodes.add(cand.callback);
      } else if (cand.form === "for-of") {
        // candidate.body === ForOfStatement.statement, so body.parent is the for-of.
        this.candByForOf.set(cand.body.parent, cand);
      }
    }
  }

  private collectFunctions(): void {
    const visit = (node: ts.Node): void => {
      // One shared abstract instance per class (declaration or expression); constructors,
      // methods and accessors are collected as tracked functions below (isFunctionLike
      // covers them), so their bodies get summaries like any other function.
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        this.classInstances.set(node, emptyValue());
        this.classes.push(node);
      }
      if (isFunctionLike(node) && !this.callbackNodes.has(node)) {
        const id = this.functions.length;
        this.fnId.set(node, id);
        this.functions.push(node);
        const decl = node as ts.SignatureDeclaration;
        this.fnParamSymbols.set(
          id,
          decl.parameters.map((p) =>
            ts.isIdentifier(p.name) ? this.checker.getSymbolAtLocation(p.name) : undefined,
          ),
        );
        // Object-literal set accessor: index it by property name so property writes
        // can feed the setter's param (see settersByProp).
        if (ts.isSetAccessorDeclaration(node) && !ts.isComputedPropertyName(node.name)) {
          const name = node.name.getText(this.scriptFile);
          const list = this.settersByProp.get(name);
          if (list === undefined) this.settersByProp.set(name, [id]);
          else list.push(id);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const stmt of this.body.statements) visit(stmt);
  }

  // -- monotone update primitives ------------------------------------------

  /**
   * Bind a symbol to an abstract value. A FRESH symbol ADOPTS the value object by
   * reference (`env[sym] === value`); an already-bound slot weak-merges (sound smear).
   * Adoption is what makes bindings alias rather than snapshot: passing a live place (env slot / live field) shares it, so a later
   * write through any alias is visible through every other. Callers that must NOT
   * alias pass a fresh clone/collapse (reads already return snapshots).
   */
  bindSymbol(sym: ts.Symbol, value: AbstractValue): void {
    const existing = this.env.get(sym);
    if (existing === undefined) {
      this.env.set(sym, value);
      this.changed = true;
      return;
    }
    if (existing !== value && mergeInto(existing, value)) this.changed = true;
  }

  envSlot(sym: ts.Symbol): AbstractValue {
    let slot = this.env.get(sym);
    if (slot === undefined) {
      slot = emptyValue();
      this.env.set(sym, slot);
    }
    return slot;
  }

  summaryOf(id: number): AbstractValue {
    let slot = this.summaries.get(id);
    if (slot === undefined) {
      slot = emptyValue();
      this.summaries.set(id, slot);
    }
    return slot;
  }

  /** The shared abstract instance of a class node, created empty on demand (persistent). */
  instanceOf(cls: ts.Node): AbstractValue {
    let inst = this.classInstances.get(cls);
    if (inst === undefined) {
      inst = emptyValue();
      this.classInstances.set(cls, inst);
    }
    return inst;
  }

  /**
   * The shared abstract result of a join call, created empty on demand (persistent).
   *
   * THE CANONICAL-HEAP INVARIANT: every value that models runtime storage — anything that
   * can be aliased, written through, or referenced from a `mayAlias` set — is keyed by a
   * static program point and lives across fixpoint passes; per-pass temporaries are
   * snapshots only. handleJoin used to mint a FRESH result value each pass, so
   * `Promise.all([Promise.all([…])])` added a never-before-seen object to the outer
   * element's `mayAlias` set every pass. That set dedups by IDENTITY (domain.ts), so
   * `changed` stayed true forever and the fixpoint hit ITERATION_CAP. Keying the result by
   * the call node makes the identity stable, so the union saturates.
   */
  joinResultOf(call: ts.CallExpression): AbstractValue {
    let result = this.joinResults.get(call);
    if (result === undefined) {
      result = emptyValue();
      this.joinResults.set(call, result);
    }
    return result;
  }

  /**
   * The shared abstract place of a conditional expression, created empty on demand
   * (persistent). Same canonical-heap invariant as {@link joinResultOf}: a per-pass
   * wrapper for `flag ? box1 : box2` diverged the fixpoint as soon as it became a
   * `mayAlias` target — which a SYNTACTICALLY NESTED ternary place
   * (`f2 ? (f ? box1 : box2) : box3`) does on every pass.
   */
  condPlaceOf(node: ts.ConditionalExpression): AbstractValue {
    let place = this.condPlaces.get(node);
    if (place === undefined) {
      place = emptyValue();
      this.condPlaces.set(node, place);
    }
    return place;
  }

  /**
   * The allocation-site place of a container literal (`{…}` / `[…]`): the value its first
   * evaluation produced, kept across passes and weak-merged with every re-evaluation
   * (persistent). Same canonical-heap invariant as {@link joinResultOf}: a literal IS runtime
   * storage — a callee writes through it (`fill([], v)`, `tag({ name }, t)` with
   * `box.note = t`), a binding adopts it, a spread shares its fields — so a value recreated
   * every pass can never settle once something persistent merges INTO it. The
   * parameter write-back targeted the per-pass fresh literal, reported a change on every pass
   * (the note it had just added was gone again), and the fixpoint hit ITERATION_CAP with no
   * state growing at all. Any `f({ … })` whose callee mutates its parameter was affected.
   *
   * Adopting the first evaluation (rather than minting an empty slot) keeps the literal's
   * aliasing: a field that stores a live place (`{ box }`, `[obj]`) keeps pointing at that
   * slot, and later passes merge the same slot into itself — an identity no-op. Snapshot
   * fields accumulate monotonically, exactly as an env slot bound to the literal always did.
   */
  literalPlaceOf(node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, fresh: AbstractValue): AbstractValue {
    const place = this.literalPlaces.get(node);
    if (place === undefined) {
      this.literalPlaces.set(node, fresh);
      return fresh;
    }
    if (mergeInto(place, fresh)) this.changed = true;
    return place;
  }

  mergeReturn(value: AbstractValue): void {
    if (mergeInto(this.returnVal, value)) this.changed = true;
  }

  /** Join a thrown operand into the script-global thrown-value set. */
  mergeThrown(value: AbstractValue): void {
    if (mergeInto(this.thrownVal, value)) this.changed = true;
  }

  /**
   * Weak-merge into a keyed sink accumulator. Generic in the key so the oracle
   * accumulators ({@link awaitVal} / {@link guardVal}), which are keyed by source offset
   * rather than site id, share the one monotone update path every other sink uses.
   */
  mergeSink<K>(map: Map<K, AbstractValue>, id: K, value: AbstractValue): void {
    let slot = map.get(id);
    if (slot === undefined) {
      slot = emptyValue();
      map.set(id, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  mergeJoinIn(id: string, port: number, value: AbstractValue): void {
    let ports = this.joinInByPort.get(id);
    if (ports === undefined) {
      ports = new Map();
      this.joinInByPort.set(id, ports);
    }
    let slot = ports.get(port);
    if (slot === undefined) {
      slot = emptyValue();
      ports.set(port, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  addParamActual(id: number, param: number, value: AbstractValue): void {
    const key = `${id}:${param}`;
    let slot = this.paramActuals.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      this.paramActuals.set(key, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  /** Record a value that may reach an invocation of the placeholder-parameter `key`. */
  recordPhCall(key: string, value: AbstractValue): void {
    let slot = this.phCallActuals.get(key);
    if (slot === undefined) {
      slot = emptyValue();
      this.phCallActuals.set(key, slot);
    }
    if (mergeInto(slot, value)) this.changed = true;
  }

  /** The taint fed to invocations of a function's parameter `param`, if any. */
  phCallActualsOf(id: number, param: number): AbstractValue | undefined {
    return this.phCallActuals.get(`${id}:${param}`);
  }

  /** The persistent accumulator taint for a `reduce` candidate (empty until seeded). */
  reduceAccOf(order: number): AbstractValue {
    let slot = this.reduceAcc.get(order);
    if (slot === undefined) {
      slot = emptyValue();
      this.reduceAcc.set(order, slot);
    }
    return slot;
  }

  /** Merge a pass's callback-return taint into a `reduce` candidate's accumulator. */
  mergeReduceAcc(order: number, value: AbstractValue): void {
    if (mergeInto(this.reduceAccOf(order), value)) this.changed = true;
  }

  /**
   * Record a call against EVERY enclosing region, mirroring {@link markFacade}.
   * Recording only the innermost region left a caller function `fn@f`
   * unmarked when its call to `g` happened inside an iteration candidate's callback
   * (region `cand@N`). Reachability then never propagated `fn@f`, so a sibling
   * candidate whose callback calls `f` failed to promote to a fan-out — an
   * under-approximation (a dropped may-flow), which this analysis must never do.
   */
  markCalled(regionStack: string[], id: number): void {
    for (const region of regionStack) {
      let called = this.calledFns.get(region);
      if (called === undefined) {
        called = new Set();
        this.calledFns.set(region, called);
      }
      if (!called.has(id)) {
        called.add(id);
        this.changed = true;
      }
    }
  }

  /** Record that `fn` was applied at `site` (see {@link applications}). Not a fixpoint
   * signal: applications feed no transfer rule, and the final pass re-records them all. */
  recordApplication(site: ts.Node, fn: ts.Node, via: ApplicationVia): void {
    let applied = this.applications.get(site);
    if (applied === undefined) {
      applied = new Map();
      this.applications.set(site, applied);
    }
    // `callee` wins over `argument` for one function at one site (both can happen for a
    // function passed to itself; the callee reading is the one that surely runs).
    if (applied.get(fn) !== "callee") applied.set(fn, via);
  }

  /**
   * The parameter an expression IS, syntactically: a bare identifier declared as a parameter
   * of a tracked function, with no default, not a rest parameter, never assigned in the body.
   * Only then does the parameter's slot hold exactly what callers passed, so a call site's
   * binding can stand in for the merged record. Anything else has no usable provenance.
   */
  parameterRefOf(expr: ts.Node): ParamRef | undefined {
    if (!ts.isIdentifier(expr)) return undefined;
    const sym = this.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (sym === undefined || decl === undefined || !ts.isParameter(decl)) return undefined;
    if (!ts.isIdentifier(decl.name) || decl.initializer !== undefined || decl.dotDotDotToken !== undefined) {
      return undefined;
    }
    const fn = decl.parent;
    const id = this.fnId.get(fn);
    if (id === undefined) return undefined;
    const param = (this.fnParamSymbols.get(id) ?? []).indexOf(sym);
    if (param < 0 || this.assignedParamsOf(id, fn).has(sym)) return undefined;
    return { fn, param };
  }

  /** Record that the functions applied at `site` as `via` came through `ref` (see {@link throughParams}). */
  recordThroughParam(site: ts.Node, ref: ParamRef, via: ApplicationVia, accounted: Iterable<ts.Node>): void {
    let records = this.throughParams.get(site);
    if (records === undefined) {
      records = new Map();
      this.throughParams.set(site, records);
    }
    const key = `${this.fnId.get(ref.fn)}:${ref.param}:${via}`;
    const existing = records.get(key);
    if (existing === undefined) records.set(key, { ...ref, accounted: new Set(accounted), via });
    else for (const fn of accounted) existing.accounted.add(fn);
  }

  /** Record what argument `param` of `callee` bound at `site` (see {@link bindings}). */
  recordBinding(site: ts.Node, callee: ts.Node, param: number, value: AbstractValue, through: ParamRef | undefined): void {
    let byCallee = this.bindings.get(site);
    if (byCallee === undefined) {
      byCallee = new Map();
      this.bindings.set(site, byCallee);
    }
    let list = byCallee.get(callee);
    if (list === undefined) {
      list = [];
      byCallee.set(callee, list);
    }
    let slot = list[param];
    if (slot === undefined) {
      slot = { fns: new Set(), through: [] };
      list[param] = slot;
    }
    const tracked = [...value.fns].filter((fn) => this.fnId.has(fn));
    for (const fn of tracked) slot.fns.add(fn);
    if (through === undefined) return;
    const existing = slot.through.find((t) => t.fn === through.fn && t.param === through.param);
    if (existing === undefined) slot.through.push({ ...through, accounted: new Set(tracked) });
    else for (const fn of tracked) existing.accounted.add(fn);
  }

  /** The parameter symbols of function `id` that its body assigns to (any assignment target naming them). */
  private assignedParamsOf(id: number, fn: ts.Node): Set<ts.Symbol> {
    const cached = this.reassignedParams.get(id);
    if (cached !== undefined) return cached;
    const params = new Set((this.fnParamSymbols.get(id) ?? []).filter((sym) => sym !== undefined));
    const assigned = new Set<ts.Symbol>();
    const target = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const sym = this.checker.getSymbolAtLocation(node);
        if (sym !== undefined && params.has(sym)) assigned.add(sym);
        return;
      }
      ts.forEachChild(node, target);
    };
    const scan = (node: ts.Node): void => {
      const assigns =
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      if (assigns) target((node as ts.BinaryExpression).left);
      else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) target(node.operand);
      else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
        target(node.initializer);
      }
      ts.forEachChild(node, scan);
    };
    const body = (fn as ts.SignatureDeclaration & { body?: ts.Node }).body;
    if (body !== undefined) scan(body);
    this.reassignedParams.set(id, assigned);
    return assigned;
  }

  /** Mark every enclosing region as reaching a facade site. */
  markFacade(regionStack: string[]): void {
    for (const region of regionStack) {
      if (!this.reachSet.has(region)) {
        this.reachSet.add(region);
        this.changed = true;
      }
    }
  }

  /** Propagate reachability across the call graph until it stops growing. */
  propagateReachability(): void {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [region, fns] of this.calledFns) {
        if (this.reachSet.has(region)) continue;
        for (const id of fns) {
          if (this.reachSet.has(`fn@${id}`)) {
            this.reachSet.add(region);
            this.changed = true;
            grew = true;
            break;
          }
        }
      }
    }
  }

  /** Promote iteration candidates whose body region reaches a facade site. */
  recomputePromotion(): void {
    for (const cand of this.table.iterations) {
      if (this.promotedOrders.has(cand.order)) continue;
      if (this.reachSet.has(`cand@${cand.order}`)) {
        this.promotedOrders.add(cand.order);
        this.changed = true;
      }
    }
  }

  // -- emission ------------------------------------------------------------

  emitFacts(): TaintFacts {
    const askData = new Map<string, TaintOcc[]>();
    const askActor = new Map<string, TaintOcc[]>();
    const worldReadData = new Map<string, TaintOcc[]>();
    const joinIn = new Map<string, TaintOcc[]>();
    const fanoutIn = new Map<string, TaintOcc[]>();
    const { actor, artifact } = this.resolvers();

    for (const [id, value] of this.askInstr) askData.set(id, artifact(value));
    for (const [id, value] of this.askRecv) askActor.set(id, actor(value));
    for (const [id, value] of this.worldRead) worldReadData.set(id, artifact(value));
    const holeData = new Map<string, TaintOcc[]>();
    for (const [id, value] of this.holePrompt) holeData.set(id, artifact(value));
    for (const [id, ports] of this.joinInByPort) {
      const occs: TaintOcc[] = [];
      for (const [port, value] of ports) {
        for (const occ of artifact(value)) {
          occs.push({ exact: occ.exact, site: occ.site, ...(port >= 0 ? { port } : {}) });
        }
      }
      joinIn.set(id, occs);
    }
    for (const [id, value] of this.fanoutInVal) fanoutIn.set(id, artifact(value));

    const promoted: PromotedFanout[] = this.table.iterations
      .filter((cand) => this.promotedOrders.has(cand.order))
      .sort((a, b) => a.order - b.order)
      .map((cand) => ({ id: provisionalFanoutId(cand.order), label: "fan-out", loc: cand.loc, order: cand.order }));

    return {
      askActor,
      askData,
      fanoutIn,
      holeData,
      joinIn,
      promoted,
      returnData: artifact(this.returnVal),
      worldReadData,
    };
  }

  /**
   * The ordering walk's oracle view, resolved directly off the CONVERGED interpreter
   * state — the fused pass's replacement for the `awaitSettles`/`guardReads` members
   * TaintFacts used to carry.
   * Same keying (`node.getStart(scriptFile)` of the awaited/guard expression) and the
   * SAME resolution pipeline as every artifact sink (placeholders expanded, collapsed,
   * actor labels filtered) — so an awaited parameter still resolves to the union of the
   * promises its callers passed in, across all call sites. That union is normative: the
   * temporal walk must see today's context-INsensitive values bit-for-bit; caller-context
   * precision is explicitly out of scope.
   *
   * Only meaningful after the fixpoint has converged; interpret.ts is the one caller.
   */
  emitOracle(): {
    awaitSettles: Map<number, TaintOcc[]>;
    guardReads: Map<number, TaintOcc[]>;
    applications: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, ApplicationVia>>;
    throughParams: ReadonlyMap<ts.Node, ReadonlyMap<string, ThroughParam & { via: ApplicationVia }>>;
    bindings: ReadonlyMap<ts.Node, ReadonlyMap<ts.Node, readonly ArgBinding[]>>;
  } {
    const { artifact } = this.resolvers();
    const awaitSettles = new Map<number, TaintOcc[]>();
    for (const [pos, value] of this.awaitVal) awaitSettles.set(pos, artifact(value));
    const guardReads = new Map<number, TaintOcc[]>();
    for (const [pos, value] of this.guardVal) guardReads.set(pos, artifact(value));
    return { applications: this.applications, awaitSettles, bindings: this.bindings, guardReads, throughParams: this.throughParams };
  }

  /** Resolve sinks off the converged `paramActuals` ({@link placeholderResolver}), split by label kind. */
  private resolvers(): { actor: (value: AbstractValue) => TaintOcc[]; artifact: (value: AbstractValue) => TaintOcc[] } {
    const resolve = placeholderResolver(this.paramActuals);
    return {
      actor: (value) => resolve(value).filter((occ) => isActorSite(occ.site)),
      artifact: (value) => resolve(value).filter((occ) => !isActorSite(occ.site)),
    };
  }

  bindPlaceholderParams(fn: ts.Node, id: number): void {
    const params = (fn as ts.SignatureDeclaration).parameters;
    (this.fnParamSymbols.get(id) ?? []).forEach((sym, param) => {
      if (sym === undefined) return;
      const val = emptyValue();
      const rest = params[param]?.dotDotDotToken !== undefined;
      addPlaceholder(val, { fnId: id, param, ...(rest ? { rest: true } : {}) });
      this.bindSymbol(sym, val);
    });
  }
}

/**
 * Emission-time placeholder resolution (docs/analysis.md, "Calls"): a value's parameter
 * placeholders expand to the union of the actuals recorded across ALL calls, recursively
 * through the placeholders those actuals carry, and the whole is collapsed to occurrences.
 *
 * That is reachability over the placeholder graph — one node per `paramActuals` slot, its
 * own occurrences being the collapsed actual, an edge to every placeholder the actual carries
 * at any depth (a rest placeholder points at every slot of its function at index >= its
 * param). Every node of one strongly connected component reaches the same set, so the
 * components are resolved once each, in the reverse topological order Tarjan emits them,
 * and every sink becomes a lookup.
 *
 * 修复原因：发射期曾按「栈上去重、不记忆」逐个展开占位符，等于枚举占位符图里的每一条简单
 * 路径。一个被很多处共用的 callback 包装器（`limited(slots, async () => …)`）让每个调用方的
 * 实参都带上所有调用方的占位符，图成了完全图，路径数是 n! 量级：9 个调用方 19 秒，用户脚本在
 * 4GB 堆上 OOM。结果只是出现集的并（发射处总会 collapse，字段结构不出这里），与经过哪条路径
 * 无关，所以按强连通分量求可达闭包得到的是同一个答案，代价是 O(V+E)。
 */
function placeholderResolver(
  paramActuals: ReadonlyMap<string, AbstractValue>,
): (value: AbstractValue) => TaintOcc[] {
  const own = new Map<string, AbstractValue>();
  const slotsByFn = new Map<number, Array<{ key: string; param: number }>>();
  for (const [key, actual] of paramActuals) {
    own.set(key, collapse(actual));
    const sep = key.indexOf(":");
    const fnId = Number(key.slice(0, sep));
    let slots = slotsByFn.get(fnId);
    if (slots === undefined) {
      slots = [];
      slotsByFn.set(fnId, slots);
    }
    slots.push({ key, param: Number(key.slice(sep + 1)) });
  }
  const targets = (ph: Placeholder): string[] => {
    if (ph.rest === true) {
      // A rest formal gathers every actual recorded at index >= ph.param.
      return (slotsByFn.get(ph.fnId) ?? []).filter((slot) => slot.param >= ph.param).map((slot) => slot.key);
    }
    const key = phKey(ph);
    return own.has(key) ? [key] : [];
  };

  // Tarjan: `resolved` maps each slot to its component's shared occurrence set.
  const resolved = new Map<string, AbstractValue>();
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (key: string): void => {
    const order = index.size;
    index.set(key, order);
    low.set(key, order);
    stack.push(key);
    onStack.add(key);
    for (const ph of (own.get(key) as AbstractValue).phs.values()) {
      for (const next of targets(ph)) {
        if (!index.has(next)) {
          visit(next);
          low.set(key, Math.min(low.get(key) as number, low.get(next) as number));
        } else if (onStack.has(next)) {
          low.set(key, Math.min(low.get(key) as number, index.get(next) as number));
        }
      }
    }
    if (low.get(key) !== order) return;
    // `key` roots a component: pop its members. Every successor outside it is already
    // resolved — Tarjan completes a component only after all components it reaches.
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      members.push(member);
    } while (member !== key);
    const occs = emptyValue();
    for (const m of members) resolved.set(m, occs);
    for (const m of members) {
      const actual = own.get(m) as AbstractValue;
      for (const occ of actual.occs.values()) addOcc(occs, occ);
      for (const ph of actual.phs.values()) {
        for (const next of targets(ph)) {
          const done = resolved.get(next) as AbstractValue;
          if (done === occs) continue;
          for (const occ of done.occs.values()) addOcc(occs, occ);
        }
      }
    }
  };
  for (const key of own.keys()) if (!index.has(key)) visit(key);

  return (value) => {
    const flat = collapse(value);
    const out = emptyValue();
    for (const occ of flat.occs.values()) addOcc(out, occ);
    for (const ph of flat.phs.values()) {
      for (const key of targets(ph)) {
        for (const occ of (resolved.get(key) as AbstractValue).occs.values()) addOcc(out, occ);
      }
    }
    return [...out.occs.values()];
  };
}
