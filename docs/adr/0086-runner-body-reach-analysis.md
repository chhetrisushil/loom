# ADR 0086 — Runner-body reach analysis, and two rules that were wrong once they could fire

- Status: **Accepted — implemented** (2026-08-14)
- Date: 2026-08-14
- Builds on: runtime verification ([ADR 0028](0028-runtime-verification.md)), effect classes
  ([ADR 0084](0084-effect-classes-static-ceiling-k2-floor.md)), the step-identity rule
  ([ADR 0061](0061-step-identity-interpreter-guardrails.md))
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged.** A build-time analysis, two
  `FlowSpec` fields, and one read-only accessor that is not a syscall.

## Context

Three `@loom/verify` rules — `capability-compat`, `effect-class`, `suspension-safety` — answer a
question of the form *"does everything this flow reaches satisfy X"*. All three defined "reaches"
as the toolIds of the flow's **declared** `FlowDefinition.steps`.

A step invoked through `ctx.run` without being listed there was invisible to all of them, and
`FlowSpec.suspends` had **no producer at all** — suspend points live in the runner body by
construction, so two of `suspension-safety`'s three checks could never fire for any app.

Both holes have the same shape and the same fix: the runner body is a source region, which is
exactly what `analyzeNonDeterminism` already operates on.

## Decisions

### D1 — Analyze the region, and report what you could not resolve

`analyzeRunnerReach(source)` returns `{ steps, unresolved, suspends }`.

`ctx.run(chargeCard, …)` names a binding. A binding declared in the same region as
`step$({ toolId: "…" })` resolves; one imported from another module does not. Matching is on
**shape** — a call whose first argument is an object literal with a string-literal `toolId` —
rather than on the name `step$`, so a project wrapper or a locally curried factory resolves too.

**`unresolved` is the load-bearing half.** An unresolvable target — an import, a minted step
(`mcpInvoke$("hydrate#0")`, whose toolId is runtime data by design), an element access — is
*reported*, not dropped. Dropping it is what would let a partial analysis read as a complete one.

`ctx.sleep`/`sleepUntil` are deliberately not recorded: the kernel authors their condition
(`on: TIMER_FIRED`, `wakeAt` always set), so treating them as user-authored suspend points would
manufacture findings about code the developer never wrote.

### D2 — The bound is a finding, not a footnote

Each of the three rules emits a `warn` naming the unresolved targets. `warn`, not `error`: an
unresolved target is a limit of the *analysis*, not a defect in the *app*, and an app with no
compiler wired must stay usable. `FlowSpec.reachAnalyzed` distinguishes "analyzed and complete"
from "never analyzed", which `unresolvedReach: []` alone cannot — without it, an app that never
wired the compiler would look maximally verified.

This is the `effect-class` unclassified-effects warn, generalized. Silence about a hole in the
reachable set is what turns a green report into an overclaim.

### D3 — Two rules were wrong, and populating them is how we found out

This is the part worth remembering. **A check whose input nothing populates is also a check
nobody can see is wrong.** Both of `suspension-safety`'s dead checks turned out to be defective,
and both would have fired on correct code the moment the input arrived.

