# ADR 0123 — Planning depth: plan graphs with bindings, journaled planning, a dependency-aware executor, bounded replanning and a goal store

- Status: **Accepted** (on merge)
- Date: 2026-10-09
- Closes: R16 (agentic-readiness audit §Planning, recommendation 9)
- Builds on: [ADR 0119](0119-decide-scope-streaming-deltas.md) (`ctx.decide` + `DecideScope`: the model call is a recorded decision),
  [ADR 0112](0112-structured-concurrency.md) (`ctx.parallel` scopes), [ADR 0113](0113-body-aware-code-fingerprint-and-dynamic-id-migration.md)
  (replay divergence; stable step ids), [ADR 0121](0121-one-canonical-agent-loop.md) (the outcome-as-decision pattern for a
  failing tool; `isTerminalToolError`), R4 (`validateToolInput` / `toolInputJsonSchema`), [ADR 0111](0111-durable-principal.md)
  (the owner of a goal is the authenticated principal), [ADR 0109](0109-bounded-history-and-continue-as-new.md) (a long-horizon goal
  outlives an execution chain), [ADR 0085](0085-untrusted-content-integrity-axis.md) (model- and tool-authored text is untrusted data),
  [ADR 0083](0083-second-consumer-rule.md) (relaxed for Part R; consumers named below).
- Consumers: the **loom-ui planner** (`@loom-ui/planner`: a composed surface is a plan whose steps depend on each other's data), the
  **`agent-swarm`** example (a swarm wired from intent is a DAG; today it hand-rolls fan-out) and **`agent-network`** (the
  LLM → agent → planner chain, today a flat list). The example specified for this ADR is `plan-and-replan` in `loom-examples`
  (see the PR; this repo does not edit that one).
- Placement: **1P, kernel untouched.** All code is in `@loom/planner`. `KERNEL_ABI`, `EVENT_SCHEMA` and every SPI are
  unchanged; no syscall, no event kind, no payload field. It is built from `ctx.decide`, `ctx.parallel`, `ctx.execute` and the
  effect ring as they exist.

## Context

Re-measured on `main` at `ba7fb905` against the audit's §Planning:

| Audit finding | State on `main` | Here |
|---|---|---|
| `plan(goal)` returns `{capabilityId, rationale}`: no arguments, no bindings between steps | **Open.** `PlanStep` is still those two fields. | `PlanNode.args` + `{ "$from": "<step>.<path>" }` bindings (D1). |
| No dependencies / preconditions | **Open.** | `dependsOn[]` and `preconditions[]` (D1). |
| The plan is not journaled | **Open.** `PlannerRuntime.plan` is an `async` method with no `ctx`; replaying a flow that called it asks the model again. | `planGoal(ctx, …)` records the plan with `ctx.decide` (D2). |
| Silent fallback to a keyword heuristic on unparseable LLM output | **Open.** `plan()` returns the heuristic's plan when the model's answer has no usable steps. | `planGoal` has no silent fallback; a typed `PlanFailedError`, an opt-in `fallback` that is validated and recorded (D2). `PlannerRuntime({strict:true})` closes it on the old path too. |
| `dispatchPlan` is sequential; `executeGraph` is flat | **Open.** `dispatchPlan` runs steps in a `for` loop; `executeGraph` fans out independent executions with no edges. | `executePlan`: waves over a DAG with bounded concurrency (D3). `dispatchPlan` is unchanged. |
| No replanning / reflection loop | **Open.** | Bounded replans and an optional `reflect` hook (D4). |
| A goal is a string; no goal store | **Open.** | `GoalStore`, principal-scoped, durable (D5). |
| (adjacent, already fixed) tool JSON schemas and input validation | **Fixed by R4.** | Reused: the model is shown each capability's JSON schema; arguments are checked with `validateToolInput`. |
| (adjacent, already fixed) a failing tool is feedback; a decision per outcome | **Fixed by R10.** | Reused: a step's failure is recorded as a decision (`<step>:outcome`), exactly as `agentLoop$` does. |
| (adjacent, already fixed) parallel scopes with a deterministic identity | **Fixed by R6/R7.** | Reused: every wave is one `ctx.parallel`. |

## Decision

### D1 — A plan is a DAG with arguments, bindings and preconditions

```ts
interface PlanNode {
  id: string;                         // ^[A-Za-z][A-Za-z0-9_-]{0,63}$, unique across every round of a plan
  capabilityId: string;
  args?: { [k: string]: Json };       // may contain { "$from": "<stepId>[.path.0.more]" }
  dependsOn?: string[];
  preconditions?: { ref: string; test?: "exists" | "truthy" | "equals"; value?: scalar }[];
  rationale?: string;                 // model-authored; bounded; audit only
}
interface PlanGraph { goal: string; nodes: PlanNode[] }
```

`validatePlanGraph` is a pure function (no clock, no I/O) that runs before anything executes and refuses: a malformed or
oversized plan (32 nodes, 16 dependencies, 32 KiB and depth 16 of `args`, 32 references and 8 preconditions per node), a duplicate
or reserved id, an unknown capability, a dependency on an unknown step, a self-dependency, a **cycle** (Kahn's algorithm, O(V+E)),
a `$from` that is not exactly `{ "$from": "<legal ref>" }`, a reference to a step that does not exist (`dangling-ref`) or is not in
that node's `dependsOn` (`undeclared-ref`), a path segment of `__proto__` / `constructor` / `prototype`, and **arguments that do not
satisfy the capability's input schema** (R4's `validateToolInput`, with its depth and size bounds). A node whose arguments contain
references cannot be checked until they resolve, so it is checked again at execution, after substitution and before the capability
runs (D3); a miss there is a typed step failure, which a replan can answer.

References are resolved by the executor from its own record of step outputs (`resolveRef`, own properties only, iterative
substitution). The model never supplies a value for a bound position. A tainted output stays tainted (a path read out of it is
re-wrapped with the original origin), and a resolved value is **data in an argument**, never interpolated into a prompt.

### D2 — Planning is a recorded decision, and failure is typed

`planGoal(ctx, { goal, catalog, model, planId?, maxAttempts?, limits?, fallback? })` runs the model **inside** `ctx.decide`
(`<planId>:plan`). The decider asks, parses (the reply is capped at 128 KiB; only the six known node keys are copied), validates, and
on a rejection asks again with the rejection as feedback, up to `maxAttempts` (default 3, max 8). The decision records the validated
plan **or the failure**; a replay serves it and makes zero model calls, and a recorded failure re-throws `PlanFailedError`
deterministically. The feedback carries model-authored fragments (ids, capability names), so it is a **tainted** part of a `user`
message, never the system prompt. The system prompt carries the capability menu with each input's JSON schema (R4's
`toolInputJsonSchema`, bounded per capability) and the prompt boundary's fence note.

