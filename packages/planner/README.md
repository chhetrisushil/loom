# @loom/planner — goals to capability plans

Turns a goal into a plan over a [`CapabilityCatalog`](../capability/README.md), in two generations. The
original `PlannerRuntime.plan` returns a flat ordered list of capability ids and is not journaled. The newer
plan-graph API (ADR 0123) produces a validated DAG with arguments and `$from` bindings, records the model
call through `ctx.decide` so a replay makes no model call, executes the DAG in waves, replans on failure,
and keeps durable per-principal goals. Use the flat planner for a quick ordered suggestion and the
plan-graph API when a plan has to be validated, executed durably and resumed. Both work offline with a
keyword heuristic, or with a `reasoning` runtime (preferred) or a `provider`.

```ts
import { z } from "zod";
import { CapabilityCatalog, capability$ } from "@loom/capability";
import { PlannerRuntime, validatePlanGraph, type PlanGraph } from "@loom/planner";
import { helloFlow } from "./config"; // a registered flow, reused here for both capabilities

const input = z.object({ name: z.string() });
const catalog = new CapabilityCatalog()
  .register(capability$({ id: "look-up", intent: "Look up a user", inputSchema: input, flow: helloFlow }))
  .register(capability$({ id: "greet", intent: "Greet a user", inputSchema: input, flow: helloFlow }));

// Flat plan. With no model configured this is a keyword-ranked heuristic; `strict: true` throws
// PlanFailedError instead of silently falling back when a configured model gives no usable plan.
const planner = new PlannerRuntime({ catalog, maxSteps: 3 });
console.log(await planner.plan("look up a user and greet them"));

// A plan graph is data, so it is validated before anything runs: cycles, unknown capabilities,
// dangling references, schema-invalid arguments and size bounds.
const graph: PlanGraph = {
  goal: "look up then greet",
  nodes: [
    { id: "a", capabilityId: "look-up", args: { name: "Ada" } },
    { id: "b", capabilityId: "greet", args: { name: { $from: "a.message" } }, dependsOn: ["a"] },
  ],
};
const check = validatePlanGraph(graph, { catalog });
console.log(check.ok ? check.order : check.issues); // ["a", "b"]
```

## Surface

- **Flat planner.** `PlannerRuntime({ catalog, reasoning?, provider?, maxSteps?, scheduler?, strict?,
  prompts? })` with `plan(goal)` and `planGraph(ctx, input)`.
- **Plan graph.** Types `PlanGraph`, `PlanNode` (`id`, `capabilityId`, `args`, `dependsOn`,
  `preconditions`, `rationale`). `validatePlanGraph` / `assertValidPlanGraph`, `DEFAULT_PLAN_LIMITS`
  (32 nodes by default), `resolveRef`, `resolveArgs`, `checkPrecondition`.
- **Journaled planning.** `planGoal(ctx, { goal, catalog, model, ... })` with `effectPlanModel`,
  `providerPlanModel` and `heuristicFallback`; failure is `PlanFailedError`.
- **Execution.** `executePlan(ctx, plan, { catalog, limit?, onFailure?, replan?, reflect?, invoke? })` runs
  ready nodes in waves through `ctx.parallel`, and `makeReviser` builds a replanner. Each node runs as a
  durable frame (default: a tool task whose id is the capability id).
- **Goals.** `Goal`, `GoalStore`, `InMemoryGoalStore`, `DurableGoalStore`, `registerGoalEffects` /
  `goalsClient`, and `runGoal`. A goal's owner comes from the caller's principal and is not an input.

## Behaviour that surprises people

- **The flat `plan` is not journaled** and carries no arguments or edges. It falls back to the keyword
  heuristic when a configured model returns nothing usable, unless `strict: true`. `planGoal` falls
  back only if you pass a `fallback`, and the decision records `source: "fallback"`.
- **`planGoal` retries bounded.** `maxAttempts` defaults to 3 and must be 1 to 8; an invalid answer is
  fed back to the model.
- **Defaults of `executePlan`:** 4 nodes in flight and `onFailure: "fail-fast"` (nothing further starts
  after a failing wave with no replan left). A failed step is recorded as a decision, so a resume serves
  it instead of re-running the capability. A replan replaces every node that has not completed, may read
  completed outputs, and may not reuse an earlier id.
- **Tainted values are refused by default.** A plan step that binds a tainted value (ADR 0085) into a
  capability fails with `args-invalid` unless that capability opted in with `acceptsTainted`.
- **Reusing an id throws.** A `planId` or `goalsClient` prefix used twice in one execution raises
  `IdReusedError`.
- **A node whose arguments contain a `$from` reference is schema-checked after resolution**, at
  execution, not by `validatePlanGraph`.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loom/capability` / `@loom/intent` / `@loom/planner`" in [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [user guide, section 8: intent, planner and memory](../../docs/user-guide.md#8-intent-planner--memory).
- ADRs: [0123 planning depth: plan graphs, replanning and goals](../../docs/adr/0123-planning-depth-plan-graphs-replanning-and-goals.md), [0085 untrusted content](../../docs/adr/0085-untrusted-content-integrity-axis.md).
- Source: `packages/planner/src`.
