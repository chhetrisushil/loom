---
marp: true
theme: default
paginate: true
title: "Loom — Architecture"
---

<!-- _paginate: false -->

# Loom — Architecture

### Durable, event-sourced AI workflows — the system design

**Event sourcing · deterministic replay · isomorphic core · durable suspend/resume · build-time optimization**

`docs/architecture.org` — the long form

<!--
Presenter: "This deck is the system architecture — how a workflow suspends,
survives a restart, and resumes without re-running work. The engineering deck
covers the developer-facing primitives; this one is the machinery underneath."
-->

---

## The thesis

> **Intelligence behaves like a process, not a request** — optimize for *continuation*, not *hydration*.

A workflow function can be interrupted at any point — waiting on a tool, an LLM, or a **human** — **survive a process restart**, and resume from exactly where it left off…

**…without the application code knowing** the difference between a fresh run and a replay.

That single guarantee is what the whole architecture is built to deliver.

---

## Four ideas underpin everything

1. **Event sourcing** — every state change is an immutable `EventEnvelope` appended to an ordered log. State is *always derived* by replaying the log, never mutated in place.
2. **Deterministic replay** — on resume, the `ReplayVM` fast-forwards the log so completed steps return **cached outputs** instead of re-executing.
3. **Blueprint-driven UI** — the flow emits domain events; `ProjectionRuntime` folds them into view models; a JSON `Blueprint` renders to live widgets bound to those models.
4. **Build-time optimization** — `@loom/compiler` extracts co-located handlers into lazy chunks, validates flow graphs, and generates resumability metadata.

Everything else is a consequence of these four.

---

## Isomorphic core — one runtime, two environments

The execution core has **no Node or DOM imports**; the *edges* are the only environment-specific parts, and stores/transports are **injected**.

```
ISOMORPHIC CORE  (Node or browser — stores & effects injected)
  core · workflow-runtime · effect-runtime · replay-vm · projection-runtime
  blueprint-runtime · capability · intent · planner · agent · memory · scheduler
  fetch-based I/O: @loom/llm · @loom/mcp client · @loom/a2a CLIENT

SERVER-ONLY (Node)                    CLIENT-ONLY (browser)
  SqliteEventStore  (better-sqlite3)    @loom/renderer-react
  SqliteSnapshotStore                   (or BYOR: DOM / Web Components)
  createA2AServer   (node:http)
  @loom/renderer-terminal · @loom/compiler (build time)
```

**What you inject decides where it runs.**

---

## Pluggable edges — same core, different wiring

The store/transport interfaces each ship two implementations — pick per environment:

| Concern | Browser / tests | Server / production |
|---|---|---|
| `EventStore` | `InMemoryEventStore` | `SqliteEventStore` (WAL, durable) |
| `SnapshotStore` | `InMemorySnapshotStore` | `SqliteSnapshotStore` |
| Agent transport | `createA2AClientEffect` (`fetch`) | `createA2AServer` (`node:http`) |
| Surface | `@loom/renderer-react` / BYOR DOM | `@loom/renderer-terminal` (TUI) |

The only *runtime* Node-only deps are the SQLite stores and the A2A server.
`@loom/compiler` is Node-only but runs at **build time**, never bundled.

---

## Package dependency graph

```
                @loom/compiler   (Vite plugin + CLI — build time only)
                      │ transforms
                      ▼
                  @loom/sdk       (public re-export surface — start here)
        ┌────────────┼───────────────┬─────────────────┐
        ▼            ▼               ▼                 ▼
 workflow-runtime  blueprint-   projection-      renderer-react
        │           runtime      runtime
        ▼            ▼               ▼
 effect-runtime · event-runtime · snapshot-runtime · replay-vm
        └───────────────────────────► @loom/core (types, builders, SuspendError)

 Agentic:      llm · agent · mcp · a2a · a2ui · registry
 Intelligence: capability · intent · planner · memory · renderer-terminal
 Scheduler:    scheduler (ephemeral, dependency-free)
 Optional:     telemetry (depends only on core — OTel-ready)
```

Every package depends on `@loom/core`. Apps import `@loom/sdk`.

---

## Execution model — `WorkflowRuntime`

The central coordinator owns the event store, snapshot store, and effect runtime. Three entry points, one `execute()`:

```
start()             → append EXECUTION_STARTED · new ReplayVM([start]) · execute()
resume()            → load events + snapshot · append resume + RESUMED · execute()
restoreFromState()  → accept preloaded state · new ReplayVM([], state) · execute()
                      (client-side path — no EventStore read)

execute() → returns ExecutionHandle immediately, spawns async runner:
   runner resolves    → EXECUTION_COMPLETED
   SuspendError thrown → EXECUTION_SUSPENDED  + save Snapshot
   other error        → EXECUTION_FAILED
```