`PlanModel = (scope: DecideScope, request) => Promise<LlmResponse>`. `effectPlanModel(toolId)` calls `scope.invokeTransient`, so the
call is authorized, metered, kill-switched and `guardRequest`-checked by the ring; `providerPlanModel(provider)` is a bare provider
behind `guardRequest` for tests and the unprotected path. A tainted goal rides in a fenced `user` part.

There is **no silent fallback.** `fallback` is an explicit option, is used only after every attempt failed, is validated like a model
plan, and the decision records `source: "fallback"`. `heuristicFallback(catalog)` is the old keyword ranking as a chain of
argument-less steps; it is sound only for capabilities whose input is all-optional, and anything else fails validation and throws.

### D3 — `executePlan`: a dependency-aware executor over `ctx.parallel`

`executePlan(ctx, plan, { catalog, planId?, limit?, onFailure?, invoke?, replan?, reflect? })` runs the graph in **waves**: every
node whose dependencies all completed, fanned out through one `ctx.parallel(..., { limit, failFast: false })` scope, results in
declaration order. Scheduling is Kahn's algorithm with per-node in-degree counters and a dependents index, **O(V+E) over the run**.
A wave is a barrier. That is deliberate: it makes the schedule a pure function of the recorded outcomes, so a replay forms the same
waves and asks the same questions, which is what R7 divergence detection (`"fail"`) needs. A dynamic "start whatever became ready"
scheduler would overlap more, but its start order would depend on completion timing; the cost of the barrier is documented, not
hidden.

Per node: resolve `$from`, check preconditions, validate the resolved arguments, then `invoke`. A failure at any of the first
three is a typed `StepFailure` (`ref-unresolved`, `precondition`, `args-invalid`) and the capability **does not run**. The
default `invoke` is a `tool` task `<planId>:<nodeId>` with `toolId = capabilityId` through the effect ring (authz, metering,
idempotency). The invocation is wrapped in `ctx.decide("<step>:outcome")` exactly as `agentLoop$` does, so a resume serves a recorded
failure instead of re-running the capability; the step's output is read back from its completed frame, never duplicated into the
decision. `invoke` must therefore be a durable frame (a custom one: `call.ctx.execute(...)`). Errors that are the runtime's, not the
step's (`isTerminalToolError`: authority, safety, quota, park, cancel, divergence) propagate and are never recorded as a plan failure.

