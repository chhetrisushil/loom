# agent-swarm — a dynamic agent-swarm wired from a user's intent

A minimal, **headless, offline** (no API key) reference app: a *release-audit swarm*.
You give it a goal in plain language — *"Audit checkout-service for the 2.4 release;
sign off if low risk else wait for my approval"* — and a fleet of responsibility-scoped
agents is **dynamically wired** to solve it: the intent is routed, a plan is composed,
the specialists run, and the release is gated on a human sign-off.

It demonstrates the whole pattern **and closes the two gaps** that the plain
intent→plan→dispatch loop leaves open (see [db-command-center](../db-command-center)
for the UI-driven version of the same primitives).

## What it shows

```
 goal ──▶ IntentRuntime.route ──▶ PlannerRuntime.plan ──▶ [ordered pipeline]
                                                              │
        ┌─────────────────────────────────────────────────────┘
        ▼
  record-plan          (durable: the wiring decision is written to the log)   ◀── gap-closer #1
        ▼
  scope-audit          (sequential, dispatched to the Scope agent over A2A)
        ▼
  ┌─ security-audit ─┐
  ├─ perf-audit      ┤  executeGraph fan-out — 3 specialists in parallel, joined  ◀── gap-closer #2
  └─ deps-audit    ──┘
        ▼
  signoff-release      (durable ctx.suspend → decideApproval → resume)         ◀── human-in-the-loop
```

- **A fleet of `agent$` agents**, each with one responsibility + its own tools
  (`src/agents/definitions.ts`), advertised as A2A `AgentCard`s.
- **Dynamic wiring from intent** — `IntentRuntime` + `PlannerRuntime` compose the
  pipeline from the goal (`src/orchestrator/SwarmConductor.ts`). A deterministic
  offline `SwarmLlmProvider` stands in for a model; swap in `AnthropicProvider` and
  nothing downstream changes.
- **Dispatch to the fleet** over the in-process A2A bus (`app.bus.dispatch`), routed
  by the static `CAPABILITY_AGENT` map.
- **Durable + replayable** — every capability is an event-sourced flow; the sign-off
  pauses at `ctx.suspend` and resumes from the log.

### Gap-closer #1 — the plan is recorded durably

The plain pattern computes the plan in app memory, so "which agents were wired to
solve this goal" is recomputed on replay and never auditable. Here the conductor
**dispatches a `record-plan` flow first** (`src/capabilities/flows.ts`): it `ctx.emit`s
a `PLAN_COMPOSED` event *and* the plan rides `EXECUTION_STARTED.input` as a backstop —
so the decision is in the durable log before any audit runs.

### Gap-closer #2 — parallel fan-out with a join

The planner emits a **linear** list, but the three specialist audits are independent.
The conductor runs them with `executeGraph` (`@loom/graph-executor`): each is its own
execution (one writer per log), fanned out in parallel and **joined at the returned
barrier** (`graph.completed`, `graph.byId.<id>.output`).

> **The teachable insight:** the durable record is the *decision* (the linear plan);
> the conductor's *schedule* (parallel fan-out) is separate. Recording the plan does
> not force you to execute it in that shape.

## Run it

```bash
pnpm --filter @loom/agent-swarm start   # headless: a medium-risk run (pauses for sign-off) + a low-risk run (auto)
pnpm --filter @loom/agent-swarm test    # durable-plan, parallel-join, and HITL assertions
```

Both goals are deterministic: **checkout-service → medium risk → waits for a human**;
**payments-service → low risk → auto-signs-off** under the risk policy.

## Going distributed

The swarm runs in-process here via `LocalDispatcher(new LocalWorkerRuntime(app.runtime))`
(`src/app.ts`). Because `executeGraph` talks to the dispatcher — not the runtime — the
same fan-out runs off-box by swapping in a `RemoteWorkerRuntime` (HTTP) or a Cloud Run
dispatcher. The `ExecutionPackage` carries resume coordinates, never code.

## Files

| Path | Purpose |
|------|---------|
| `src/agents/definitions.ts` | The `agent$` fleet + `AGENT_CARDS` + `CAPABILITY_AGENT` map |
| `src/agents/tools.ts` | The agents' `tool$`s + deterministic mock domain work |
| `src/capabilities/flows.ts` | The six durable flows (`record-plan` emits `PLAN_COMPOSED`; `signoff-release` suspends) |
| `src/capabilities/catalog.ts` | `capability$` wrappers + `buildCatalog()` (registers all six) |
| `src/orchestrator/SwarmConductor.ts` | Route → plan → record → scope → `executeGraph` fan-out → HITL sign-off |
| `src/app.ts` | `defineConfig` composition root + the compute dispatcher |
| `src/main.ts` | Headless driver |
| `test/swarm.test.ts` | The four assertions |
