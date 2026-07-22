---
marp: true
theme: default
paginate: true
title: "Loom — Schema Migration Planner: git-style branching, generalized"
---

<!-- _paginate: false -->

# Schema Migration Planner

### Git-style branching, on a second domain — with live simulation progress

**Fork → simulate → compare → promote. Branch-only. No merge.**
The same seam as the Incident War Room, proving it's domain-agnostic.

`examples/schema-migration-planner`

<!--
Presenter: "We showed branching on incident remediation. Here's the same machinery
on a completely different decision — which schema-migration strategy to run. The
BranchOrchestrator and branch UI are reused *verbatim*; only the domain changes.
And migrations have real progress, so this one streams live backfill bars."
-->

---

## The premise

Add a `NOT NULL region` column to the **40M-row `orders` table**, under active writes.
There's more than one way — and they're **mutually exclusive**:

| strategy | lock time | duration | reversible | risk |
|---|---|---|---|---|
| online-DDL (gh-ost: shadow table + chunked copy) | 3 s | 22 min | yes | medium |
| shadow-copy (bulk copy, swap, drop old) | 8 s | 14 min | **no** | low |
| dual-write (write both, backfill, cutover flag) | 0 s | 40 min | yes | high |

No dominant option — every column trades off. So don't guess: **branch**.

---

## The loop (same five phases as the War Room)

1. **Analyze** — `IntentRuntime` → `PlannerRuntime` compose *diagnose-schema →
   assess-migration → plan-migration*. A ReAct agent inspects the table (40M rows, 48 GB, 3 indexes).
2. **Gate** — the migration flow suspends at a durable `ctx.suspend`. `main` points at it.
3. **Explore** — fork one child per strategy; resume each **in simulate mode**,
   concurrently (`parallelLimit`), **against a shadow schema**, streaming live backfill progress.
4. **Compare** — three progress bars advance at once, then a side-by-side diff.
5. **Promote** — pick a winner: `promote` its ref onto `main`, fork a commit branch, apply for real.

> The **simple** goal ("add a nullable column") auto-applies without branching — the contrast.

---

## What's reused vs. new

**Reused verbatim** from `incident-war-room` — proving the seam is domain-agnostic:

- `src/branching/BranchOrchestrator.ts` — the fork/simulate/promote lifecycle. Only the
  flow id (`execute-migration`) and resume event type (`MigrationDecision`) differ.
- The `branch` agent surface + `BranchGraph` / `BranchDiff` / `BranchControls` widgets.
- The `wire.ts` protocol, the server/client SSE plumbing, the `Orchestrator` branch lifecycle.

**New (the domain):** `warroom/strategies.ts` (strategies + outcome fields), the migration
flows, the schema-inspector / risk-assessor / migration-executor agents, the LLM provider.

---

## The differentiator: live simulation progress

The War Room's simulations were **instant**. Migrations have genuine *progress* (rows
backfilled), so each speculative branch streams it — three shadow-migrations at once:

```
online-ddl    ████████░░ 82%     ← forked from the gate, simulating
shadow-copy   ██████████ done    ← already projected: lock 8s · 14m · no-rollback
dual-write    ███░░░░░░░ 31%     ← still backfilling
```

- `progressHub` gains a numeric `reportProgress` / `onProgress` channel.
- `MigrationStep` (simulate) reports backfill % as it runs.
- `BranchOrchestrator.explore()` subscribes per fork and patches `branch.progress` →
  streams over SSE. `BranchView` gains a `progress` field; `BranchGraph` renders the bar.

---

## Copy-on-write, branch-only — why no merge

- **`fork()`** copies the parent's events `[0..S]` verbatim into the child, seeds a snapshot
  at `S`, records lineage. The parent stays suspended and independently resumable.
- **`promote(from, to)`** repoints a ref. Two divergent `ExecutionState`s have no principled
  join, so Loom doesn't fake one — you **pick a winner**, and the losers remain as lineage.

> You can apply only **one** migration. Branching lets you explore several and commit one; the
> DAG of rejected plans is the *alternatives-considered* audit trail regulated changes require.

---

## Run it

```bash
pnpm --filter @loom/schema-migration-planner dev         # client :5173 + server :8787
# → run the complex goal → "Explore branches" → watch 3 progress bars → "Promote"

pnpm --filter @loom/schema-migration-planner demo:fork   # narrated, headless, end-to-end
```

```
execute-migration → SUSPENDED @ seq 1 (awaiting MigrationDecision)
  fork spec/online-ddl  → simulate → lock 3s  dur 22m  rows 40M  reversible Y
  fork spec/shadow-copy → simulate → lock 8s  dur 14m  rows 40M  reversible N
  fork spec/dual-write  → simulate → lock 0s  dur 40m  rows 40M  reversible Y
  parent: still SUSPENDED @ seq 1, log untouched
  promote online-ddl → apply for real → main @6  (3 losers kept as lineage)
```

**Verified:** tsc + Biome clean; ~39 kB bundle; e2e asserts fork fan-out, distinct outcomes,
progress→100%, parent isolation, `main` movement, and lineage on SQLite.

---

## Takeaway

> The branching primitive isn't incident-specific. We pointed it at a completely
> different decision — a schema migration — and reused the whole seam unchanged.

- The `BranchOrchestrator` seam is **domain-agnostic**: fork/simulate/promote don't care
  whether the branches are remediations or migrations.
- Migrations added a natural **streaming** dimension — live backfill progress across three
  concurrent shadow runs — that the incident example didn't need.
- Same discipline: **pick a winner, not a merge.**

> Sibling decks: `incident-war-room-deck` (the first domain) · `architecture-deck` (the mechanics).
