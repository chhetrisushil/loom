---
marp: true
theme: default
paginate: true
title: "Loom — Durable AI Workflows"
---

<!-- _paginate: false -->

# Loom

### Make AI workflows as durable, inspectable, and reproducible as a database transaction — without giving up the flexibility of code.

**event sourcing · deterministic replay · durable suspend/resume · git-style branching · run anywhere**

<!--
Presenter: This is the flagship overview deck. ~20 min. Long-form docs:
docs/architecture.md, docs/usage.md, docs/user-guide.md.
Open with the one-liner, then the mission slide.
-->

---

## Mission

> **Make intelligent, long-running, human-in-the-loop software as durable, inspectable, and reproducible as a database transaction — without giving up the flexibility of code.**

A Loom workflow is a **process that unfolds over time**, not a request that returns once.

Every decision it makes is an immutable fact in a log — so it can **pause for a human, resume on another machine, replay bit-for-bit, fork to explore alternatives, and be evaluated against its own history.**

---

## The problem

AI now lives inside flows that…

- **run for a long time** — seconds to days, often pausing for a human
- **call non-deterministic, expensive, fallible services** — models, tools, other agents
- **must survive crashes, deploys, restarts** — without losing or double-running work
- **must be explainable** — *why* did the agent do that?
- **want alternatives explored** — what if we'd tried the other fix?

The usual tools force a bad trade:

| Request/response framework | Heavyweight workflow engine |
| --- | --- |
| Easy to write | Durable |
| ❌ forgets on crash | ❌ restrictive DSL |
| ❌ can't pause for humans | ❌ external server, fights your UI |
| ❌ no replay | ❌ no deterministic replay |

---

## The thesis

## The durable event log is the moat.

If every meaningful thing that happens is appended to an **ordered, immutable log**, then durability, resumability, replay, branching, evaluation, and time-travel debugging are all just **different lenses on the same log**.

```
                     ┌──────────────────────────┐
   durability ◄──────┤                          ├──────► replay / debug
   resume     ◄──────┤    append-only event log ├──────► evals
   branching  ◄──────┤    state = fold(events)  ├──────► deploy-sim
   distribute ◄──────┤                          ├──────► audit
                     └──────────────────────────┘
```

Build that spine well; keep authoring in plain TypeScript; everything else composes.

---

## Core principles (1/2)

**P1 — The log is the source of truth.** State is `fold(events)`, never stored directly.

**P2 — Replay is deterministic & pure.** Same events → same state. No clock, no randomness on replay paths.

**P3 — Suspension is a first-class, normal outcome.** Pausing for a human is as routine as completing.

**P4 — The intelligence stays as plain code.** A flow is an ordinary `async` function — no DSL, no cage.

---

## Core principles (2/2)

**P5 — Wiring is static & replay-safe.** Registration is build-time; conventions via codegen, not runtime globbing.

**P6 — Composition over inheritance.** Reusable pieces are functions you compose, never base classes you `extends`.

**P7 — Pure cores, thin edges.** Every capability is a pure, testable function behind a thin I/O shell.

**P8 — Isomorphic core, pluggable edges.** The same flow runs in a test, a browser, a Node server, or Cloud Run.

---

## The shape of a Loom app

```
  ✍️  AUTHORING (plain TypeScript)
      step$ / handler$   →   flow$ + runner (async fn)   →   agent$ / tool$
                                     │
  🧵  DURABLE CORE (isomorphic, deterministic)
      WorkflowRuntime  ──►  ExecutionJournal  ──►  ReplayVM + foldEvents
       start/resume/fork     sole sequencer         pure state = fold(events)
                                     │
  🔌  PLUGGABLE EDGES
      EventStore/Snapshot   ProjectionRuntime+agent-surface   Dispatcher+Worker   LLM/MCP/A2A
      (memory·SQLite·PG)    (React·WC·terminal)       (local·HTTP·Cloud Run)
```

You write functions. Loom records every meaningful moment as a sequenced event, folds those into state, and quarantines side effects so replay is exactly-once.

---

## A flow is just a function

```ts
const runner: FlowRunner<In, Out> = async (ctx, input) => {
  surface(ctx).set("phase", "investigating");
  const found = await ctx.run(investigateStep, { target: input.target });

  // Durable checkpoint — persists, hands control back to the caller.
  const decision = await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.target });

  if (!decision.approved) return { applied: false };
  return ctx.run(applyStep, { target: input.target });
};
```

`ctx.run` (recorded work) · `ctx.suspend` (durable pause) · `ctx.parallel` · `surface(ctx).*` (live UI).
Everything else is ordinary `async`/`await`, `if`, `for`, and your types.

---

## The durable write pipeline

```
 Flow runner ──ctx.run──► ExecutionJournal ──► ReplayVM (sync, authoritative)
                             │  ++sequence          │
                             │  (sole allocator)    ▼
                             └──────────────► EventStore (async, ordered tail)
```

