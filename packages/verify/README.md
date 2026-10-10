# @loom/verify

Pre-flight **runtime verification** for Loom — a pure, read-only, **off-log** check that runs
*before* an execution starts and catches invariant violations that would otherwise surface as a
diverged replay, a mid-run `CapabilityDeniedError`, or a timer that never fires.

Design: [ADR 0028](../../docs/adr/0028-runtime-verification.md). Rationale & scope:
[Execution-OS evaluation](../../docs/requirements/2026-07-10-execution-operating-system-evaluation.md).

`verify` **advises**; it is not a new enforcement ring. Runtime enforcement stays where it already
lives (K2 authority, K9 delivery, K11 versioning). This package shifts those failures *left*.

## Rules

| Rule | Catches |
|---|---|
| `determinism` | non-deterministic calls (`Date.now`, `Math.random`, bare `fetch`) reachable outside `ctx.decide`/`ctx.execute` → replay diverges (P2) |
| `replay-safety` | missing flow content hash (K11); event-schema major mismatch vs. a prior log (K5); a `journaled` effect called through a `ctx.decide` scope (the transient seam refuses it, L31); `info` when such a scope-reached effect is not registered |
| `suspension-safety` | a timed suspend with no `wakeAt` **when a `TimerStore` is wired** (T1); approval flows with no `ResumeAuthenticator` (K12). The blanket `correlationKey` error was removed in [ADR 0086](../../docs/adr/0086-runner-body-reach-analysis.md) — `resume()` routes by `executionId` |
| `capability-compat` | an effect requiring a capability not in the `GrantTable` (K2) |
| `placement-compat` | a `computeTarget` that resolves to no registered dispatcher target; an effect kind a target doesn't support |
| `resource-compat` | a declared budget dimension that nothing meters (K3); a budget with no ceiling |
| `classification-reachability` | a `secret()`/`sensitive()`/`internal()` mark under a record/union/tuple/intersection, which no egress sink can address — masked nowhere, encrypted nowhere, externalized nowhere (K10-R1, [ADR 0076](../../docs/adr/0076-wildcard-classification-paths.md)) |
| `effect-class` | a flow reaching an effect whose declared class exceeds the flow's own ceiling ([ADR 0084](../../docs/adr/0084-effect-classes-static-ceiling-k2-floor.md)); no-op until the app declares its class vocabulary |

(`migration-safety` from the requirements folds into `replay-safety` — in the stateless-worker
model, resume *is* migration.)

`capability-compat`, `effect-class` and `suspension-safety` all ask *"does everything this flow
reaches satisfy X"*, so each is bounded by what is known to be reachable. Each emits an additional
`warn` naming the runner-body targets the analysis could **not** resolve
([ADR 0086](../../docs/adr/0086-runner-body-reach-analysis.md)) — silence about a hole in the
reachable set is what turns a green report into an overclaim.

## Usage

### Wired (the two real surfaces)

```ts
// 1. defineConfig — runs at boot, before any execution starts.
const app = defineConfig({
  storage: { kind: "memory" },
  flows,
  security: { authorizer: new GrantTable({ "my-flow": ["metrics-tool"] }) },
  checks: {
    verify: "error", // "off" (default) | "warn" | "error"
    //  or the object form to declare metered dimensions / the effect-class vocabulary
    //  / restrict the rule set:
    //  verify: { mode: "warn", meteredDimensions: ["tokens", "costUsd", "ms"] },
  },
});

// 2. On demand — app.verify() re-runs the same checks (this is what `loom verify` calls).
const report = app.verify();
if (!report.ok) process.exitCode = 1;
```

```sh
loom verify --config ./dist/loom.config.js   # exits non-zero on any error finding
```

`defineConfig` maps the resolved app → `VerifyInput` via the `@loom/app` adapter
(`resolveVerifyInput`): flows + `flowContentHash` + each step's effect capability, the
`GrantTable` projection, and `PlacementDispatcher` targets. `"off"` never even builds the
input (G2).

### Direct (engine)

```ts
import { verify, runVerification } from "@loom/verify";

const report = verify(input); // input: a structural VerifyInput
if (!report.ok) console.error(report.findings);

runVerification(mode, () => buildInput()); // "off" skips buildInput entirely
```