Failure semantics: `"fail-fast"` (default) starts nothing further after a wave that failed (and had no replan left);
`"continue-independent"` keeps running every node that does not depend, transitively, on a failure, and reports the blocked cone as
`skipped`. In both, siblings in the failing wave finish (one scope). `PlanRun` carries `status` (`completed` | `failed` |
`stopped`), `outputs`, `failures`, `skipped`, `replans`, every node ever introduced, and the `reason`. Status is judged on the
**final** plan: a failure that a later round replaced is history (it stays in `failures` as evidence).

### D4 — Replanning keeps what finished

When a wave fails, or `reflect` returns `"replan"`, and `replan.max` (≤ 16) is not exhausted, the executor asks
`replan.revise(ctx, request)` for a plan that **replaces every node that has not completed**. The request carries the goal, the
completed outputs, the failures, the nodes that did not run, and every id used so far. A revision:

- may reference a completed step (`$from`, `dependsOn`) and **never re-runs it**: completed ids are `external` to the revised
  graph and cannot be redeclared;
- may **not reuse any id** of an earlier round (completed, failed or never run); the old unrun nodes are superseded, not skipped,
  so a replan cannot collide with a recorded frame (`reserved-id`);
- is validated like any plan, within a total node budget (`maxTotalNodes`, default 4 × `maxNodes`);
- that is empty means "give up": the run ends `failed` with the reason.

`makeReviser({ model })` is the model-backed reviser: one recorded decision per round, named from the request's plan (`<req.planId>:replan:<n>`; the catalog and the resolved limits also come from the request, so a revision is validated against exactly what the executor enforces), with the same
bounded ask-validate-retry loop. Everything the failure context contains is **tool- or model-authored** (a step's output, an error
message, the old plan's rationale), so each item is a tainted part of the `user` message, fenced by the prompt boundary and labelled
with its origin (`plan:failure:<id>`, `plan:output:<id>`, …); nothing of it enters the system prompt. `reflect(ctx, wave)` is an
optional hook after each wave (`"continue" | "replan" | "stop"`); any model call inside it must go through `ctx.decide`.

### D5 — A goal store, principal-scoped and durable

`Goal { id, owner, parentId?, title, status: open|active|done|failed|abandoned, revision, seq, note?, lastRun? }` in a `GoalStore`
(`create / get / list / setStatus / rollup`). **Owner scoping is structural:** every operation takes an `owner`, an owner's goals live
in their own namespace, and another owner's id is indistinguishable from a missing one (`GoalNotFoundError`; no existence oracle). The
owner is never an input: `goalEffects(store)` derives it from the **effect context's principal** (`ownerOfPrincipal`: tenant-qualified
actor; fails closed with no actor or an unresolved delegation), which ADR 0111 made durable. A flow reaches the store through
`goalsClient(ctx)` — recorded `tool` steps (`goals:<op>:<n>`) — so a replay folds the recorded value and a store read is never
repeated. There is no clock: ordering is a per-owner creation ordinal. Limits: 1000 goals per owner, depth 8, title 500 characters.

Transitions are a small machine (`done` and `abandoned` are terminal; `failed` may be retried); `setStatus` takes an optional
`expectedRevision` (compare-and-set). `rollup` recomputes a parent from its children (all done ⇒ done; any active ⇒ active; every
live child terminal with a failure ⇒ failed; abandoned children ignored) and walks up the ancestors. It is explicit, not automatic.

