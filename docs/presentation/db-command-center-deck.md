---
marp: true
theme: default
paginate: true
title: "Loom — Agentic DB Command Center"
---

<!-- _paginate: false -->

# DB Command Center

### An agentic, intent-driven, human-in-the-loop operations console for a database fleet

**Dynamic planner workflow · long-running domain agents over A2A · durable suspend/resume · near-real-time surfaces · BYOR + BYOC + render-side fiber**

`examples/db-command-center` — React

<!--
Presenter: "This is a reference app that exercises the *whole* Loom stack end to
end: intent, planner, capabilities, agents, A2A, durable workflows, A2UI, and the
React renderer's fiber path. Runs fully offline — no API key."
-->

---

## What it is

You state a **goal** in plain English. Loom does the rest.

> **1.** "Why is CPU utilization high? Fix it if remediation is low risk."
> → diagnosed, assessed **low risk**, **auto-remediated** under policy.

> **2.** "Investigate the read-replica lag issue and fix it if remediation is low risk, **else wait for my approval**."
> → diagnosed, assessed **medium risk**, so it **pauses for a human**, then scales replicas on approval.

Same app, same agents — the **goal text** drives which workflow runs and whether a human is in the loop.

---

## The design, and where each piece lives

| Requirement | Where |
|---|---|
| Intent/goal-driven + human-in-the-loop | `IntentRuntime` routing + risk `gate()` in `orchestrator/Orchestrator.ts` |
| Workflow composed **dynamically** from the goal | `PlannerRuntime.plan(goal)` → ordered capability pipeline |
| Domain agents communicating over **A2A** | `agents/definitions.ts` + `a2a/InProcessA2ABus.ts` |
| **Long-running** agents | durable Loom flows in `capabilities/flows.ts` |
| Near-real-time **task list & status** | `AgentTaskList` widget on the `mission` A2UI surface |
| Agent tasks created **dynamically** | one `AgentTask` per plan step, at dispatch |
| **Observability** dashboard | `blueprints/ObservabilityBlueprint.ts` |

---

## Architecture

```
 goal ─▶ IntentRuntime (route)          ┌─ Diagnostics Agent ─┐
     └─▶ PlannerRuntime (plan) ─▶ Orchestrator ──A2A bus──▶  ├─ Remediation Agent ┤─▶ durable flows
                                    │  risk gate,             └─ Capacity Agent ────┘   (ctx.suspend /
                                    │  human-in-the-loop                                  resume for approval)
                                    ▼
                    A2UI surfaces:  "mission"  +  "telemetry"
                                    ▼
              BlueprintRenderer (fiber) over a custom RendererRegistry (React)
```

- **Left** = intelligence: intent routing + planning.
- **Middle** = the Orchestrator conducting agents over A2A, enforcing the risk policy.
- **Right** = generated UI: A2UI surfaces rendered by blueprints.

---

## Dynamic workflow — the planner *is* the workflow

```ts
const plan = await planner.plan(goal);        // ordered capabilityIds
// goal 1 → [diagnose-cpu, assess-remediation, apply-remediation]
// goal 2 → [diagnose-replica-lag, assess-remediation, scale-read-replicas]

for (const entry of plan.steps) {
  const task = createAgentTask(entry);        // one task per step, dynamically
  await bus.dispatch(entry.capabilityId, input, { onProgress, onApproval });
}
```

Different goal → different plan → a **different workflow**. Nothing is hard-wired.

<!-- Presenter: PlannerRuntime uses the LLM to compose an ordered plan; offline it
falls back to keyword ranking. Here a deterministic DemoLlmProvider returns the plan. -->

---

## Domain agents over A2A

Three long-running specialists, each a first-class `agent$` whose **AgentCard is derived from the definition** — version, capabilities, and skills live on the agent, not a parallel object:

```ts
export const DiagnosticsAgent = agent$({
  id: "diagnostics-agent", tools: [MetricsTool, ReplicaStatusTool],
  version: "1.0.0", capabilities: { streaming: true }, skills: [ … ], …
});
export const AGENT_CARDS = Object.fromEntries(FLEET.map((a) => [a.id, toAgentCard(a)]));
```

- The **A2A protocol shapes** are real (`AgentCard`, `A2ATask`, `A2ATaskResult`, status transitions); `toAgentCard` maps an `agent$` to its card — one source of truth.
- `InProcessA2ABus` is a **bring-your-own transport** — the same contract `@loom/a2a`'s HTTP `createA2AServer` serves, but in-process for the browser.
- The Diagnostics agent runs a genuine **ReAct loop** (`AgentRunner`) that calls the metrics tool, then reasons.

---

## Durable, resumable — human-in-the-loop

Mutating flows reach a **durable checkpoint**; the risk policy (or a human) resumes them:

