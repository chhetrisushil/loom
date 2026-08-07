# @loom/replay-inspector

Read-only replay inspector. Reconstruct an execution's state at any point in its log,
see what each event did, read projection slices at that point, and do all of it under
the version the execution is **pinned** to — never the version currently deployed.

A cache of the log, never an authority. There is no write path, by type.

Implements the IX series (IX-1, IX-2, IX-3, IX-5, IX-7). See
[ADR 0071](../../docs/adr/0071-read-only-replay-inspector.md) for placement, the routed-claim
answers, and what was deliberately left out.

## Why this is a package, not a plugin

ADR 0043 puts vendor/framework **adapters** in `plugins/` and framework-agnostic
**mechanisms** in `packages/`. ADR 0068 D2 applied exactly that test to
`subscribeSelector`. An inspector over the store SPIs is generic over any backend —
in-memory, SQLite, Postgres — so it is a mechanism. If a React surface is ever built on
top, *that* is the plugin (the `renderer-react` precedent).

## Quick start

```ts
import { ReplayInspector } from "@loom/replay-inspector";

const inspector = new ReplayInspector({
  events: eventStore,        // read replica; scope it before it gets here
  snapshots: snapshotStore,  // optional — bounds reconstruction cost
});

// IX-2 — state at a point
const { state, pin } = await inspector.stateAt("exec-1", 42);
console.log(describePin(pin));           // "orders@2.1.0 [flowHash fnv1a:9f196b42]"

// IX-2 — a whole timeline in ONE pass (one snapshot load, one bounded read)
const rows = await inspector.timeline("exec-1", [0, 10, 20, 30, 40]);

// IX-3 — what the event at sequence 42 actually did
const t = await inspector.transitionAt("exec-1", 42);
t.delta.changes;      // structural diff of ExecutionState
t.frames;             // the step frames this event moved
t.projections;        // every configured projection's slice at that point
```

## The four hard behaviours

### 1. It never falls back to current code

`pinOf` reads `variables._flowHash`, folded from `EXECUTION_STARTED` by the kernel.
Three outcomes, all explicit:

| Status | Meaning |
|---|---|
| `pinned` | The execution names the code it started under. |
| `unpinned-legacy` | Pre-`EVENT_SCHEMA` 1.4.0 log — `flowHash` was never recorded. Not an error. |
| projection `unavailable` | The pinned fold body is not retrievable. **No** current-version fallback. |

> **A finding worth knowing.** `ExecutionState.workflowVersion` is *not* durable. No event
> handler writes it; `WorkflowRuntime.foldState` seeds it from the **currently registered**
> flow (`WorkflowRuntime.ts:857-861`). So under skew the kernel reports the deployed
> version for an old execution. The inspector reports `""` ("not recorded") unless a
> snapshot carries it — matching the kernel there would be the exact IX-5 violation this
> requirement exists to prevent. `flowHash` is the durable pin; use it.

### 2. Reconstruction is snapshot-anchored and batch-folded

```
anchor = snapshots.loadLatestBefore(id, firstPosition)
events = events.readRange(id, anchor + 1, lastPosition)
states = one foldEvents call per requested position
```

Two store round-trips per call regardless of how many positions you ask for.

Batching is load-bearing, not a micro-optimisation. `ReplayVM.applyEvent` is
`foldEvents([event], state)`, and `foldEvents` calls `resetFoldOwnership()` at its head,
so one-event-per-call never takes `appendAudit`'s in-place branch and re-copies every
audit list at every step — **O(n²)** in audit-list length. Folding a whole segment per
call keeps ownership and makes it linear. Use `timeline()`, not a loop over `stateAt()`.

### 3. The diff survives hostile state

`ExecutionState.variables` is arbitrary folded data. `diffState` is iterative (never
recursion, so deep nesting cannot blow the stack), cycle-safe (visited **pairs** are
memoised, which collapses cycles and shared subgraphs alike), and bounded on both depth
and output size — with truncation **reported**, never silent. Output is a flat array of
`{ path, kind }`, so no user-controlled string is ever used as a write key.

### 4. It cannot perturb what it inspects

`ReadOnlyEventStore` is `Pick<EventStore, "read" | "readFrom" | "readRange">`.
`append`, `acquireFence` and `copyPrefix` are out of scope; `save` and `deleteExecution`
are out of scope on the snapshot side. `subscribe` is excluded too — it is read-shaped,
but a live subscription is a retained listener and load on the writer's backend. The
inspector never tails.

This replaces the original acceptance criterion ("the dependency graph contains no write
method"), which is not a checkable property: a dependency graph is over modules, not
methods, and `EventStore` carries `append` on the same interface as `read`.

## Redaction

Defence in depth, not the access boundary — scope the store with
`TenantScopedEventStore` before handing it over.

```ts
import { pathsOfClass } from "@loom/classify";

new ReplayInspector({
  events,
  redactPaths: pathsOfClass(flowInputSchema, "sensitive").map((p) => `variables._input.${p}`),
});
```

Masking is applied **before** the diff, so a redacted value cannot leak through a
change record's `before`/`after`. Two states differing only inside a masked path
therefore compare equal — the inspector must not reveal that a secret changed.

## Memory

The instance holds configuration only. No memo, no cache, no listener, no timer. Fold
states, diff work stacks and projection buckets are per-call and released on return, so
a long-lived inspector cannot accumulate. Loaded projection chunks rely on the module
system's own cache rather than a second one here — a cache keyed by projection × flow
hash would be an unbounded retention surface for no gain.

## Bounds

`maxEvents` (default 1,000,000) makes an over-wide reconstruction **throw**
`InspectorBudgetError` rather than return a short read. A silently truncated fold
produces a plausible-looking wrong state, which is the failure this whole series exists
to avoid.

## Not here, deliberately

| | Why |
|---|---|
| Branch-from-event | Fork semantics — divergence identity, fencing, what a branch's pin means. Separate design. `BranchRegistry` existing is not a reason to fold it in. |
| Editing state and re-running | Breaks the read-only boundary at the root. |
| Live tailing | Different tool, different isolation properties. Would put non-perturbation under real pressure for a capability nobody has asked for. |
| Subscription timeline (IX-4) | Depended on a withdrawn kernel series. Nothing to show. |
| Rotation-transparent timeline (IX-6) | Depends on `rotate$`, deferred behind ADR 0052's evidence gate. |
| Surfacing fold-skipped events (IX-8) | Separately demand-gated and not yet demanded. The fold's silent skip is load-bearing for mixed-fleet tolerance and is **not** changed here. |