One journal per execution is the **only** sequence allocator and the **only** appender.

→ No gaps, no duplicates, no multi-writer races — the foundation of correct replay.
→ Sync in-memory fold keeps the flow fast; async durable write preserves order and surfaces failures.

---

## Suspend & resume

```
  start() ──► running ──ctx.suspend()──► suspended ──(durable; may outlive the process)
                 ▲                             │
                 └──── resume(id, event) ◄─────┘   payload → return value of suspend()
                 │
              re-runs from the top, but completed steps are SERVED FROM THE LOG
              (effects never re-run) → deterministic, exactly-once
```

A crash mid-flight is just a resume: fold state, and if still `running`, continue. No step re-runs.

---

## Git-style branching: fork → simulate → promote

```
  parent … suspended @k (the gate)
        │
        ├── fork@k ─► strategy A ─ resume(simulate:true) ─┐
        ├── fork@k ─► strategy B ─ resume(simulate:true) ─┤─► compare projected outcomes
        └── fork@k ─► strategy C ─ resume(simulate:true) ─┘          │
                                                                     ▼
                          promote winner: fork@k ─ resume(simulate:false) ─► ref "main"
```

Because state is `fold(events)`, a fork is just copying the prefix. **No merge** — promotion is a pointer move. Losing branches stay immutable: a full audit trail of what was tried and why.

---

## Tooling = lenses on the log

The log already contains everything, so the tools are pure functions over it:

| Command | What it is |
| --- | --- |
| `loom logs` | tail the event timeline |
| `loom debug --at N` | **time-travel** — fold state at any sequence |
| `loom inspect` | web timeline + time-travel slider |
| `loom eval` | replay golden logs vs expectations (CI gate) |
| `loom deploy check` | replay history vs **new** flow defs — catch resume-breaking deploys |

A pure fold at a chosen sequence *is* time-travel. A replayed log *is* an eval. One engine, consistent everywhere.

---

## Run anywhere — the same flow

```
  defineConfig({ execution: { dispatcher } })
        │
        ▼
  ExecutionDispatcher ──► local (in-process)
                      ──► remote (HTTP → stateless worker-server)
                      ──► Cloud Run (platform-cloudrun)
```

An **ExecutionPackage** carries *resume coordinates* (identity + sequence) — **never code**. Workers ship their own bundle and resolve flows **by id** from a static registry.

→ Stateless workers recover from crashes by folding shared stores. The public SDK is unchanged whether you run local or in the cloud.

---

## Why these decisions pay off

| Decision | Advantage |
| --- | --- |
| Event sourcing (P1) | free audit trail, time-travel, resume from anywhere |
| Deterministic pure replay (P2) | exactly-once effects, reproducible debugging, logs-as-tests |
| Single journal/sequencer | correct order with no locks; network stores plug in cleanly |
| Flow = async function (P4) | full language power, trivial testing, zero DSL lock-in |
| Static wiring + codegen (P5) | replay-safe distribution, no registration drift |
| Projections decoupled (P7/P8) | UI-framework-agnostic; same backend → React, WC, Angular |
| Placement seam (P8) | in-process → Cloud Run with no core changes |
| Branching, no merge | cheap "what-if"; winning path committed; losers audited |

Full reasoning: **`docs/architecture.md` §7** and **`docs/adr/` (0001–0015)**.

---

## See it run

- **`agent-network`** — the whole agentic pipeline: LLM, ReAct agent, MCP, A2A, intent, planner, memory. *2 min, offline.*
- **`db-command-center`** — intent → planner → A2A dispatch → durable human approval, live UI. *Same backend in React, Web Components, and Angular.*
- **`incident-war-room`** — fork → simulate → compare → promote, as a live war room.
- **`schema-migration-planner`** — the same branching on a second domain, with live per-branch progress.

```bash
pnpm install && pnpm build
pnpm --filter @loom/agent-network start
```

---

## Start in 5 minutes

```bash
npm create loom-app@latest my-app && cd my-app && pnpm install
```

```ts
const app = defineConfig({ storage: { kind: "memory" }, surfaces: ["default"], flows: [myFlow] });
const handle = await app.runtime.start(myFlow, { name: "Ada" });
const state  = await handle.waitForCompletion();
```

**Three moves to remember:**
1. `ctx.run(step)` — recorded, replay-safe work
2. `ctx.suspend({ on })` — pause durably for a human
3. `runtime.fork(id, seq)` — branch to explore alternatives

📖 `docs/getting-started.md` → `docs/usage.md` → `docs/user-guide.md` → `docs/architecture.md`

---

<!-- _paginate: false -->

# Loom

### A process, not a request.

**The durable event log is the moat — everything else is a lens on it.**
