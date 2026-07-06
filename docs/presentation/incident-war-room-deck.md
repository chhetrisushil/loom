---
marp: true
theme: default
paginate: true
title: "Loom — Incident War Room: git-style branching"
---

<!-- _paginate: false -->

# Incident War Room

### Git-style branching for durable executions — made a live experience

**Fork → simulate → compare → promote. Branch-only. No merge.**
Loom's most distinctive capability, on a real incident.

`examples/incident-war-room`

<!--
Presenter: "Every other example shows durable execution moving *forward*. This one
shows it branching *sideways*. When a decision is genuinely ambiguous and the
options are mutually exclusive, you want to explore several futures and commit
one — that's git's branch-and-pick-a-winner principle, applied to agent runs."
-->

---

## The premise

A production incident: **read-replica lag** spiking on `orders-db`. The team has
more than one defensible fix — and they are **mutually exclusive**:

| Strategy | Lag after | ETA | Downtime | Cost | Risk |
|---|---|---|---|---|---|
| Scale read replicas | ~180 ms | 4 min | 0 s | +$12/hr | medium |
| Fail over the primary | ~20 ms | 9 min | ~12 s | $0 | high |
| Throttle writes | ~600 ms | 1 min | 0 s | $0 | low |

You can't do two of these. So don't force a blind approve/reject — **branch**.

---

## The loop

1. **Detect** — `IntentRuntime` routes the goal; `PlannerRuntime` composes
   *diagnose → assess → remediate* over the A2A agent mesh (reused verbatim).
2. **Gate** — the mutating remediation suspends at a durable `ctx.suspend`. `main`
   points at it. The UI jumps to the **War Room** tab.
3. **Explore** — fork one child per strategy; resume each **in simulate mode**,
   concurrently (`@loom/scheduler` `parallelLimit`). Each previews a projected
   outcome **without touching real infra**. Parent log untouched (copy-on-write).
4. **Compare** — a git-graph + side-by-side diff fill in live over SSE.
5. **Promote** — pick a winner: `promote` its ref onto `main`, fork a commit
   branch, resume `simulate:false` to apply **for real**. Losers kept as lineage.

> The low-risk **CPU** goal auto-remediates without branching — the contrast is the point.

---

## What makes the gate forkable

The remediation flow suspends on a **strategy-less** decision. The *resume payload*
names which branch this execution is exploring:

```ts
// src/capabilities/flows.ts — one gate, N possible futures
const decision = await ctx.suspend({ on: "RemediationDecision", correlationKey: target });
//  decision = { approved, strategy, simulate, approvedBy }
if (!decision.approved) return { applied: false, … };
return ctx.run(RemediateStep, { target, strategy: decision.strategy, simulate: decision.simulate });
```

Fork the suspended gate N times, resume each child with a **different**
`RemediationDecision`, and every branch computes its own outcome from the
**identical** pre-gate prefix. `simulate:true` projects; `simulate:false` applies.

---

## The seam (`src/branching/BranchOrchestrator.ts`)

```ts
// explore(): fork + dry-run every candidate, concurrently, in input order
const outcomes = await parallelLimit(STRATEGIES.map((s) => async () => {
  const fork = await runtime.fork(parent, forkPoint, { branchName: `spec/${s.id}` });
  const done = await (await runtime.resume(fork.executionId, {
    eventType: "RemediationDecision",
    payload: { approved: true, strategy: s.id, simulate: true, approvedBy: "explorer" },
  })).waitForCompletion();
  return done.variables._output;                       // projected StrategyOutcome
}), { limit: STRATEGIES.length });

// promote(): pick a winner — a pointer move, then a real, durable apply
await branchRegistry.promote(`spec/${winner}`, "main");           // records the decision
const commit = await runtime.fork(parent, forkPoint, { branchName: "commit" });
await runtime.resume(commit.executionId, { …, payload: { …, simulate: false } });
await branchRegistry.promote("commit", "main");                    // main = the real apply
```

`parallelLimit` preserves **input order** in the result array → the branch list is deterministic for replay.

---

## Copy-on-write, branch-only — why no merge

- **`fork()`** copies the parent's events `[0..S]` verbatim into the child (only
  `id`/`executionId` change), seeds a snapshot at `S`, and records lineage. The
  parent log is **never touched** — it stays suspended and independently resumable.
- **`promote(from, to)`** repoints a ref. That is the *entire* "merge" replacement:
  two divergent `ExecutionState`s have no principled join, so Loom doesn't fake one.

> The agentic pattern isn't "merge divergent branches," it's "**pick the winning
> branch**." The losers remain immutable lineage — the *alternatives-considered* audit
> trail regulated changes require. (See `architecture.org` → "Why branching, not merge/rebase?")

---

## What runs where

| | Server (Node) | Client (browser) |
|---|---|---|
| Stores | `SqliteEventStore` + `SqliteSnapshotStore` + **`SqliteBranchRegistry`** (`./.data/`) | — |
| Runtime | `WorkflowRuntime.fork/resume/promote`, `BranchOrchestrator`, A2A bus, 3 agents | — |
| Surfaces | authoritative `mission` / `telemetry` / **`branch`** | a mirror `InMemoryProjectionRuntime` |
| UI | — | `BranchGraph` + `BranchDiff` + `BranchControls` Custom Elements (BYOC) |

New routes: `POST /branches` (fork + simulate) · `GET /branches` · `POST /promote` `{strategy}`.
Everything else — agents, planner, intent, durable flows, render layer — is **reused**.

> The branch widgets bind to the **whole** `branch` surface (`DataBinding` with an empty `path`) — one widget renders `phase`, `branches`, and `refs` together, not a single field.

---

## Run it

```bash
pnpm --filter @loom/incident-war-room dev         # client :5173 + durable server :8787
# → run the replica goal → "Explore branches" → watch the graph + diff → "Promote"

pnpm --filter @loom/incident-war-room demo:fork   # narrated, headless, end-to-end
```

```
remediate-lag task → SUSPENDED @ seq 1 (awaiting RemediationDecision)
  fork spec/scale-replicas   → simulate → lag→180ms  eta 4m  downtime 0s  $12/hr
  fork spec/failover-primary → simulate → lag→ 20ms  eta 9m  downtime 12s $0/hr
  fork spec/throttle-writes  → simulate → lag→600ms  eta 1m  downtime 0s  $0/hr
  parent: still SUSPENDED @ seq 1, log untouched
  promote scale-replicas → apply for real → main @6  (3 losers kept as lineage)
```

**Verified:** tsc + Biome clean; client bundle ~39 kB; headless e2e asserts the fork fan-out,
distinct projected outcomes, parent isolation, `main` movement, and lineage on SQLite.

---

## Takeaway

> Same agents. Same durable suspend/resume. We let the execution branch **sideways**
> at a decision — explore three futures, commit one — and got an audit trail for free.

- Branching is **nearly zero-cost** on Loom: an immutable log + deterministic replay
  mean a fork is a copy-on-write prefix plus a movable ref.
- `parallelLimit` makes the speculative fan-out **concurrent and deterministic** — the
  first example to exercise `@loom/scheduler`.
- The honest model for mutually-exclusive choices is **pick-a-winner, not merge**.

> Sibling decks: `db-command-center-server` (same topology) · `architecture-deck` (the branching mechanics).
