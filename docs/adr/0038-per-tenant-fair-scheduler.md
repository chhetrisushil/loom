# ADR 0038 — Per-Tenant Fair Scheduler (`@loom/fair-scheduler`)

- Status: Accepted (2026-07-11)
- Date: 2026-07-11
- Builds on: the ephemeral cooperative `Scheduler` (`@loom/scheduler` `createScheduler` — priority
  FIFO behind a counting semaphore), and the K12 tenant/principal model.
- Part of: the three-direction kernel arc, multi-tenant isolation (Direction C), Phase 2.

## Context

`@loom/scheduler` governs live in-flight async work: ordering by `Priority` when queued behind a
concurrency cap, plus cancellation. It is fair to **tasks** (priority + arrival) but tenant-blind —
under multi-tenancy a single busy tenant that floods a priority lane starves everyone else behind
the same cap. K3 metering caps a tenant's *resource spend*, but nothing gave it a fair *share of the
concurrency lane*.

## Decision

Add **`@loom/fair-scheduler`**: `createFairScheduler(config)` returns a `FairScheduler` that
**implements the existing `Scheduler` interface**, so it drops into any consumer unchanged. Its
`schedule` also accepts a `tenant` (and optional `weight`) via `FairScheduleOptions`.

**Policy.** Each tenant gets its own priority lane; when a slot frees, the dispatcher picks the next
non-empty lane by **weighted round-robin** (a rotation with each tenant repeated `weight` times), so
no tenant can monopolize the cap. Within a lane, ordering is by `(priority, arrival)` — identical to
the base scheduler, so a **single-tenant** workload behaves exactly as before.

**Zero-overhead fast path preserved.** With `concurrency: Infinity` (the default), there is no
gating, no queue, and no tenant bookkeeping — `schedule` reduces to awaiting the task, byte-for-byte
the base scheduler's fast path (G2). Cancellation semantics match: a task aborted while queued is
removed from its lane and never takes a slot.

## Consequences

- Multi-tenant hosts get a fairness guarantee at the concurrency layer to complement K3's spend
  caps; weights express deliberate priority tiers between tenants.
- **No ABI/event-schema change; no core change.** It is an alternative implementation of an existing
  ephemeral SPI (P10). Opt-in — nothing changes unless a consumer swaps `createScheduler` for
  `createFairScheduler` and passes tenants.
- Honest scope: like the base scheduler this is **ephemeral** — it governs live fan-out, not durable
  pause/resume (event-sourcing owns that). Fairness is over queued tasks; it does not preempt a
  running task. Starvation-freedom holds because the rotation always advances past the tenant it just
  served.

## Verification

- `@loom/fair-scheduler` tests (6): the Infinity fast path runs immediately with zero counts and
  rejects a pre-aborted task; under a cap, tenant B is served before tenant A's queue drains (no
  starvation) and the order is not the naive drain-A-then-B; a higher-weight tenant finishes first;
  within a tenant, queued tasks come out by priority; an aborted queued task is dropped without ever
  running.
- `fairScheduler.bench.ts` shows the Infinity path tracks the base `createScheduler` (statistically
  equal; absolute hz machine-relative) — the zero-overhead evidence.
- `@loom/spec` registers the `fair-scheduler` capability at L4.
