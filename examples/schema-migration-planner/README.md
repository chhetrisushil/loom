# Schema Migration Planner — git-style branching on Loom

An engineer needs to add a `NOT NULL region` column to the **40M-row `orders` table** under active writes.
There is more than one defensible way to do it, and the options are **mutually exclusive** — you run one
migration, not half an online-DDL and half a dual-write. So at the approval gate, instead of a blind
approve/reject, the engineer **branches**: fork the suspended execution once per candidate strategy,
**simulate** each against a shadow schema (watching live backfill progress), **compare** the projected
lock time / duration / reversibility / risk, and **promote** the winner — which then applies for real.
Rejected plans survive as immutable lineage: the *alternatives-considered* audit trail.

This is the **second** example of Loom's git-style branching (`fork → simulate → compare → promote`,
branch-only, **no merge**) — a sibling to [`incident-war-room`](../incident-war-room/README.md). It proves
the branching pattern is domain-agnostic: the entire `BranchOrchestrator` seam and branch UI are reused
verbatim; only the *domain* (strategies, agents, projected outcomes) changes. It also adds **live
per-branch simulation progress** — three shadow-migrations backfilling concurrently — which the incident
example (instant simulations) didn't exercise.

```
pnpm --filter @loom/schema-migration-planner dev     # client :5173  +  server :8787
# then open http://localhost:5173
```

Fully offline (deterministic `DemoLlmProvider`). `dev` runs both processes; or run
`dev:server` (Node runtime, :8787) and `dev:client` (Vite, proxies `/api`) separately.

## The loop

1. **Analyze** — state the goal ("add a NOT NULL region column to the 40M-row orders table"). `IntentRuntime`
   routes it; `PlannerRuntime` composes *diagnose-schema → assess-migration → plan-migration*. The Schema
   Inspector agent runs a real ReAct loop over an `inspect-table` tool (40M rows, 48 GB, 3 indexes, ~1200 writes/s).
2. **Gate** — the mutating migration flow suspends at a durable `ctx.suspend`. `main` points at it. The UI
   jumps to the **Migration Board** tab.
3. **Explore** — the server forks one child per strategy (*online-ddl*, *shadow-copy*, *dual-write*) and
   resumes each **in `simulate` mode**, concurrently (`@loom/scheduler` `parallelLimit`). Each runs against a
   **shadow schema**, **streaming live backfill progress**, and finishes with a projected outcome. The parent
   log is never touched (copy-on-write).
4. **Compare** — three progress bars advance at once, then a side-by-side diff. No dominant option:

   | strategy | lock time | duration | rows | reversible | risk |
   |---|---|---|---|---|---|
   | online-ddl | 3 s | 22 min | 40M | yes | medium |
   | shadow-copy | 8 s | 14 min | 40M | **no** | low |
   | dual-write | 0 s | 40 min | 40M | yes | high |

5. **Promote** — pick a winner → `promote(branch, "main")`, fork a commit branch, resume `simulate:false` to
   apply for real. Losing plans remain immutable lineage. **There is no merge.**

A contrasting **simple goal** ("add a nullable notes column; apply automatically if low risk") is
metadata-only and **auto-applies without branching**.

## Why "no merge" is the honest model

You can apply only **one** of these migrations. Branching lets you *explore* several and *commit* one; the
DAG of what you rejected is a first-class artifact (`BranchRegistry` lineage), not a lost draft. Two
divergent `ExecutionState`s have no principled join, so `promote()` is a pointer move — the entire "merge"
replacement. (See `docs/architecture.md` → "Why branching, not merge/rebase?")

## What's reused vs. new (sibling of incident-war-room)

**Reused verbatim** (domain-agnostic): `src/branching/BranchOrchestrator.ts` (the fork/simulate/promote
seam — only the flow id and resume event type differ), the `branch` A2UI surface + `BranchGraph` /
`BranchDiff` / `BranchControls` Web Components, `src/wire.ts`, the server/client SSE plumbing, and the
`Orchestrator`'s branch-lifecycle structure.

**New / retargeted** (the domain): `src/warroom/strategies.ts` (migration strategies + outcome fields),
`src/capabilities/flows.ts` (`MigrationExecutionFlow` with the streaming `MigrationStep`), the
schema-inspector / risk-assessor / migration-executor agents + mock tools, the catalog, and the
`DemoLlmProvider`. The **live progress** differentiator adds a `progress` field to `BranchView`, a numeric
`reportProgress`/`onProgress` channel on `progressHub`, and a per-branch progress bar in `BranchGraph`.

## Wire protocol (`src/wire.ts`)

- `POST /api/missions {goal}` → start (or restart) the mission.
- `GET  /api/missions/:id/stream` → **SSE**: a `snapshot` on connect, then one `patch` per `A2UI_PATCH`
  (including the live progress patches).
- `POST /api/missions/:id/branches` → **fork + simulate** every candidate strategy.
- `GET  /api/missions/:id/branches` → the current branch surface.
- `POST /api/missions/:id/promote {strategy}` → **pick a winner** and apply it for real.

## Verify

- `pnpm --filter @loom/schema-migration-planner demo:fork` — narrated headless fork → simulate → compare →
  promote (source: `src/scripts/speculativeFork.ts`).
- `pnpm --filter @loom/schema-migration-planner test` — headless e2e over SQLite: the gate forks into N
  strategy branches, each yields a **distinct** projected outcome with **progress reaching 100%**, the parent
  stays suspended, `promote` moves `main` off the parent onto the real apply, lineage records every fork, and
  the simple goal auto-applies without branching.
- Live: `pnpm ... dev`, run the complex goal, click **Explore branches**, watch three progress bars advance,
  then **Promote** a strategy.

## Out of scope (not built)

- **Server-restart resume of an in-flight mission** (the event log, snapshots, and branch refs persist, but
  the `Orchestrator`'s in-memory model is not rehydrated on a full restart).
- **Cross-process A2A** (the agents run in-process via `InProcessA2ABus`).
- **Real DDL** — migrations are mocked deterministically; `projectOutcome` stands in for a gh-ost `--dry-run`
  or a shadow apply.