`VerifyInput` is a **structural projection** of a resolved config. The engine is
dependency-free on purpose so the rules stay pure and testable; the config→`VerifyInput`
adapter lives in `@loom/app`.

**What feeds each rule.** Build with the `@loom/compiler` and the manifest carries three per-flow
source analyses — `loopIdentity` (ADR 0061), `nonDeterministic`, and `runnerReach` (ADR 0086) —
which `loom verify` auto-injects from a discovered `loom-manifest.json`, and which `defineConfig`
accepts directly. That puts `determinism`, `capability-compat`, `effect-class` and
`suspension-safety` on without the developer hand-feeding their own runner source to a linter.

**Remaining feed gaps (documented, not silent):** per-flow `computeTarget` and resource budgets
are not in the `FlowDefinition` today, so `placement-compat` and `resource-compat` only see what a
caller supplies structurally. A `ctx.run` target imported from another module resolves only as
*unresolved* — reported as a `warn`, never dropped. So is a `ctx` (or `ctx.decide`) handed to a library
that declares no reach: reported unresolved unless `verify.reach` maps it to a declaration
(ADR 0086, L31/L32).

### Code a flow hands its `ctx` to (declared reach, L32)

A library that runs steps or deciders with a flow's `ctx` (a planner, a retriever, an agent
loop) declares what it reaches; the app maps the callee used in the flow source to the real
object:

```ts
// library (no loom import needed): Symbol.for("loom.verify.reach") -> { run?, transient? }
declareReach(planner, { transient: ["llm.complete"] }); // from @loom/verify

// app
defineConfig({ checks: { verify: { mode: "warn", reach: { planner } } } });
```

A library that runs a step ITS CALLER passes (`fanout$(ctx, step, items)`) cannot list a fixed tool; it
declares which argument positions hold steps, and the verifier counts the step it reads at each call
site (a position it cannot resolve is reported, not dropped):

```ts
declareReach(fanout$, { run: [], transient: [], stepArgs: [1] });
```

`ctx.parallel([[step, input], ...])` is read like `ctx.run`. Effect ids given by a same-module (or
relative-imported) `const`, or minted by a factory (`llmStep$(id, LLM_X)`, `mcpInvoke$` = `mcp.invoke`,
`sandboxEval$`), resolve; anything else stays unresolved. In `@loom/orchestration`, `@loom/learning`,
`@loom/analytics` and `@loom/knowledge` the hand-offs declare their reach (none run a tool). `agentLoop$` does
not: its reach depends on the config, so declare it in `verify.reach` for your own tool set.

The compiler records `planner.compose(input, ctx)` as an escape; declared tools join the flow's
effects (capability-compat, effect-class, and replay-safety for `transient`), with
`viaDeclared` provenance. An escape with no declaration is an unresolved `warn` naming the key to
add. A declaration is a claim about the library; the tools it names are checked, not the library.

- `{ run: [], transient: [] }` is a valid declaration of **"reaches nothing"** (a pure helper, an
  emit-only fold). An empty `{}` carries nothing and is undeclared.
- A declared tool that is not registered is a `warn` (a typo should not be quiet).
- Declared tools have no effect class: `effect-class` reports them under "N reachable effects
  carry no class" (partially verified), by design.
- Keys are module-blind: one `planner` key covers every module's `planner`.
- `ctx` is recognised as the runner's first parameter whatever it is called, and followed into
  same-module helpers; `ctx.run`/`ctx.suspend` handed out as values are escapes too. Anything not
  followable is reported unresolved, never skipped.
- **Test the claim.** Library authors should run the library against `recordReach()` and
  `assertReachMatches(declaration, recorder.recorded)` (both from `@loom/verify`): the recorder
  wraps a ctx, records the toolIds passed to `run`/`execute`/`parallel` and to
  `scope.invokeTransient` inside `decide`, and the assertion throws if anything ran that the
  declaration does not name.

## Guarantees

- **G1 — determinism untouched.** No event type; nothing on the durable path. `verify` reads
  static config only.
- **G2 — zero overhead when unwired.** `mode: "off"` returns immediately and never calls
  `buildInput`. Proven in `verify.bench.ts` (`off` vs. build-and-verify).
