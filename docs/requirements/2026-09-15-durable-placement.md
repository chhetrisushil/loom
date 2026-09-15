# Durable Placement: a wake that knows where the execution belongs

**Status:** SHIPPED (P1–P4) — the loom half. The acceptance test in loom-examples flips next.
**Date:** 2026-09-15
**Kernel baseline:** EVENT_SCHEMA 1.18.0, KERNEL_ABI 1.1.0, EventStore SPI 1.4.0, ADRs 0001–0095
**Tracks:** [#392](https://github.com/chhetrisushil/loom/issues/392)
**Acceptance test already written:** `loom-examples/examples/schema-migration-planner/test/compute.test.ts`
— the case named `KNOWN GAP (loom#392)` asserts today's wrong behaviour and must flip.

---

## 0. Placement verdict

| Layer | What lands there |
| --- | --- |
| **Kernel** | nothing. No syscall, and **EVENT_SCHEMA untouched** — the hint rides in the anchor event's `metadata`, where `fence` already lives |
| **1P — `workflow-runtime`** | the wake paths gain a dispatch seam: `TimerService` and `recoverAbandoned` can re-drive through an `ExecutionDispatcher` instead of resuming in-process |
| **1P — `dispatcher`** | `PlacementPolicy` gains the durable hint as an input; an unregistered target still falls back |
| **Application** | the policy itself — which lane a workload belongs in |
| **Rejected** | a placement *registry* (a second source of truth); a hard pin that strands an execution when a target retires |

---

## 1. What is true today, verified

| Claim | Evidence |
| --- | --- |
| Placement is **never persisted** | `ExecutionPolicy` (`core/src/types/execution.ts:127`) is a caller-side struct mapped to `DispatchMetadata` at dispatch time (`dispatcher/src/placement.ts:8`). `RunOptions` has no placement field; nothing writes one to the log |
| The wake paths **do not dispatch at all** | `TimerService.fire` → `this.runtime.resume(...)`; `recoverAbandoned` → `runtime.resume(...)`. Nothing in the repo builds a resume `ExecutionPackage` except an application |
| A branch **can** run anywhere | `ExecutionPackage` is identity + resume coordinates, never code or state (`worker-runtime/src/types.ts:16`); proven end to end by `schema-migration-planner`'s branch worker |
| Sequence 0 is already **the metadata anchor** | `WorkflowRuntime.foldState` calls it exactly that; `truncatePrefix` preserves it explicitly through compaction; `metadata.fence` (K9.4) already rides there |
| An unknown target already **falls back** | `defaultPlacementPolicy` returns the dispatcher's default when `meta.target` names nothing registered (`dispatcher/src/placement.ts:21`) |

---

## 2. The two defects, in order

**D1 — the wake paths bypass the placement seam entirely.** Even with a perfect record of where an
execution belongs, `TimerService` would ignore it: it holds one runtime and resumes on it. This is
the load-bearing defect, and it is first because nothing else matters until a wake can *express* a
placement decision.

**D2 — nothing durable says where the execution belongs.** Placement lives in the memory of the
process that dispatched. For a short execution that is invisible; for one that suspends for a human
it is gone by the time anything wakes it.

Neither is visible at the timescale the examples ran at, which is why both survived until a branch
was given its own compute.

---

## 3. Design

### D3.1 — Where the hint lives: the anchor event's metadata

`EXECUTION_STARTED` (sequence 0) already *is* the execution's metadata anchor: compaction preserves
it, deletion removes it, and `metadata.fence` established that operational, non-semantic data belongs
there. Placement is the same kind of thing.

- **No EVENT_SCHEMA change.** `EventEnvelope.metadata` is free-form; the fence precedent covers it.
- **One indexed point-read to recover it** — `readRange(id, 0, 0)`, which several paths already do.
- **Fork inheritance is free.** `fork()` copies the prefix verbatim and merges into `metadata`, so a
  child's anchor already carries the parent's placement. An override is an explicit merge at fork time.
- **Re-placement is a new fact**, not a mutation: append a placement event (userspace, app-owned) or
  re-place at dispatch. Auditable by construction.

Rejected alternative — a placement *registry* keyed by executionId: a second source of truth beside
the log, needing an SPI, three backends, a conformance kit, and a sync story, to hold one string that
the log can already carry.

Rejected alternative — derive it and store nothing: a pure `PlacementPolicy` over the package cannot
know that *this* branch cloned a 40M-row table. Derivation is the right default; it is not sufficient.

### D3.2 — A hint that survives, not a pin

The recorded target is **advisory input to the policy**, never a binding. Targets get renamed and
retired, and an execution pinned to a dead one would be stranded — the exact failure this plan exists
to prevent, arrived at from the other side. `defaultPlacementPolicy` already falls back; a fallback
that *changes* the placement of a suspended execution should warn, in the shape shipped for dropped
deadlines (a diagnostic at the point the information exists).

### D3.3 — Who reads it

| Path | Today | After |
| --- | --- | --- |
| `TimerService.fire` | `runtime.resume` | dispatch when a dispatcher is wired, else unchanged |
| `recoverAbandoned` | `runtime.resume` | same |
| `SupervisingDispatcher` | redispatches its own package | unchanged (it still holds the package) |
| An app-driven resume | app supplies `meta.target` | may read the hint instead of remembering it |

Every one keeps its current behaviour byte-identically when no dispatcher is wired (G2).

---

## 4. Work items

### P1 — a dispatch seam on the wake paths *(1P, `workflow-runtime`)*

`TimerService` and `recoverAbandoned` take an optional `ExecutionDispatcher`. Present ⇒ they build an
`ExecutionPackage` and dispatch; absent ⇒ today's in-process resume, unchanged.

*Acceptance:* a timer fires a branch placed on a worker and the **worker's** runtime advances it —
`compute.test.ts`'s pinned gap flips. A second test asserts the unwired path is untouched.

### P2 — record the placement hint at start *(1P, `workflow-runtime`)*

`RunOptions.policy?: ExecutionPolicy` (or just `computeTarget`), stamped into the anchor event's
`metadata`. `EXECUTION_STARTED` payload untouched; EVENT_SCHEMA untouched.

*Acceptance:* start with a target, read it back from sequence 0, and fold state without it appearing
in `ExecutionState` — descriptive, never replay input.

### P3 — the hint reaches the policy *(1P, `dispatcher`)*

`DispatchMetadata.target` is populated from the recorded hint when the caller supplies none. An
unregistered target falls back **and warns**.

### P4 — fork override *(1P, `workflow-runtime`)*

`fork(parent, at, { computeTarget })` merges a new placement into the child's copied anchor. Inheritance
needs no work — it is what the prefix copy already does. Pair with the branch-cohort work so a
simulation can be placed differently from the execution it forked from.

---

## 5. Not doing

- **A placement registry.** §3.1.
- **A hard pin.** §3.2 — it converts a retired target into a stranded execution.
- **Kernel-side scheduling decisions.** The kernel records a hint and hands it to a policy; *which*
  lane a workload belongs in stays the application's call (P10).
- **Cross-node placement negotiation.** Out of scope: this plan makes a wake respect a decision that
  was already made, not make a better one.

## 6. Open questions — answered while implementing

- **Whole `ExecutionPolicy` or just `computeTarget`?** Just `computeTarget`. The rest would
  have ridden along for free, and "free" is how surface grows; nothing needed them.
- **`TimerService` settle semantics under dispatch.** Unchanged in shape: the dispatch is
  awaited, which is the same "the wake durably took effect" the in-process branch waits for,
  and a failure still leaves the timer for the next poll (at-least-once).
- **Does `recoverAbandoned` want the recorded placement or a fresh decision?** Both, and the
  hint-not-pin rule resolves it: the recorded lane is handed to the policy, which decides. A
  node recovering an orphan is often doing so *because* the original lane went away, and an
  unregistered target falls back rather than stranding it — now audibly.

## 7. Original open questions

- Should the hint be the whole `ExecutionPolicy` (priority, resources, affinity) or only
  `computeTarget`? The rest is already advisory and would ride along for free — but "free" is how
  surface grows.
- `TimerService` currently awaits settle after a wake. Dispatching to a remote worker keeps that
  (the result is awaited) but changes the failure mode from "the resume threw" to "the dispatch
  failed" — does the timer retire, or retry, and is that already the at-least-once story?
- Does `recoverAbandoned` want the *recorded* placement or a *fresh* decision? A node recovering an
  abandoned execution may be recovering it precisely because its original target is gone.