`registerFlow()` auto-registers a `LazyEffect` for every `handler$` step — no manual wiring.

---

## `WorkflowContext` — the only API a flow touches

```ts
const run: FlowRunner<In, Out> = async (ctx, input) => {
  const metrics = await ctx.run(FetchMetricsStep, input);   // durable step
  const logs    = await ctx.run(FetchLogsStep, input);
  const [a, b]  = await ctx.parallel([...], { limit: 4 });  // ordered fan-out
  ctx.emit("ANALYSIS_COMPLETE", { metrics, logs });         // domain event
  await ctx.suspend({ on: "ApprovalGranted", correlationKey: id });  // human gate
  return ctx.run(ApplyRemediationStep, input);
};
```

- `ctx.run` — replay-aware: **cached output** if already completed, else execute + emit.
- `ctx.parallel` — bounded, **input-order-preserving** (load-bearing for replay).
- `ctx.suspend` — throws `SuspendError` on first run; **passes through** on resume.

---

## Event sourcing → `ReplayVM`

`ExecutionState` is built by folding the event log through pure handlers (`foldEvents`):

```
[EXECUTION_STARTED] [STEP_COMPLETED: fetch-metrics] [STEP_COMPLETED: fetch-logs]
[EXECUTION_SUSPENDED] [ApprovalGranted] [EXECUTION_RESUMED]
        │  foldEvents()
        ▼
ExecutionState { status: "running",
  frames: { "fetch-metrics": { status: "completed", output: {…} },
            "fetch-logs":    { status: "completed", output: {…} } },
  variables: { _resumePayload: { approved: true } }, sequence: 7 }
```

When the runner calls `ctx.run(FetchMetricsStep)`, `vm.hasCompleted("fetch-metrics")`
is already `true` → returns the cached output **instantly, no re-execution**.

---

## The killer property: durable suspend / resume

```
        FIRST RUN                         RESUME (fresh process)
──────────────────────────    ─────────────────────────────────────
ctx.run(step-A) → executes      ctx.run(step-A) → hasCompleted ✓ cached
ctx.run(step-B) → executes      ctx.run(step-B) → hasCompleted ✓ cached
ctx.suspend()   → throw         ctx.suspend()   → _resumePayload → pass through
  ↓ runtime saves Snapshot      ctx.run(step-C) → NEW → executes ✓
  resolves waitForSuspend()
```

- **Suspend is a thrown `SuspendError`** — so the runner reads as a linear function; no callback nesting.
- Resume can be **24 hours** or **a different machine** later — state lives in the log, not memory.
- `suspendPassthroughConsumed` ensures only the *first unresolved* suspend passes through per resume.

---

## Effects — the side-effect sandbox

Every side effect is registered by name; that makes them **swappable** (real in prod, mock in tests) and **uniform** (LLM, tool, human, remote agent all durable):

| Class | Kind | Behaviour |
|---|---|---|
| `ToolEffect` | `tool` | wraps any async fn — HTTP, DB, … |
| `LlmEffect` | `llm` | an LLM call (`createLlmEffect` / `AgentRunner`) |
| `HumanEffect` | `human` | throws `SuspendError` immediately — the suspend bridge |
| `A2AEffect` | `a2a` | agent-to-agent delegation |
| `LazyEffect` | `tool` | resolves a `handler$` spec on first call |

`EffectContext.signal` (optional `AbortSignal`) threads cancellation to `fetch` — `handle.cancel()` propagates promptly, cooperatively.

---

## `LazyEffect` + the compiler — co-location bridge

`handler$(fn)` is written **next to** its step; the compiler decides how it loads:

```
runtime (no compiler):  handler$(fn) → HandlerRef  → LazyEffect calls fn directly (0 overhead)
build time (compiler):  handler$(fn) → () => import("chunk")  → loaded lazily on first execute
```

`@loom/compiler` (Vite plugin + CLI) does three things at build time:

