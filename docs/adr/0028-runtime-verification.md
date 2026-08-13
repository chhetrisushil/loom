# ADR 0028 — Runtime Verification (`@loom/verify`)

- Status: Accepted (2026-07-10) — accepted item #1 in the [Execution-OS evaluation](../requirements/2026-07-10-execution-operating-system-evaluation.md). Implemented: `@loom/verify` engine + `defineConfig({ verify })` boot gate + `app.verify()` + `loom verify --config` CLI.
- Date: 2026-07-10
- Builds on: [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (kernel ABI, P9/P10), [ADR 0021](0021-k9-effect-delivery-contract-idempotency-fencing.md) (K9), [ADR 0023](0023-k11-flow-code-versioning-in-flight-executions.md) (K11 flow hash), the compiler's flow-graph analysis (`@loom/compiler`)

## Context

Loom 2.0 enforces its invariants (P2 pure replay, P9 log-only non-determinism, K2 authority,
K11 versioning) at *runtime*, and violations surface as a failed execution, a denied effect, or
— worst case — a replay that silently diverges. There is today **no pre-flight check**: nothing
inspects a configured app and says "this flow calls `Date.now()` outside `ctx.decide`, so its
replay will diverge," or "this flow targets compute lane `gpu` but no such dispatcher target is
registered," *before* the first `EXECUTION_STARTED`.

The requirements doc's "Runtime Verification" item (P3) asked for exactly this. Of all the
proposed items it is the clearest net-new win: it fits the kernel, raises safety, and its rules
are executable specifications of the invariants every *other* accepted item must not break.

## Decision

Add an opt-in package **`@loom/verify`** exposing a pure, read-only, **off-log** function
`verify(config): VerificationReport` that runs *before* execution and never emits a durable
event. Two non-negotiables carry over: **G1** (preserve P2/P9) and **G2** (byte-identical when
unwired — default is `off`).

**V1 — Rules.** Each check is a small, independent rule returning `{ rule, severity, findings[] }`:

- **determinism** — reuse `@loom/compiler` flow-graph analysis to flag non-deterministic calls
  (`Date.now`, `Math.random`, bare `fetch`/`crypto.randomUUID`, wall-clock reads) reachable in
  flow/step bodies **outside** a `ctx.decide`/`ctx.execute` boundary.
- **replay-safety** — a flow content hash (K11 `flowHash`) is present and the app's
  `EVENT_SCHEMA_VERSION` (K5) is compatible with any prior log it may resume.
- **suspension-safety** — every `suspend()` declares a `correlationKey` (and `wakeAt` for timed
  suspends); if any flow uses approval/resume, a `ResumeAuthenticator` (K12) is wired.
- **capability-compat** — every declared tool/effect resolves to a matching `GrantTable` grant
  (K2); an effect requiring an ungranted capability is a hard finding.
- **placement-compat** — `ExecutionPolicy.computeTarget` resolves to a registered
  `PlacementDispatcher` target, and that target's worker supports the required effect kinds.
- **resource-compat** — every budget dimension a flow declares is actually metered by the wired
  `meteringMiddleware`; a ceiling is present where a budget is declared.
- **classification-reachability** — a `secret()`/`sensitive()`/`internal()` mark (K10-R1) that
  no egress sink can address. The dot-path sinks — telemetry scrubbing, field-level
  encryption, content externalization — walk objects and arrays, but do not descend into a
  record's values, a union's branches, a tuple's members or an intersection's sides. A mark
  under one of those collects no path and does nothing: not masked, not encrypted, not
  externalized. Silent, and the consequence is classified data leaving in the clear, so it is
  an `error`. The fix is to mark the container itself, or restructure it as an object or
  array. Added after the package audit surfaced the gap (issue #260); detection lives in
  `@loom/classify` beside the walker it audits. Arrays were originally unaddressable too and
  were the rule's first target; [ADR 0076](0076-wildcard-classification-paths.md) made them
  reachable, narrowing this rule to what remains.

(Note: **migration-safety** from the requirements list collapses into replay-safety — in the
stateless-worker model resume *is* migration, so there is nothing extra to check.)

**V2 — DX surface.** The bar is loom-starter's ~10-line wiring (both landed):

- `loom verify --config <module>` — loads a `defineConfig(...)` app, calls `app.verify()`, prints
  the report, exits non-zero on any `error`-severity finding (CI gate).
- `defineConfig({ verify: "off" | "warn" | "error" })` — default `"off"` (G2). `"warn"` logs the
  report via `onWarn` at boot; `"error"` throws `VerificationError` before the first execution
  starts. Object form (`{ mode, meteredDimensions, rules }`) declares metered dimensions / narrows
  rules. `app.verify()` re-runs on demand. The config→`VerifyInput` adapter is `resolveVerifyInput`
  in `@loom/app`; a `GrantTable.view()` projection exposes grants without reflection.

**V3 — Purity.** `verify()` reads only static config + compiler manifest. It runs no effect,
starts no execution, opens no store connection it must mutate, and emits no event. A rule that
cannot decide statically returns an `info` finding ("could not verify X"), never a false `error`.

## Consequences

- **Shifts failures left.** Determinism/placement/capability mistakes become a CI failure or a
  startup error instead of a diverged replay or a mid-run `CapabilityDeniedError`.
- **Determinism untouched (G1).** No event type added; `EVENT_SCHEMA_VERSION` unchanged. `verify`
  is not on the durable path.
- **Zero-overhead when unwired (G2).** `verify:"off"` and no `loom verify` call ⇒ byte-identical
  to today. Ships an unwired-vs-wired bench.
- **Rules are the spec.** The determinism and replay-safety rules double as the guardrails the
  other accepted Execution-OS items (0029–0033) are checked against.

## Verification

Landed and green:

- `@loom/verify`: one spec per rule (pass + fail fixture) + the mode gate; an unwired-vs-wired
  bench shows `mode=off` ~1820× faster (input never built). 24 tests.
- `@loom/app`: `resolveVerifyInput` projects flows/hash/effects/grants/targets; `verify:"error"`
  throws at boot on an ungranted step effect (capability-compat); `"warn"` reports via `onWarn`;
  `"off"`/unset is a no-op yet `app.verify()` still works on demand. 7 tests.
- `@loom/cli`: `loom verify --config` prints the report and exits non-zero on error findings;
  errors when the module is not a `LoomApp`. 3 tests.
- `GrantTable.view()` projects grants (incl. `"*"`) without reflection.

## Amendments (from the Execution-OS evaluation)

- Promoted from **P3 → P0** (highest ROI net-new item).
- **migration-safety** dropped as a distinct rule — folded into replay-safety (resume = migration).
- Scope is **static pre-flight only**; runtime enforcement stays where it already lives (K2/K9/K11).
  `verify` advises; it does not become a new enforcement ring.

## Amendments (delta follow-ups, issue #82)

The forward-requirements acceptance record (Requirement 1) noted three sub-checks. Resolved:

- **Dynamic verification** — the requirement's *"runtime performs dynamic verification where
  required"* is satisfied by the **existing enforcement rings**, not a new `verify` runtime hook:
  **K2** (capability authority) denies ungranted effects mid-run, **K9** (delivery contract /
  fencing / in-doubt) guards effect execution, **K11** (flow-hash pinning) refuses folding an
  in-flight execution under changed code. `verify` is deliberately the *static/pre-flight* half;
  these rings are the *dynamic* half. No new runtime verifier is added.
- **ABI compatibility** — kept as a **build-time conformance test** (`abi.test.ts` pins
  `KERNEL_SYSCALLS`; `eventSchema.test.ts` pins `knownEventTypes()`), **not** a per-execution
  `verify` rule. A stored log's schema compatibility is already covered by the replay-safety rule
  (K5 `EVENT_SCHEMA_VERSION`); a separate per-execution ABI-compat rule would add nothing.
- **Determinism rule feed** — `@loom/compiler` now provides `analyzeNonDeterminism(source, flowId)`
  (AST-based: flags `Date.now`/`Math.random`/`crypto.randomUUID`/`performance.now`/bare `fetch`/
  `new Date()`, with `insideDecide` when inside a `ctx.decide`/`ctx.execute` boundary). Its output
  feeds the determinism rule via `resolveVerifyInput({ nonDeterministicByFlow })`. **Important
  correctness note:** analyze the **flow runner / orchestration source**, not step `handler$`
  bodies — a handler's `STEP_COMPLETED` output is logged and served on replay, so non-determinism
  *inside* a handler is already safe; only orchestration code that re-executes on replay can
  diverge. Auto-extraction of runner bodies into the manifest is a further follow-up; the analyzer
  + feed path are in place.

## Amendments (effect classes, ADR 0084)

An **eighth rule**, `effect-class`, joined the set: a flow may not reach an effect whose declared
class exceeds the flow's own, composed conservatively as the max over everything reachable. The
class *vocabulary* is app-supplied (`checks: { verify: { effectClasses } }`) — loom checks the
ordering it is given rather than defining one (ADR 0083).

It sits deliberately beside `capability-compat` rather than inside it, because the two answer
different questions: `capability-compat` asks whether K2 grants the capability at all, while
`effect-class` asks whether the flow reached something worse than it promised. A **granted**
capability can still bust the class, and K2 will not stop it — the finding says so, which is the
reconciliation made operational. See [ADR 0084](0084-effect-classes-static-ceiling-k2-floor.md).

## Amendments (runner-body reach, ADR 0086)

**The V1 wording of `suspension-safety` above is superseded.** Its `suspends` input had no
producer until [ADR 0086](0086-runner-body-reach-analysis.md) added runner-body reach analysis,
and populating it showed two of its three checks were wrong:

- **The blanket `correlationKey` error is gone.** `WorkflowRuntime.resume` routes by
  `executionId`; nothing in the runtime matches on `correlationKey`, which is metadata for an
  external dispatcher holding a business key. The check would have errored on every idiomatic
  `ctx.suspend({ on: "Approved" })`, including this repo's own tests.
- **The `wakeAt` check is conditional on a wired `TimerStore`**, read from the real wiring
  (`runtime.hasTimerStore()`), because the runtime derives `wakeAt` from a suspend's `timeout`
  when one is present.

`capability-compat`, `effect-class` and `suspension-safety` also gained a `warn` naming the
runner-body targets the analysis could not resolve, and `FlowSpec.reachAnalyzed` separates
"analyzed and complete" from "never analyzed" — without which an app that never wired the
compiler would look maximally verified. The "auto-extraction of runner bodies into the manifest"
follow-up noted above is **done**: the compiler transform emits `loopIdentity`,
`nonDeterministic` and `runnerReach`, and `loom verify` auto-injects all three.

The rule set stands at **eight** — the seven listed under V1 above plus `effect-class`.
`RULE_ORDER` in `@loom/verify` is the executable list; this one is a description of it.