```ts
// capabilities/flows.ts — apply-remediation
report(ctx.executionId, "Prepared: recycle pool. Awaiting sign-off…");
const decision = await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.target });
if (!decision.approved) return { applied: false, summary: "Rejected by " + decision.approvedBy };
return ctx.run(RestartPoolStep, { target: input.target });
```

- **Low risk** + goal allows → orchestrator auto-approves under policy.
- **Higher risk** → surfaces an approval, waits for the operator, then `resume()`s from the event log.

Same mechanism as `cloud-command-center`'s suspend/resume — replayable and restart-safe.

---

## Near-real-time surfaces (A2UI)

Agents narrate through a `progressHub`; the Orchestrator folds progress + metrics into two **A2UI surfaces**:

- **`mission`** — `phase`, `plan`, `tasks[]`, `pendingApproval`, `summary`
- **`telemetry`** — `metrics`, `history`, `fleet`, streaming `log`

```ts
this.mission.set("tasks", this.model.tasks);   // near-real-time task list
this.telemetry.append("log", `[${agentName}] ${line}`);
```

Widgets bind to slices (`{ projectionId: "mission", path: "tasks" }`) and update as the slices change.

---

## BYOR + BYOC

**BYOC** — custom widget *kinds* outside the built-in union (`widgets/customWidgets.ts`):

```ts
export const AgentTaskList = (b, t) => customWidget$({ kind: "AgentTaskList", title: t, binding: b });
// + PlanFlow, RiskApproval, Gauge, Sparkline, AgentFleet, ConsoleLog, LatencyChart
```

**BYOR** — a React component per kind, merged onto Loom's built-ins (`widgets/registry.ts`):

```ts
defaultRegistry.merge(
  new RendererRegistry().register("AgentTaskList", AgentTaskListRenderer). … );
```

Blueprints freely mix built-in (`MetricCard`) and custom widgets — the renderer looks each up by `kind`.

---

## Render-side fiber

```tsx
<BlueprintRenderer fiber={{ granularUpdates: true, suspense: true, deferStreaming: true }} … />
```

- **granularUpdates** — only the widget whose slice changed re-renders (one task row, not the tree).
- **deferStreaming** — the high-frequency console feed is fed through `startTransition`.
- **suspense** — the lazy `LatencyChart` (BYOC) suspends behind its own boundary without blanking siblings.

A header toggle flips fiber **off** to compare against the eager whole-tree path.

<!-- Presenter: fiber here is React-fiber-backed capabilities on the render path,
not a second reconciler — see the scheduler memo / docs/benchmarks.md. -->

---

## Human-in-the-loop, unmissable

The approval control must be reachable no matter what the operator is looking at:

- A **tab-independent approval banner** (`App.tsx`, via `useProjection("mission")`) appears whenever a decision is pending — Approve / Reject wired straight to `orchestrator.resolveApproval`.
- Plus the in-blueprint `RiskApproval` widget on Mission Control.

<!-- Presenter: this was a real fix — the only control used to live in one tab's
corner; now it's a prominent banner covered by a jsdom render test. -->

---

## File map

```
src/
  agents/          domain agents (agent$ + tools), AgentCards, a genuine ReAct runner
  capabilities/    capability$ definitions + the durable flows they wrap, + catalog
  a2a/             InProcessA2ABus — the bring-your-own A2A transport
  orchestrator/    Orchestrator — intent → plan → A2A dispatch → risk gate → HITL
  blueprints/      Mission Control + Observability blueprints
  widgets/         BYOC custom widgets, BYOR React renderers, merged registry
  runtime/         browser stores, DemoLlmProvider, progressHub, services
  App.tsx main.tsx the command-center shell + wiring
```

---

## Run it

```bash
pnpm --filter @loom/db-command-center dev        # http://localhost:5173
```

1. Click the **CPU** example → watch the plan compose, tasks stream, CPU gauge recover — **auto-fixed**.
2. Click the **replica** example → at the risk gate the **approval banner** appears → **Approve** → replicas scale.
3. Toggle **render-side fiber** off/on to feel the difference.

Offline by default (`DemoLlmProvider`); swap for `AnthropicProvider({ model: "claude-opus-4-8" })` in `runtime/services.ts`.

**Verified:** `tsc` + Biome clean, `vite build` OK, orchestration + approval-UI tests pass.

---

## Takeaways

- A goal in, a **dynamically planned, durable, multi-agent workflow** out.
- **A2A** makes the agent fleet a first-class, swappable topology.
- **Human-in-the-loop** is a durable `ctx.suspend` checkpoint, not a modal.
- **BYOR/BYOC/fiber** keep the UI declarative, extensible, and fast — and prove the runtime is UI-agnostic.

> Next: the **same app** with **zero framework** → `db-command-center-wc-deck.md`.
