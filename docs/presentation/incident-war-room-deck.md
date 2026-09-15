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
2. **Gate** — the remediation suspends at a durable `ctx.suspend`; `main` points at it.
3. **Explore** — fork one child per strategy, resume each **in simulate mode**,
   concurrently (`parallelLimit`). Parent log untouched.
4. **Review** — each branch **parks on its own gate** for that strategy's owner.
   `explore()` returns with all three still suspended.
5. **Promote** — the first branch cleared wins: move `main`, apply for real, and
   **retract** whatever is still parked so no late review resumes a loser.

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
// explore(): fork + start every candidate. Returns while they are ALL suspended.
await parallelLimit(STRATEGIES.map((s) => async () => {
  const fork = await runtime.fork(parent, forkPoint, { branchName: `spec/${s.id}` });
  const resumed = await runtime.resume(fork.executionId, { eventType: "RemediationDecision",
    payload: { approved: true, strategy: s.id, simulate: true, approvedBy: "explorer" } });
  await resumed.waitForSuspend();          // ← NOT waitForCompletion: it parks for a human
}), { limit: STRATEGIES.length });

// review(): one owner answers one branch — arrivals are independent, order is theirs
await runtime.resume(branch.executionId, { eventType: "SimulationReviewed",
  payload: { branchExecutionId: branch.executionId, approved: true, reviewer } });

// promote(): a pointer move, a real apply — and retract whatever is still parked
await branchRegistry.promote(`spec/${winner}`, "main");
for (const other of stillParked) await runtime.cancel(other.executionId, "superseded");
```

> `waitForCompletion()` here would hang **forever**: the suspend path never resolves it.

---
## Copy-on-write, branch-only — why no merge

- **`fork()`** copies the parent's events `[0..S]` verbatim into the child (only
  `id`/`executionId` change), seeds a snapshot at `S`, and records lineage. The
  parent log is **never touched** — it stays suspended and independently resumable.
- **`promote(from, to)`** repoints a ref. That is the *entire* "merge" replacement:
  two divergent `ExecutionState`s have no principled join, so Loom doesn't fake one.

> The agentic pattern isn't "merge divergent branches," it's "**pick the winning
> branch**." The losers remain immutable lineage — the *alternatives-considered* audit
> trail regulated changes require. (See `architecture.md` → "Why branching, not merge/rebase?")

---

## What runs where

| | Server (Node) | Client (browser) |
|---|---|---|
| Stores | Sqlite event + snapshot + **branch registry** + **timers** | — |
| Runtime | `fork` / `resume` / `cancel` / `promote`, `BranchOrchestrator`, A2A bus | — |
| Surfaces | authoritative `mission` / `telemetry` / **`branch`** | mirror projection runtime |
| UI | — | `BranchGraph` · `BranchDiff` · `BranchControls` (BYOC) |

Routes: `POST /branches` · `/review` `{strategy, approved}` · `/promote` `{strategy}`. Everything else — agents, planner, intent, render layer — is **reused**.

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
- A branch can **wait on its own human** — three branches, three reviewers, three
  clocks. The orchestrator is driven by arrivals, never by awaiting a cohort.
- An approval must **name its branch**: a sibling's sign-off parses identically at
  the same gate, so the address rides in the payload and the gate requires it.
- Promotion **retracts** the losers. A pointer move alone leaves their asks live.

> Sibling decks: `db-command-center-server` (same topology) · `architecture-deck` (the branching mechanics).