**The blanket `correlationKey` error is removed.** It read *"suspend() declares no
correlationKey; a resume event cannot be routed to it"*. But `WorkflowRuntime.resume(executionId,
event)` routes by **executionId**, and nothing in the runtime matches on `correlationKey` at all —
it is metadata for an external dispatcher that knows a business key instead of an execution id.
Every idiomatic `ctx.suspend({ on: "Approved" })` — including the ones in this repo's own tests —
would have become an error. A verifier that errors on the majority of correct code is a verifier
that gets switched off.

**The `wakeAt` check is now conditional on the timer store.** When a `TimerStore` is wired,
`WorkflowRuntime` **derives** `wakeAt` from a suspend's `timeout` at suspend time
(`WorkflowRuntime.ts:1336`). So `suspend({ on, timeout })` is correct there and silently broken
only without one. The rule now reads `VerifyInput.timerStoreWired`, derived in the adapter from
`runtime.hasTimerStore()` — read from the real wiring, never accepted from a caller, the same
discipline as `resumeAuthenticatorWired`.

That leaves `suspension-safety` with two checks, both of which describe real defects.

### D4 — The adapter merges, and never double-counts

`resolveVerifyInput({ runnerReachByFlow })` unions body-resolved steps with declared ones by
toolId. A step both declared and reached yields one effect, not two.

## Consequences

- **The `warn` count goes up for apps that wire the compiler.** That is the intended direction:
  they were previously getting silence about the same gap.
- **`suspension-safety` is live for the first time.** Its `suspends` array had no producer since
  the rule was written.
- **The analysis is opt-in.** Nothing changes for an app that does not pass `runnerReachByFlow`,
  except that `suspension-safety` no longer errors on a missing `correlationKey` — a check that
  could not fire anyway.
- **What it still cannot see.** A `ctx.run` target imported from another module resolves only as
  *unresolved*. Closing that needs cross-module binding resolution, which is a type-checker job,
  not a single-region syntactic one. The warn says so rather than implying otherwise.

## Amendment (2026-10-04, L31) — decider scopes are reach

`ctx.decide(id, (scope) => scope.invokeTransient(toolId, …))` (L30) runs effects the
`ctx.run` walk never sees, so a flow whose effects all ran inside deciders reached nothing
and passed every reach-bounded rule vacuously. No new ADR: this extends D1's analysis and
D2's reporting convention without a new decision, and a new ADR trips four guards for no
added information.

- **Counted.** A literal-toolId `scope.invokeTransient` inside a decider is a reached step
  (`RunnerStepRef.viaDecider`), merged into `FlowSpec.effects` so capability-compat,
  effect-class and `reaches` consistency consume it unchanged.
- **Tracked by binding.** The scope parameter may only be the receiver of a called
  `.invokeTransient`; a destructured `invokeTransient` (renamed or not) may only be called.
  Any other use (passed on, aliased, `scope["invokeTransient"]`, rest pattern), a
  non-literal toolId, and a decider passed by reference whose body is outside the region
  are **unresolved** — reported through the existing `unresolvedReach` path and its `warn`,
  not a new rule id (D2). A same-region named function is followed only when its name is
  unambiguous: declared once in the region, `const`/`function`, never reassigned; otherwise
  it is unresolved (names are matched textually, so a flat map would silently bind the last
  declaration). Shadowing of the scope's own name is also textual, which over-reports.
- **Aliased `decide` is unresolved.** A non-call reference to a `.decide` member
  (`ctx.decide.bind(ctx)`, `const f = ctx.decide`), a destructured `decide` binding
  (`const { decide } = ctx`, a `({ decide }) =>` parameter), element-access `ctx["decide"]` calls and a
  spread-argument `decide(...args)` are reported unresolved, receiver-agnostic like the
  rest of the walk. Likewise a scope pattern element that could bind `invokeTransient`
  through a computed key or nested pattern. This deliberately includes handing `ctx.decide`
  to a library (`kb.retrieve(q, { decide: ctx.decide })`, the documented binding idiom): the
  library then decides with a decider in ITS code, whose reach is not followed, so the flow is
  reported unresolved (`decide alias ctx.decide`) rather than passing as if it reached nothing.
  The check is receiver-agnostic AND module-wide (the region is the flow module), so a
  `.decide` reference on any object in a flow module (`policy.decide` passed as a value)
  reports on every flow in it; that over-reports, which is the safe direction. Likewise the
  unambiguous-name rule over-refuses a decider whose short name (`d`, `fn`) is reused by an
  unrelated parameter or binding in the module. **Known gap, not fixed here:** `ctx.run` has the
  analogous pre-existing hole (`const r = ctx.run; r(step)` is not seen).
- **Journaled effects.** The transient seam refuses a `journaled` effect
  (`EffectModeViolationError`). `FlowSpec.deciderEffects` carries each scope-reached tool
  with its mode, read by the adapter from the real registry (`WorkflowRuntime.effectModeOf`,
  a read-only accessor, not a syscall), and `replay-safety` errors on a journaled one. An
  effect not registered at verify time has no mode and is not flagged.
- KERNEL_ABI and EVENT_SCHEMA unchanged.

## Amendment (2026-10-04, L32) - declared reach for code handed `ctx`

L31 counts deciders written in the flow module. A flow that hands its whole `ctx` to a
library (`planner.compose(input, ctx)`, a retriever, an agent loop) reaches whatever that
library's deciders/steps reach, and the flow module shows none of it: all three reach-bounded
rules passed vacuously, silently. No new ADR (extends D1/D2; a new ADR trips four guards).

- **The library declares; the verifier reads the real object.** A declaration is
  `{ run?: string[]; transient?: string[] }` under `Symbol.for("loom.verify.reach")` on the
  library object or function. It is structural, so a 3P library attaches it with no loom
  import (`declareReach` in `@loom/verify` is a convenience). `run` tools are reached through
  `ctx.run`/`ctx.execute`; `transient` through `scope.invokeTransient` in a decider.
- **The join is name-based and explicit.** Static analysis sees the identifier, not the value.
  The compiler records `RunnerReach.escapes: { callee, root?, via }`; the app maps the callee
  text (`"planner.compose"`) or its leftmost identifier (`"planner"`) to the real object in
  `checks.verify.reach`. A plain `{ run, transient }` literal is also accepted as the value (an
  app-level declaration for a library that has not adopted the symbol). Lookup uses own keys
  only.
- **Declared** tools join `FlowSpec.effects` with `viaDeclared: "<callee>"`, so
  capability-compat and effect-class consume them unchanged; `transient` ones also join
  `deciderEffects`, so `replay-safety` errors on a `journaled` one and gives an `info` for an
  unregistered one (mode read from the real registry, as in L31).
- **Undeclared** (no key, or a mapped value carrying no declaration) is `unresolvedReach`:
  `ctx handed to planner.compose (no declared reach; add verify.reach["planner"])`, the
  existing ADR 0086 D2 `warn`. `ctx.decide` handed out (`{ decide: ctx.decide }`) is the same
  mechanism and replaces L31's bare `decide alias` for that shape; other alias shapes
  (`const f = ctx.decide`, destructuring) remain unresolved.
- **What counts as an escape.** `ctx` as a call/`new` argument, directly or inside an
  object/array literal argument, to a callee that is not a same-module function. `ctx` stored,
  aliased or returned has no callee: unresolved (`ctx stored as ...`). `ctx.<method>(...)`,
  comparisons, `typeof` and `const { x } = ctx` are not escapes.
- **Which names are `ctx` (round 1: not just the text `ctx`).** The FIRST parameter of every
  runner is ctx whatever it is called: a `runner:` property or method, the second argument of
  `registerFlow(def, runner)`, a `…FlowRunner`-typed binding. Also `ctx`, a parameter typed
  `…ExecutionContext` (or a local alias of it), and the receiver of `.decide/.suspend/.sleepUntil`.
  Names propagate to a fixpoint into same-module helpers (ctx as argument i adds that function's
  i-th parameter, so `h(ctx)` with `const h = (x) => lib(x)` is followed) and through
  `const { ...rest } = ctx`. A ctx that reaches a same-module callee whose parameter is not a
  plain identifier (pattern, rest, missing), or that is wrapped in a literal passed to one, is
  unresolved rather than skipped. Names are textual and module-wide, so an unrelated function in a
  flow module with a `ctx` parameter (an HTTP context) can over-report; measured on this repo,
  loom-examples and genUI, that never happened, and dropping the bare `ctx` name would risk a
  silent miss for any runner the identification does not see, so it stays.
- **A runner that is not a followable function (round 2).** A `runner:` value (also a class
  `runner = …` field, `registerFlow` argument 2, a `FlowRunner`-typed initializer) is followed when
  it is an inline function, a local function/`const`, or a LOCAL factory whose every return is a
  function. A call (`withRetry(async (c) => …)`, `makeRunner(lib)`) treats the first parameter of
  every function-literal argument as ctx and is itself reported `runner not analysable`, because the
  wrapper may do anything else with ctx; an imported or member runner (`flow.runner`) is the same
  refusal; so is a `get runner()` accessor unless every return is a function. A `const` alias of
  a ctx name is a ctx name; a `let` alias stays `ctx stored`. Two accepted over-reports: an escape
  inside a factory-built runner names the factory's PARAMETER (`function mk(lib) { return async (c)
  => lib(c) }` reports `lib`, whatever was passed to `mk`), so a `verify.reach` key of that name
  would match; and a wrapper call treats EVERY function-literal argument as a runner
  (`compose(async (a) => a, …)` adds a `ctx stored` entry for the first). A callee
  that is itself rooted at ctx (`ctx.emit("x", ctx)`, `setTimeout(ctx.run, 0)`,
  `Reflect.apply(ctx.run, ctx, [step])`) is unresolved, never an escape (there is no outside code to
  declare). `(0, lib)(ctx)` names `lib`. Propagation is a worklist over indexes built in one walk
  (linear), not a re-walk per hop. `ctx.parallel`'s pair list: read since the 2026-10-10 amendment (L35).
- **ctx methods as values.** `ctx.run`, `ctx.execute`, `ctx.parallel`, `ctx.suspend`, `ctx.sleep`,
  `ctx.sleepUntil` handed out (`lib(ctx.run)`, `lib(ctx["run"])`, `const { run } = ctx; lib(run)`,
  `lib({ run: ctx.run.bind(ctx) })`) are escapes with `member` set, resolved through the same
  `verify.reach` key (warn text `ctx.run handed to lib`). `.call/.apply/.bind` on the callee is
  stripped, and `Reflect.apply(lib, …)` / `setTimeout(lib, …)` unwrap to `lib`; a pass-through
  whose target is not a plain name, `Promise.*`, a stored method, `ctx[k]` and `ctx.run.apply`
  are unresolved. A destructured or element-access `run`/`suspend` call is analysed like
  `ctx.run`. `ctx.parallel`'s pair list is read since 2026-10-10 (L35).
- **Empty and unregistered declarations.** `{ run: [], transient: [] }` is a valid declaration of
  "reaches nothing" (a pure helper, an emit-only fold); `{}` carries nothing and is undeclared.
  A declared tool (either kind) that is not registered is a `warn` (a declaration is explicit; a
  typo should not be quiet), joining the unresolved list; L31's scope-reached unregistered effect
  stays an `info` (different provenance: the flow's own source, not a claim). Declared tools carry
  no `effectClass`, so effect-class reports them under its existing "N reachable effects carry no
  class" warn, which is intended (partially verified, not clean).
- **Join keys are module-blind.** One `planner` key covers every module's `planner`; two modules
  with different `planner` objects cannot be told apart. Use the full callee text key
  (`"planner.compose"`) to separate methods, not modules.
- **What it cannot see.** A declaration is a claim: the named tools are checked against grants
  and the registry, not that the library calls only those. One declaration covers all methods
  of the mapped object/key; call-chain roots (`planner("x").compose`) map via the factory.
  Aliasing the library (`const p = planner`) maps under the alias name only. A library's own
  `ctx.suspend` is not expressible. Claim vs reality is tested library-side:
  `recordReach()` / `assertReachMatches()` in `@loom/verify` run the library against a recording
  ctx and fail when it ran a tool it did not declare (library authors, e.g. the loom-ui planner
  conformance suite, should call it).
- **ADR 0083 second consumers** (the declaration seam is not for one workload): the loom-ui
  planner, the genUI planner flows (`composeDashboard`, `reviseDashboard`), loom-examples
  `planner-decide-scope`, and in-repo `@loom/knowledge` `kb.retrieve` (`{ decide: ctx.decide }`).
- **Known follow-up, L34: 1P libraries declare their reach.** The real hand-offs in the corpus
  that ship from this repo declare nothing yet and so warn: `fanout$` and `awaitChild`
  (`@loom/orchestration`), `decideWithPolicy` and `recordOutcome` (`@loom/learning`),
  `runAgentLoop` (agent), `kb.retrieve` (`@loom/knowledge`). Open question: `fanout$`'s reach is
  its CALLER's step, so a fixed list is wrong; it may need a different shape (for example
  "reaches what its argument reaches"). Deliberately not in this change.
- KERNEL_ABI and EVENT_SCHEMA unchanged; no syscall.

## Amendment 2026-10-10: L34, L35, L37

Backlog L34 (1P libraries declare), L35 (`ctx.parallel`) and L37 (constant and factory-minted ids)
close the "Known follow-up" above. Nothing earlier is rewritten; this adds to it. KERNEL_ABI,
EVENT_SCHEMA and the syscall table are unchanged.

- **L35: `ctx.parallel` is read.** Its signature is `parallel(branches, options?)`, each branch
  `[StepDefinition, input]` or `(branch) => Promise`. An array-literal list (or an identifier bound once
  to one) is walked: each tuple's first element resolves exactly as a `ctx.run` target; a callback
  branch needs no work (its `b.run(...)` is found by the normal walk). A list that is not a literal
  (`items.map(...)`), a spread, a tuple with no resolvable first element, and a branch that is neither a
  tuple nor a function are each reported unresolved (`parallel(items.map(…))`, `parallel branch x`),
  never silently empty. The element-access, destructured and `.call` spellings are covered; `.apply` is
  unresolved like `ctx.run.apply`.
- **L37: constant and factory-minted effect ids.** What verify needs is the EFFECT id, not the step id.
  The analysis now resolves, by shape and never by guess:
  (a) a string constant: a literal, an all-constant template or `a + b`, or an identifier bound once to
  one by `const`, in the same module; also across a RELATIVE import (`./x`, `../x`, with `.js` mapped to
  `.ts` and `/index.ts` tried) when `transformFile` supplies its resolver, reading only top-level
  `export const NAME = "literal"` of the imported module. Not followed (stays unresolved): a bare or
  aliased specifier (`@x/y`, tsconfig `paths`), a re-export, a namespace import, a constant defined by a
  call or another imported constant, and `analyzeRunnerReach` on a bare string (no file, no resolver);
  (b) a step FACTORY call: a same-module or relative-imported function whose single returned expression is
  `anything({ toolId })` with `toolId` a constant or one of its plain parameters (with its default when
  absent), so ``llmStep$(`reshape@a${attempt}`, LLM_RESHAPE)`` resolves with a templated step id; and two
  first-party factories that live in packages (so cannot be followed through an import):
  `mcpInvoke$` is always the `mcp.invoke` effect (the tool name rides the run-time input) and
  `sandboxEval$(id, toolId = "sandbox.eval")`. A test pins both ids to their package constants.
  Resolution rules, all of which fall back to UNRESOLVED (a wrong effect id with no warn is the worst
  failure, so a doubt is never a guess):
  1. The table applies only to a BARE identifier call whose name is declared nowhere in the module
     (parameter, local, overload, class, enum, destructuring, catch, for-of: all count) and is an import
     of `mcpInvoke$` from `@loom/plugin-mcp` / `@loom/sdk`, or of `sandboxEval$` from
     `@loom/plugin-sandbox` / `@loom/sdk/sandbox`. An alias (`import { mcpInvoke$ as m }`) maps to the
     table entry. A property call (`x.mcpInvoke$()`), a relative or other-package import of that name, and
     any shadowed name are unresolved.
  2. The relative-import resolver is consulted for a constant or factory only when the name is declared
     nowhere in the module except as the import binding; a same-named parameter or local anywhere makes it
     unresolved.
  3. A factory (same-module or imported) folds a constant only if no identifier it mentions is declared
     anywhere inside the factory (parameters are read as parameters, body locals and nested scopes reject),
     so `export function mk(K) { return step$({ toolId: K }) }` is its argument, never the module `K`.
  4. A `const NAME = step$({ toolId })` binding is followed only when `NAME` is declared exactly once in the
     module and never reassigned; a shadowing parameter or a same-named binding in another function is
     unresolved (not last-wins).
  5. A `ctx.parallel` list bound to an identifier is read only if that identifier is used nowhere but its
     declaration and `ctx.parallel(...)` arguments; a `push`, a pass to a function or any other use makes
     the list unresolved.
  6. The two directions are both closed: a name that is imported (named, default or namespace) AND
     declared anywhere else in the module is never resolved through the local declaration either — the
     module-wide scan cannot tell which one a use refers to, so `import { mk } …; function w() { const mk
     = … }; ctx.run(mk("a"))` is unresolved, not the local `mk`.
  7. A step binding (`const s = step$({ toolId })` or `const s = { toolId }`) is followed only if `s` cannot
     change after its declaration: its only uses are the declaration, an argument of a ctx method call
     (`ctx.run(s)`, `ctx.parallel`) or of a ctx hand-off (`lib(ctx, s)`), an array element (a parallel
     tuple), a spread copy and a property read. A property assignment / `delete` / `++` through it, a
     call that receives it (`Object.assign(s, …)`, `mutate(s)`), a method call on it, an alias or any
     other use, anywhere in the module, leaves the target unresolved (`s.toolId = "t.y"` after
     `{ toolId: "t.x" }` used to resolve to `t.x`). Reuse (`ctx.run(s, a)` twice, inside a loop) stays
     resolved.
     An array element is an alias unless the OUTERMOST enclosing array literal (through nested ones,
     `ctx.parallel([[s, input]])`) is itself directly an argument of a ctx call: `const arr = [s]`,
     `[s].forEach(…)`, `const [e] = [s]`, `for (const e of [s])` and `mut(...[s])` are escapes. One
     non-ctx containment is a DECLARATION, not an alias: the `steps` array of loom's own `flow$` (an
     unshadowed import from `@loom/core` / `@loom/sdk`; only the `steps` key of its first argument),
     which keeps the list and is only read by the runtime. A later write through the flow definition
     (`F.steps[0].toolId = …`) is outside the analysis, the same trust class as the hand-off below. In an
     object literal a `toolId` / `id` key that appears twice (JS takes the last) or is followed by a
     spread (`{ toolId: "y", ...s }`) is not authoritative and is unresolved; a spread before the key
     (`{ ...s, toolId: "y" }`) is fine.
     **Accepted trust boundary:** a ctx hand-off (`lib(ctx, s)`) is NOT proof the step stays unchanged.
     The callee is outside the analysis; a callee that rewrites a step it was handed (`lib(ctx, s);
     await ctx.run(s)` resolving `s` to its declared id) breaks what its own L34 declaration claims.
     The library-side check is `assertReachMatches` with `passedSteps`, not this analysis.
  8. A step with NO `toolId` dispatches its own id (the runtime resolves `step.toolId ?? step.id`), so
     `step$({ id: SCAN_ID, … })` reaches the effect `SCAN_ID`, with `SCAN_ID` resolved by the constant /
     relative-import rules above. Only for `step$` itself (an unshadowed import from `@loom/core` or
     `@loom/sdk`, any alias) and an object with no `toolId` key, no spread and no computed key; a wrapper
     (`mk$`), a local `step$`, or an unresolved id stays unresolved.
  A factory with several returns, a spread argument, a non-constant effect argument or a
  duplicated/reassigned constant stays unresolved.
  Consequence worth knowing: a flow that used `mcpInvoke$` now reaches `mcp.invoke` for capability-compat,
  so an app whose grants omit it gets an ERROR where it used to get an unresolved warn. That is the
  check working.
- **L34: 1P libraries declare their reach** (`declareReach`, which adds `@loom/verify`, a leaf package
  with no dependencies, to `orchestration`, `learning`, `analytics` and `knowledge`):
  `awaitChild`, `awaitChildren`, `awaitAll` (and the three `boundOrchestration` wrappers),
  `decideWithPolicy`, `decideWithRollout`, `recordOutcome`, and `KnowledgeBase` (prototype and
  `retrieve`, so `verify.reach.kb` and `["kb.retrieve"]` both resolve) each declare
  `{ run: [], transient: [] }`: one `ctx.decide`/`emit` with a pure decider and no tool. This silences the
  unresolved warn without claiming coverage beyond it; `awaitChild`'s `ctx.suspend` on `CHILD_DONE` is still
  not expressible in a declaration (a library's own suspend is invisible to suspension-safety). Each is
  tested library-side with `recordReach()` / `assertReachMatches(…, { exact: true })`. The ADR's
  `runAgentLoop` is not a symbol in this repo (it was an app wrapper in genUI); the real one is
  `agentLoop$`, see below. `recordOutcome` lives in `@loom/analytics`, not `@loom/learning`.
- **`fanout$`: the shape is `stepArgs`.** `fanout$` runs ITS CALLER's step through `ctx.parallel`, so a
  fixed tool list is wrong for every caller. `ReachDeclaration` gains one optional field,
  `stepArgs?: readonly number[]`: zero-based argument positions holding step definitions the code runs
  with the ctx. `fanout$` declares `{ run: [], transient: [], stepArgs: [1] }`. The compiler records, on a
  whole-ctx hand-off, the arguments that RESOLVE to a step (`ReachEscape.args: { index, step }[]`, at most
  the first 8); the adapter reads them only for a callee whose declaration names the position, and counts
  the step as a reached effect (`viaDeclared: "fanout$"`). A named position that did not resolve is an
  unresolved warn (`fanout$ (argument 1) is not a step the analysis can resolve at the hand-off`), never
  "reaches nothing". Two hand-offs to one callee with different steps are both kept (the dedupe key
  includes the arguments). `assertReachMatches` takes `passedSteps` so a library test can say which tools
  it handed in, and they only count under a `stepArgs` declaration. It is additive and a plain `{ stepArgs }`
  literal works for an app-level declaration. Not built: a callee reached via a pass-through
  (`setTimeout(fanout$, …)`) has no arguments of its own to read, so it stays unresolved.
- **`agentLoop$` stays undeclared, deliberately.** Its reach is config-dependent and not a fixed set:
  `modelToolId`, `reasoningToolId` (a string or a per-route function), `compaction.toolId`,
  `writeBack.toolId`, an effect-backed skill selector's tool, every tool the model can name from
  `definition.tools` / `toolSearch.catalog` (`toolId: toolCall.name`). A static declaration on the
  function would be a claim that is wrong for every app but one, and a partial list would read as
  coverage. "Reaches what its config names" would need the compiler to evaluate an object-literal config
  across helpers and the tool menu, which is well past a small additive extension. So it remains an
  unresolved warn, and an app that wants it green declares its own: `checks.verify.reach: { "agentLoop$":
  { run: ["model", "search_kb", …] } }` (a plain literal is accepted), listing the effect ids it
  registered for the config it passes. If a second consumer needs the computed form, a helper that derives
  the declaration from a config (`agentLoopReach(config)`) is the next step, tested with `recordReach()`.
- **Evidence.** `runnerReach.test.ts` gains L35 (6), L37 (11 incl. the import follower and the two
  package pins) and L34 hand-off cases; every resolution was reverted once to see its test fail.
  `packages/app/src/verify.test.ts` drives `stepArgs`, `ctx.parallel` and `mcpInvoke$` through
  `defineConfig` end to end with a control. Measured read-only against genUI's flows: 14 unresolved
  sites and 10 escapes before; 1 unresolved (a `handler$` step with no `toolId`, `ScanStep`) after, and
  both `fanout$` hand-offs carry their step (they resolve once genUI maps `fanout$`).

## Amendment 2026-10-12: an empty reach is a fact when the runner is here

The compiler dropped a flow's `runnerReach` from the manifest when it was empty, so a pure
runner (`async (_ctx, input) => reduce(input)`) that the analysis READ and found reaching nothing
was indistinguishable from a runner it never read, and D2's coverage note named it "no runner-body
analysis" (genUI's `apply-authoring-operation` and `presubmit`). An empty reach is ambiguous on
its own: it is also what a module with no runner in it (a definition whose runner is registered
from another module) produces. The compiler now keeps the empty reach only when the module
declares at least one runner the analysis followed AND exactly one flow. That is sound because a
runner the analysis cannot follow is never silent (`runner not analysable: …` is `unresolved`, so
the reach is not empty), and because the reach is module-wide, a module with several flows keeps
the old, conservative answer. Manifest shape and the public `analyzeReachNode` are unchanged.

## Evidence

`tools/compiler/src/runnerReach.test.ts` (30) covers resolution, non-resolution, the generic
`ctx.suspend<T>` form, nesting inside loops/branches/closures, and the deliberate `sleep`
exclusion. `packages/verify/src/verify.test.ts` covers the corrected rules — including the two
tests asserting the *absence* of the removed correlationKey finding and the TimerStore-wired
case — plus the coverage warns.

`packages/app/src/verify.test.ts` drives it through `defineConfig` end to end, and leads with the
**control**: a flow whose ungranted step is invoked via `ctx.run` but not declared reports
`ok: true` without reach analysis, and errors with it. Without that case the rest could be passing
for reasons unrelated to the analysis.
