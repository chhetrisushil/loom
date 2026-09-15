# Durable Leases: who owns this execution

**Status:** Plan — L1 starting
**Date:** 2026-09-15
**Kernel baseline:** EVENT_SCHEMA 1.18.0, KERNEL_ABI 1.1.0, EventStore SPI 1.4.0, BranchRegistry SPI 1.2.0
**Tracks:** [#380](https://github.com/chhetrisushil/loom/issues/380)

---

## 0. Why now — the second consumer arrived

#380 deferred this with an unusually precise condition: *"The likely second consumer is 'only one
node should run this execution.' Today fencing (K9.4) makes a double dispatch safe — the loser's
write is rejected — but both still run and both still pay for their effects."*

That is now demonstrable rather than anticipated:

- **`TimerStore.due()` has no claim** (`event-runtime/src/timers.ts:24`). Two nodes polling the same
  store both receive the same due timer, both resume, and both pay for every effect up to the
  point one loses at the fence. `TimerService`'s `fenced` option exists *because the runtime
  already knows this happens* — it makes the outcome safe, not cheap.
- **Placement made the duplicate expensive on purpose.** With #392 a wake dispatches to the lane
  the execution was placed on, and a branch is placed precisely when its work is heavy — a shadow
  migration that clones a table. A duplicated wake now buys that twice.
- **The original consumer is unchanged**: `recoverAbandoned` requires a caller predicate because
  the log cannot distinguish an orphan from a healthy execution on another node.

One primitive answers all three, which is the test the deferral set: *ownership with an expiry*.

---

## 1. What is true today, verified

| Claim | Evidence |
| --- | --- |
| No durable ownership exists | `WorkerLease` is `{ leaseId }` — a compute-allocation handle, not a record of who owns an execution |
| Detection lives in process memory | `LocalDispatcher`'s `inFlight` + an awaited deadline; kill that process and nothing survives that knows a run was in flight |
| The log cannot answer it | a `running` execution owned by a healthy node is byte-identical to an orphaned one — the difference is a fact about the cluster |
| So recovery needs a predicate | `recoverAbandoned`'s `isAbandoned` is required with no default, deliberately |
| Fencing bounds the damage, not the cost | K9.4 rejects the loser's write; both runs still executed their effects |

---

## 2. Design

### D2.1 — `LeaseStore`, mirroring `TimerStore`

```ts
interface Lease { executionId: string; owner: string; expiresAt: number; }
interface LeaseStore {
  acquire(executionId: string, owner: string, ttlMs: number, now?: number): Promise<Lease | null>;
  renew(executionId: string, owner: string, ttlMs: number, now?: number): Promise<boolean>;
  expired(now: number, limit?: number): Promise<Lease[]>;
  release(executionId: string, owner: string): Promise<void>;
  close(): Promise<void>;
}
```

`acquire` returns `null` when someone else holds an unexpired lease — that single return is the
mutual exclusion the second consumer wants. `renew` returns `false` once ownership is lost, so a
node that was declared dead stops believing it is alive. Optional throughout: unwired, every path
behaves byte-identically (G2).

### D2.2 — The lease is about *running*, not *existing*

A suspended execution is parked, not owned: nothing is running it, and nothing should hold a lease
on it. Leases cover `running`/`pending` only. This keeps `expired()` meaning exactly one thing —
*someone was running this and stopped saying so* — rather than doubling as a parking registry.

### D2.3 — The honest hazard: renewal versus a blocked loop

Renewal is a ticker on the owning process's event loop. A CPU-bound effect blocks it, so a healthy
execution can miss renewals and be declared abandoned — the false positive that makes a recovery
system worse than none.

Mitigations, in order of preference: a TTL generously larger than the renewal interval (10s renew,
60s TTL); renewal *before* an effect rather than only after; and fencing as the backstop it already
is — if a false orphan is recovered, the original loses at the store rather than corrupting the log.
**This must be stated in the docs, not just handled**: a lease makes recovery automatic, and
automatic recovery of a live execution is the way this feature fails.

### D2.4 — What it unlocks, in the callers

- `recoverAbandoned`: `isAbandoned` becomes **optional** — an expired lease is the default answer.
  Required still, when no lease store is wired; the predicate never becomes a lie.
- `TimerService.fire`: acquire before firing; skip when another node holds it. Duplicate fires stop
  costing twice instead of merely stopping at the fence.

---

## 3. Stages

| | Scope | Why separable |
| --- | --- | --- |
| **L1** | `LeaseStore` SPI + in-memory + conformance kit | the contract, provable before anything depends on it |
| **L2** | `TimerService` acquires before firing | the cheapest real consumer; no runtime changes |
| **L3** | `recoverAbandoned` defaults `isAbandoned` to "lease expired" | closes #380's stated ask |
| **L4** | SQLite + Postgres backends | the kit already defines correct; verified against a real PG |
| **L5** | Runtime acquire/renew/release around a run | the biggest, and the one D2.3 is about |

L1–L4 are useful without L5: leases can be held by whatever drives executions (a dispatcher, a
worker) before the runtime itself learns to hold one.

---

## 4. Not doing

- **A lease as the fence.** They answer different questions — fencing is monotonic write-ordering at
  the store, a lease is time-bounded ownership — and collapsing them would make a slow renewal into
  a correctness bug instead of a duplicate-work bug.
- **Lease-based scheduling** (work stealing, rebalancing). Ownership first; policy later, if ever.
- **A parking registry.** See D2.2.
