# DB Command Center

An **agentic command center for databases** built on the Loom framework. It is
intent/goal driven with a human in the loop, composes a workflow dynamically from
the goal, dispatches work to a fleet of long-running domain agents over **A2A**,
and streams every agent task and metric to the UI in near-real-time.

It is also a showcase of Loom's **BYOR** (bring-your-own-renderer),
**BYOC** (bring-your-own-component), and render-side **fiber** capabilities.

```
pnpm --filter @loom/db-command-center dev      # http://localhost:5173
pnpm --filter @loom/db-command-center build:ui # production bundle
```

No API key required — a deterministic offline `DemoLlmProvider` plays every model
role. Swap it for `AnthropicProvider({ model: "claude-opus-4-8" })` in
`src/runtime/services.ts` to go live; nothing else changes.

## Try it

Type a goal (or click an example) and press **Run Intent**:

1. *"Why is CPU utilization high? Fix it if remediation is low risk."*
   → diagnosed, assessed **low risk**, and **auto-remediated** under policy.
2. *"Investigate the read-replica lag issue and fix it if remediation is low
   risk, else wait for my approval."*
   → diagnosed, assessed **medium risk**, so it **pauses for your approval** in
   the Human-in-the-Loop card before scaling replicas.

Toggle **render-side fiber** in the header to compare the granular/suspense/
deferred render path against the eager whole-tree path.

## How it maps to the design

| Requirement | Where |
|---|---|
| 1. Intent/goal driven, human-in-the-loop | `IntentRuntime` routing + the risk gate in `orchestrator/Orchestrator.ts` (`gate`) that pauses for approval |
| 2. Workflow composed dynamically from the goal | `PlannerRuntime.plan(goal)` → an ordered capability pipeline (`PlanFlow` widget renders it) |
| 3. Domain agents communicating over A2A | `agents/definitions.ts` (agent$ with AgentCards derived via `toAgentCard`) dispatched through `a2a/InProcessA2ABus.ts` |
| 4. Long-running agents | Agents are durable Loom flows (`capabilities/flows.ts`) that stream progress; the `AgentFleet` widget shows their health |
| 5. Near-real-time task list & status | `AgentTaskList` widget bound to the `mission` surface, updated as each A2A task transitions |
| 6. Agent tasks created dynamically | One `AgentTask` per plan step, created at dispatch time in the orchestrator |
| 7. Observability dashboard | `blueprints/ObservabilityBlueprint.ts` — gauges, sparkline, lazy chart, fleet health |

## Architecture

```
 goal ──▶ IntentRuntime (route)         ┌─ Diagnostics Agent ─┐
      └─▶ PlannerRuntime (plan) ──▶ Orchestrator ──A2A bus──▶ ├─ Remediation Agent ┤─▶ durable flows
                                        │  (risk gate,        └─ Capacity Agent ────┘   (suspend/resume
                                        │   HITL approval)                               for approval)
                                        ▼
                        A2UI surfaces: "mission" + "telemetry"
                                        ▼
                     BlueprintRenderer (fiber) over a custom RendererRegistry
```

- **Intent → Plan → Dispatch.** The `Orchestrator` routes the goal to a primary
  capability (`IntentRuntime`), composes an ordered pipeline (`PlannerRuntime`),
  then creates one agent task per step and dispatches it over the A2A bus.
- **A2A transport (BYO).** `InProcessA2ABus` implements the A2A protocol shapes
  (`AgentCard`, `A2ATask`, `A2ATaskResult`, status transitions) in-process for
  the browser — the same contract `@loom/plugin-a2a`'s HTTP `createA2AServer` serves.
- **Durable, resumable agents.** Each capability is a real Loom flow. The
  mutating `apply-remediation` / `scale-read-replicas` flows reach a durable
  `ctx.suspend` checkpoint; the risk policy or a human resumes them.
- **Human-in-the-loop.** When risk isn't low, the orchestrator surfaces a
  `RiskApproval` card and the durably-suspended flow waits until you Approve or
  Reject.
- **Near-real-time surfaces.** Agents narrate via a `progressHub`; the
  orchestrator folds progress and metrics into the `mission` and `telemetry`
  A2UI surfaces, which the blueprints render live.

## BYOR / BYOC / fiber

- **BYOC** — `widgets/customWidgets.ts` declares custom widget *kinds*
  (`AgentTaskList`, `PlanFlow`, `RiskApproval`, `Gauge`, `Sparkline`,
  `AgentFleet`, `ConsoleLog`, `LatencyChart`) with `customWidget$`, outside
  Loom's built-in `WidgetKind` union.
- **BYOR** — `widgets/renderers.tsx` provides a React component per kind;
  `widgets/registry.ts` merges them onto Loom's built-in renderer set. Blueprints
  freely mix built-in (`MetricCard`) and custom widgets.
- **fiber** — `BlueprintRenderer fiber={{ granularUpdates, suspense,
  deferStreaming }}` opts into React-fiber-backed capabilities: only the widget
  whose slice changed re-renders (the live task list), the streaming console is
  fed through `startTransition`, and the lazy `LatencyChart` suspends behind its
  own boundary without blanking siblings.

## Layout

```
src/
  agents/          domain agents (agent$ + tools), AgentCards derived via toAgentCard, a genuine ReAct runner
  capabilities/    capability$ definitions + the durable flows they wrap, + catalog
  a2a/             InProcessA2ABus — the bring-your-own A2A transport
  orchestrator/    Orchestrator — intent → plan → A2A dispatch → risk gate → HITL
  blueprints/      Mission Control + Observability blueprints
  widgets/         BYOC custom widgets, BYOR React renderers, merged registry
  runtime/         browser stores, DemoLlmProvider, progressHub, services
  App.tsx main.tsx the command-center shell + wiring
```
