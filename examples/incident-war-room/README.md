# Incident War Room — git-style branching on Loom

An SRE is resolving a production incident (**read-replica lag** spiking on `orders-db`) under change
control. There is more than one defensible fix, and they are **mutually exclusive** — you cannot both fail
over the primary *and* keep scaling its replicas. So at the high-risk approval gate, instead of a single
approve/reject, the operator **branches**: fork the suspended execution once per candidate strategy,
**simulate** each speculatively, **compare** the projected outcomes in a git-graph diff, and **promote**
the winner — which then executes for real. Rejected branches survive as immutable lineage: the
*alternatives-considered* audit trail regulated changes require.

This is the example built to show off Loom's most distinctive and least-demonstrated capability:
**git-style branching for durable executions** (`WorkflowRuntime.fork()` + `BranchRegistry` +
`promote()`), branch-only, **no merge**.

> **Sibling example:** [`schema-migration-planner`](../schema-migration-planner/README.md) applies the
> *same* fork/simulate/promote seam to a different domain (choosing a schema-migration strategy),
> reusing the `BranchOrchestrator` and branch UI verbatim — plus live per-branch simulation progress.

```
pnpm --filter @loom/incident-war-room dev     # client :5173  +  server :8787
# then open http://localhost:5173
```

Fully offline (deterministic `DemoLlmProvider`). `dev` runs both processes; or run
`dev:server` (Node runtime, :8787) and `dev:client` (Vite, proxies `/api`) separately;
`start` builds the client and serves everything from the Node server on one port.

## The loop

1. **Detect** — state the goal ("investigate the replica lag and fix it…"). `IntentRuntime` routes it;
   `PlannerRuntime` composes *diagnose → assess → remediate*. The read-only diagnose/assess steps run over
   the in-process A2A bus (`DiagnosticsAgent`, `RemediationAgent`, `CapacityAgent`).
2. **Gate** — the mutating remediation flow suspends at a durable approval gate (`ctx.suspend`). `main`
   points at the suspended execution. The UI jumps to the **War Room** tab.
3. **Explore branches** — the server forks one child per candidate strategy from the gate and resumes each
   **in `simulate` mode**, concurrently, via `@loom/scheduler`'s `parallelLimit`. Each branch previews a
   projected outcome (lag-after, ETA, downtime, cost, risk) **without touching real infrastructure**. The
   parent log is never modified (copy-on-write).
4. **Compare** — the branch graph + side-by-side diff fill in live over SSE as each simulation lands.
5. **Promote** — pick a winner. The server `promote`s its ref onto `main` (recording the decision), then
   forks a fresh commit branch and resumes it with `simulate:false` to apply the fix **for real**. Losing
   branches remain immutable, independently resumable lineage. **There is no merge.**

The **CPU** incident goal (low risk) contrasts this: it auto-remediates through the same pipeline without
opening the War Room — branching is reserved for the genuinely ambiguous, mutually-exclusive decision.

## Why "no merge" is the honest model

Loom's branching is deliberately *pick-a-winner*: two divergent `ExecutionState`s have no principled join,
so the framework doesn't fake one. That fits this problem exactly — you can apply only **one** of these
infra changes. Branching lets you *explore* many and *commit* one, and the DAG of what you rejected is a
first-class artifact (`BranchRegistry` lineage), not a lost draft.

## Capability map

| Capability | Where |
|---|---|
| **`fork()` / `BranchRegistry` / `promote()`** | `src/branching/BranchOrchestrator.ts` (the core seam) |
| `@loom/scheduler` `parallelLimit` | fan-out speculative simulations, deterministic input-ordered results |
| Durable suspend/resume (HITL) | `remediate-lag` flow gate in `src/capabilities/flows.ts` |
| Snapshots + replay VM | `fork()` seeds a snapshot at the gate; branches resume from an empty tail |
| A2A agent mesh + `agent$` | `src/agents/*`, `src/a2a/InProcessA2ABus.ts` |
| Intent → Planner → Capability | `src/orchestrator/Orchestrator.ts` |
| Projections + A2UI + Blueprint | `mission`, `telemetry`, **`branch`** surfaces |
| BYOR / BYOC (Web Components) | `BranchGraph` / `BranchDiff` / `BranchControls` in `src/dom/elements.ts` |
| SQLite durability + server/client split + SSE | `src/server/*`, `src/client/*` |

## Wire protocol (`src/wire.ts`)

- `POST /api/missions {goal}` → start (or restart) the mission.
- `GET  /api/missions/:id/stream` → **SSE**: a `snapshot` frame on connect (`serializeProjections` of the
  `mission` / `telemetry` / `branch` surfaces), then one `patch` frame per `A2UI_PATCH`.
- `POST /api/missions/:id/approve {approved}` → HITL decision for the low-risk (CPU) path.
- `POST /api/missions/:id/branches` → **fork + simulate** every candidate remediation (streams over SSE).
- `GET  /api/missions/:id/branches` → the current branch surface (refs, lineage, projected outcomes).
- `POST /api/missions/:id/promote {strategy}` → **pick a winner** and apply it for real.

## Bring your own backend

The durable stores are wired in `src/server/app.ts` (`SqliteEventStore` / `SqliteSnapshotStore` /
`SqliteBranchRegistry`, under `./.data/`). The store interfaces are async-first, so any backend drops in —
a Postgres reference (schema + `LISTEN/NOTIFY`) lives in
[`docs/examples/postgres-backend/`](../../docs/examples/postgres-backend/README.md).

## Verify

- `pnpm --filter @loom/incident-war-room demo:fork` — narrated, headless walkthrough: run to the gate, fork
  three speculative branches, simulate each, show the parent untouched, promote the winner onto `main`, and
  print the lineage. Source: `src/scripts/speculativeFork.ts`.
- `pnpm --filter @loom/incident-war-room test` — headless e2e over the durable SQLite wiring: asserts the
  gate forks into N candidate branches, each yields a distinct projected outcome, the parent stays
  suspended, `promote` moves `main` off the parent onto the real apply, lineage records every fork, and the
  metric recovers.
- Live: `pnpm ... dev`, open the app, run the replica goal, click **Explore branches**, watch the graph +
  diff populate, then **Promote** a branch.

## Out of scope (not built)

- **Server-restart resume of an in-flight mission.** The event log, snapshots, and branch refs persist to
  SQLite and flow-level `ctx.suspend`/`resume` is durable, but the `Orchestrator`'s in-memory mission model
  is not rehydrated on a full process restart.
- **Cross-process A2A.** The domain agents run in-process via `InProcessA2ABus`; exposing each as its own
  A2A HTTP service (`createA2AServer`) is the natural next step.
- **Non-linear branch history.** Branches fork from a single approval gate; forking a fork (deep DAGs) works
  at the `BranchRegistry` level but isn't surfaced in the UI.