**Why a keyed CAS store and not an execution's state or continue-as-new.** A goal spans runs; ADR 0109's carry is per chain and is
the wrong owner for something several executions (a planner run, a retry next week, a human's edit) share. `DurableGoalStore` keeps one
document per owner under `loom.goals/<encoded owner>` over `GoalKvStore`, a structural subset of `DurableStateStore`
(`@loom/plugin-durable-state`: SQLite and Postgres backends exist), so this package takes no dependency on the plugin tier. Every
mutation is load → pure change → `save(expectedRevision)`, retried on a lost race (8 attempts). A stored document that names another
owner is refused. `InMemoryGoalStore` is the reference. A long-horizon flow combines the two: `ctx.continueAsNew` carries the goal
**id**, the store holds the goal.

`runGoal(ctx, goals, goalId, { catalog, plan, execute })` is the planner integration: mark active, `planGoal` for the title,
`executePlan`, write the outcome (`done` / `failed`, `open` again when a reflection stopped the run) with `lastRun`, roll the parent
up. A planning failure marks the goal failed with the reason and re-throws. Plan and step ids are `goal-<id>-r<revision>`, so a
retried goal never collides with its earlier recorded attempt.

### D6 — Compatibility

`PlannerRuntime.plan`, `Plan`, `PlanStep` and `dispatchPlan` are unchanged and keep working; they are documented as the flat,
un-journaled path. The only addition to the old class is `strict?: boolean` (default `false`): with it `plan()` throws
`PlanFailedError` instead of falling back, and `planGraph(ctx, …)` is a convenience over `planGoal` using the runtime's catalog.
**No in-flight execution diverges:** the old path records no step and no decision, and the new functions are not called by any
existing code, so no existing body's step ids or decisions change. (`PlannerRuntime.test.ts` pins the unchanged defaults.)
A flow that moves from `plan()` to `planGoal()` is a body change like any other and goes through ADR 0113's fingerprint.

### D7 — What this does not do

- **`executeGraph` (`@loom/graph-executor`) gains no edges.** It fans a set of independent *executions* across compute placement,
  one writer each, and joins; a DAG of executions is `@loom/orchestration`'s job (`awaitChildren`). `executePlan` is the in-execution
  DAG: its steps are durable frames of one execution. A step whose `invoke` spawns a child execution composes the two.
- **No dynamic start-as-ready scheduling** (D3), and no mid-wave cancellation of siblings on failure.
- **No automatic goal decomposition.** A model may be asked to propose subgoals, but creating them is an explicit `goals.create`.
- **Arguments that contain references are validated at execution, not at plan time** (D1). A schema cannot be checked against a
  value that does not exist yet; the alternative (a placeholder per type) would pass or refuse for the wrong reasons.

### D8 — Fix round 1 (Opus review of PR #520)

- **Owner = the shared identity key.** `principalIdentityKey` / `identityKeyOf` (`@loom/effect-runtime`, next to `principalBlocked`) is
  `[tenant, actor, onBehalfOf]`; goals and `@loom/conversation` both use it, so a delegate acting `onBehalfOf` u1 is not u2's
  owner. A shredded or unresolved principal has no owner.
- **An id namespace is claimed once per execution context** (`planGoal` / `executePlan` `planId`, `goalsClient` prefix): a second
  claim throws `IdReusedError` instead of being served the first call's recorded result.
- **Taint through paths.** A `$from` path addresses the payload; a tainted value met anywhere on the path is stepped into and the
  result keeps the outermost taint. `__loomTainted` is not a legal path segment or args key. A tainted argument is refused by default;
  `capability$({ acceptsTainted: true })` checks the schema on the payload and hands the tool the wrapper. Prompts show the fenced
  payload, never the wrapper JSON; a tainted goal stays tainted in `PlanGraph.goal`.
- **Crash window.** A step's capability runs once on success (its output is captured inside the outcome decision). If the process
  dies after the capability ran but before the outcome decision is journaled, the step re-runs once on resume: at-least-once, the
  same window as `agentLoop$`; mark a non-idempotent capability `idempotent: false` so recovery parks it instead.
- **Goals.** `runGoal` takes the `active` transition by compare-and-set and refuses an already-active goal; any error that ends the
  pursuit (other than a park) returns it to `open` with `lastRun.error`; the parent is rolled up, the goal's own result is not
  recomputed. Goal writes are idempotent on the effect's `idempotencyKey`. Plan retries send the model's previous answer back as an
  assistant turn.

## Consequences

- A plan is data: validated, bounded, replayable, inspectable, and the model's authority over it ends at "which capabilities, in
  which order, with which literal arguments and which bindings".
- A replan costs one recorded decision; a replay re-does nothing (tested: zero model calls, zero capability runs, byte-identical
  result, under `divergence: "fail"`).
- The wave barrier trades some overlap for determinism.
- A capability that accepts a tainted value must declare it in its schema (the wrapper is validated as-is; it is not unwrapped to
  satisfy a schema, which would launder it).

## Questions for the user

1. **`executeGraph` edges.** Left flat (D7). If a dependency-ordered fan-out of *executions* is wanted, it is a separate change in
   `@loom/orchestration`, not in the dispatcher-level graph.
2. **Wave barrier vs. dynamic scheduling.** Chosen for replay determinism; reconsider only if the overlap loss shows up in a real
   workload.
3. **`rollup` is explicit.** Auto-rolling-up on every `setStatus` would be surprising when a parent is also pursued directly.