1. **Lazy chunk extraction** — each `handler$` (and each skill's `instructions$`) → its own `import()` chunk, recorded in `loom-manifest.json`.
2. **Static flow-graph analysis** — validates step wiring before runtime.
3. **Resumability primitives** — metadata so a client restores without a server round-trip.

> `handler$` being a **runtime no-op** means tests and dev work with **no build step**. The rewrite is pure optimization, not correctness.

---

## Events → projections → surfaces

State is the log; **read models are projections**; the UI **binds to projection slices**:

```
domain events ──▶ ProjectionRuntime (foldEvent) ──▶ view models ──▶ Blueprint widgets
  STEP_COMPLETED     MetricsProjection                  MetricCard { path: "cpu" }
  A2UI_PATCH         "ui" surface                       StreamingText { path: "aiAnalysis" }
```

- **Blueprints are JSON, framework-free** — a server step can emit one; any renderer picks it up.
- **BYOR**: `@loom/renderer-react`, `@loom/renderer-terminal`, or a DOM/Web-Components layer — the runtime carries **zero framework imports** (see `angular-command-center`).
- A refresh or resume **rebuilds the exact screen** from the log.

---

## Cooperative scheduler — fiber principles, right layer

`@loom/scheduler` is an **ephemeral, dependency-free** priority-ordered semaphore + `AbortSignal` cancellation — for the *live window between events*.

> **Why not a Fiber reconciler?** Fiber slices a CPU-bound render against a frame deadline. Loom's trees are dashboard-sized (`traverseBlueprint`: 10k nodes in ~0.47ms), and where React is the surface, React *already* has fiber. A second reconciler = duplicate machinery, added latency, no gain.

The fiber *principles* — priority, interruptibility, bounded fan-out — pay off in the **async agentic layer**: cancel an in-flight LLM call, order a foreground turn ahead of background planning, cap tool concurrency. It **complements** the durable pause/resume already owned by `SuspendError` + `ReplayVM`; scheduler state is never persisted. Default `concurrency: Infinity` ⇒ zero overhead.

---

## Resumability — server → client handoff

"Continuation, not hydration": start (and suspend) on a server, continue and render on a client, **no re-running completed work**:

```
server:  run to checkpoint → serializeExecution(state) + serializeProjections(...)  → JSON
client:  <LoomProvider serializedExecutionState serializedProjectionState>
           seedState() seeds projections synchronously — no re-fold, no empty flash
next input (e.g. approval):
         WorkflowRuntime.restoreFromState(preloaded, resumeEvent)
           → new ReplayVM([], preloadedState) → hasCompleted ⇒ completed steps never re-run
```

The compiler's lazy chunks mean the client downloads a step's code **only when reached**.
`db-command-center-server` shows this production topology over HTTP + SSE.

---

## Full lifecycle — one incident, start to resolved

```
start(Flow, {incidentId}) → EXECUTION_STARTED → handle
 runner:
   ctx.run(FetchMetrics)  → LazyEffect → {cpu,memory,connections} → STEP_COMPLETED
   ctx.run(FetchLogs)     → …
   ctx.emit(ANALYSIS_COMPLETE) → ProjectionRuntime → MetricCards update
   ctx.emit(APPROVAL_REQUESTED) → ApprovalCard appears
   ctx.suspend({on:"ApprovalGranted"}) → throw SuspendError
       → EXECUTION_SUSPENDED · SnapshotStore.save · badge "SUSPENDED"
 ── operator approves ──
 resume(id, {ApprovalGranted}) → load snapshot · RESUMED · new ReplayVM(tail, state)
   ctx.run(FetchMetrics/Logs) → cached ✓   ctx.suspend() → pass through ✓
   ctx.run(ApplyRemediation)  → executes   ctx.emit(RESOLVED)
       → EXECUTION_COMPLETED · badge "COMPLETED"
```

Same code path on first run and replay — the runtime hides the difference.

---

## Design decisions — the "why"

| Decision | Why |
|---|---|
| **Event sourcing** | one durable write; state always derived → debug, audit, resume for free |
| **`SuspendError` (throw, not return)** | flow reads as a linear function; no callback nesting after a pause |
| **`handler$` no-op at runtime** | dev/tests/no-build-step work out of the box; compiler is pure optimization |
| **Cooperative scheduler, not a reconciler** | fiber principles belong in the async layer; the renderer already has fiber |
| **JSON-serializable Blueprints** | server-generated UI, persisted layouts, cross-renderer — no React coupling |
| **Separate `@loom/compiler`** | TS/Vite deps never reach the browser bundle |
| **UI-agnostic runtime** | only `@loom/renderer-react` is framework-specific → Angular/Vue/Node all reuse it |

---

## Takeaways

- **Event sourcing is the foundation** — durability, auditability, and resume are the *same* mechanism.
- **Replay makes resume invisible**: `ctx.run` returns cached outputs; the flow author writes a plain linear function.
- **Suspend is a thrown error + a snapshot** — a human gate that survives restarts and machine boundaries.
- **Isomorphic core, injected edges** — the same runtime powers an offline browser demo and a durable Node server.
- **Fiber principles in the async layer, not the renderer** — opt-in, default-off, zero-overhead fast paths.

> Deep dives: `engineering-deck.md` (primitives & API) · `cloud-command-center-deck.md` (durable UI) · `a2a-mesh-deck.md` (interop).
