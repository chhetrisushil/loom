# ADR 0151 — `EffectContext.flush()`, `readResources()` and `reserveEffectDimensions()`: middleware can make its own events durable before the effect runs, read the live totals, and keep its accounting dimensions out of flow code's reach

- Status: **Proposed**
- Date: 2026-11-23
- Builds on: [ADR 0150](0150-task-scoped-authority.md) (D4 counts side-effect attempts, so the count must be
  durable before the attempt), K9.3 (the `idempotent: false` pre-dispatch drain of `STEP_STARTED`), K3
  (`RESOURCE_METERED` and custom dimensions), [ADR 0102](0102-flow-emits-append-once.md) (in-flight accounting of emits), [ADR 0115](0115-open-vocabularies.md),
  and the userspace-emit guard (`guardUserspaceEmit`).
- Found by: ADR 0150 slice 1, task T6. The lease middleware's investigation found the crash window below.
  The owner chose a kernel seam over a documented gap (2026-11-23).
- Gate: second consumer: (1) `@loomwork/task-authority`'s lease middleware (ADR 0150 D4); (2) `@loomwork/middleware`
  metering. K3 budgets meter AFTER the effect through the same write-behind journal, and the K8 abort path
  already shows that "metered before the effect can escape it" matters there. Any accounting middleware that must
  never under-count a side effect it allowed is the general case.
- Placement verdict: **kernel (two optional fields on `EffectContext`, `flush` and `readResources`, wired in `WorkflowContext`)**. Durability of the
  journal is the kernel's alone: no seam outside it can await the write-behind tail.
- Version/compat impact: `EffectContext` gains an OPTIONAL `flush?: () => Promise<void>` and `readResources?: () => ResourceSnapshot` (additive; middleware and
  effects that do not call it are byte-identical). No new event, no EVENT_SCHEMA or KERNEL_ABI change. The kernel
  budget for `packages/workflow-runtime/src/WorkflowContext.ts` grows by the wiring (`LOOM_KERNEL_BUDGET_ADR=0151`).

## Context

`EffectContext.emit` commits synchronously into the fold, but the durable write is **write-behind**: the journal
enqueues it on a serial tail (`ExecutionJournal.enqueue`). Nothing drains between an emit made by middleware and the
effect body that middleware then calls. Only `STEP_STARTED` of an `idempotent: false` tool is drained before dispatch
(K9.3), and that drain happens before the middleware chain runs.

So a middleware that emits `RESOURCE_METERED` and then calls `next()` can have this happen:

1. the meter is folded and enqueued, not yet stored;
2. the effect performs its side effect;
3. the process crashes before the meter write lands.

On recovery the step either re-runs, so the first side effect was never counted, or, for an `idempotent: false` tool
whose in-doubt step an operator resolves as `completed-with-result`, is adopted without re-running. In that case a
side effect happened and was never counted at all. ADR 0150 D4 promises to count attempts, not successes. That
promise cannot be kept without a durability barrier. K3 metering has the same window, and a wider one, because it
emits after the effect.

## Decision

### D1 — `flush()` on the effect context

```ts
interface EffectContext {
  // ...
  /**
   * ADR 0151 — await the durable write of every event this execution has committed so far,
   * including this effect's own emits. Rejects with StorageWriteError if any write failed (the
   * run is already failing). Absent where no durable journal backs the context (the transient
   * seam, test harnesses): a caller that needs durability MUST fail closed when it is absent.
   */
  readonly flush?: () => Promise<void>;
}
```

`WorkflowContext` wires it to `journal.drain()`. It is one awaited store round trip, paid only by middleware that
calls it.

### D2 — the seal check after the drain

`flush()` yields. While it waits, a terminal seal may land: a terminal commit, a sealed inbox payload, or a park
barrier that gave up. After the drain, `flush()` applies the same rule as the K9.3 pre-dispatch drain: a sealed
context does not resolve, so a middleware awaiting it never reaches `next()`. A frozen or parked-scope context
resolves normally: the step is already in flight and holds `activeWork`, exactly as at the K9.3 drain. K9.3 and
`flush()` share one synchronous verdict (`sealedVerdict`); the K9.3 site keeps its drain, seal check, `inFlight++`
and dispatch in one synchronous run (R18), because a microtask between the check and the dispatch lets a terminal
commit seal the context in the gap.

The guarantee is narrow: **the context was not sealed at the moment `flush()` resolved.** Middleware has at least
one tick between `await ctx.flush()` and `next()`, so a seal can land in between. The effect may then run, and its
outcome is not recorded. `flush()` also rejects, with the step signal's reason (deadline or cancel), when the
step's own signal aborted during the drain, so a timed-out step does not dispatch a zombie through the middleware.

### D3 — in-flight accounting

`flush()` is called from inside `EffectRuntime.execute`, so the step already counts as in flight (ADR 0102). It adds
no counter of its own.

### D4 — where it is absent

The transient seam (`EffectRuntime` invoke-transient, whose `emit` is a no-op) and test contexts do not provide
`flush`. A consumer that needs the guarantee refuses to proceed when it is absent. `@loomwork/task-authority`'s lease
middleware refuses a leased effect on a context with no `flush` (ADR 0150 D4 amendment).

### D5 — what it does not do

It does not make `emit` itself durable, and the hot path stays write-behind. It does not change K3 metering's
behaviour; moving K3's meter before the effect and flushing it is a separate decision. It adds no syscall: it is a
method on the effect context that middleware already receives.

### D6 — `readResources()`: the live fold, not the build-time snapshot

```ts
/** ADR 0151 D6 — the execution's CURRENT resource totals from the fold, read at call time (not the
 *  context-build snapshot `resources`). Absent where no fold backs the context. Synchronous. */
readonly readResources?: () => ResourceSnapshot;
```

`ctx.resources` is a snapshot taken when the effect context is built, so accounting middleware that counts
side effects against a ceiling cannot trust it. The lease middleware's review reproduced three failures from
patching around it with in-process reservations: (I1) it double-counted a sibling whose meter was already in a
later context's snapshot, so 4 parallel `idempotent: false` calls against a ceiling of 4 ran only 2; (I6) a retry
re-entering an old context after its high-water cache entry was evicted overshot the ceiling; (I5) the fold caps
custom dimensions at 32 and silently drops a new one, so a lease count could vanish and a snapshot cannot show it.

`readResources()` is **live and synchronous**: it evaluates the same fold read as `resources`, on each call, and
returns a copy (mutating it never reaches the fold). A check-then-emit in one synchronous block is therefore exact
against concurrent effects of the same execution: emits fold synchronously, so the next read sees them. It is
absent on the transient seam and on test contexts, and a consumer that needs it fails closed, like `flush`.

I5 consequence: after its emit, middleware re-reads and checks that the dimension it just metered is present
(`Object.hasOwn(custom, name)`); if the fold dropped it, the middleware fails closed instead of dispatching.

### D7 — `reserveEffectDimensions(prefix)`: flow code cannot forge accounting dimensions

`RESOURCE_METERED` is on the userspace allow-list and its `custom` dimensions only have to match
`/^[a-z][a-z0-9._-]{0,63}$/` with a value in [0, 1e15]; nothing reserved a prefix. So FLOW code could
`ctx.emit("RESOURCE_METERED", { custom: { "lease.w.returned": 100 } })` and forge the counters an accounting
middleware (the task-authority lease, a child-reservation minter) relies on; a probe ran 50 leased effects against
a ceiling of 10.

`WorkflowRuntime.reserveEffectDimensions(prefix)` is a composition-time contributor, modelled on
`composePrincipalCodec`. The prefix must be non-empty and match the custom-dimension charset (else it throws);
reserving is idempotent. `guardUserspaceEmit` then refuses a FLOW-scope `RESOURCE_METERED` whose `custom` names a
dimension starting with any reserved prefix. EFFECT-scope emits are unaffected.

The trust line: grants and guards bound the model and flow code; effects and middleware are registered by the app
and are trusted. The kernel knows no vocabulary: the contributor (for example `@loomwork/task-authority`) names its
own prefix, so nothing like "lease" appears in the kernel. It is additive: with no prefix reserved the behaviour is
byte-identical. It guards new appends only: a recorded event is never re-guarded, so a log that holds an effect
meter under a prefix reserved later still replays (a re-run FLOW emit under it is refused, as any new emit).

## Consequences

- An accounting middleware can count an attempt durably before the attempt: emit, `await ctx.flush?.()`, then
  `next()`. After a crash the count is in the log whenever the side effect could have happened.
- Cost: one store round trip per flushed effect. Lease-governed effects pay it, and nothing else does.
- Residual: an effect that runs after a successful flush and crashes is counted once and may run again on recovery
  (it is re-run, or adopted in doubt). That is the at-least-once boundary the kernel already documents. The count can
  be higher than the number of real side effects, never lower.

## Rejected alternatives

| Alternative | Why rejected | What would reopen it |
|---|---|---|
| Document the gap (soft ceilings) | Owner decision 2026-11-23: a lease that can be silently under-counted after an operator adopts an in-doubt step does not deliver ADR 0150 D4. | — |
| Make every middleware `emit` durable | Puts a store round trip on every metered effect, including K3 metering on hot paths. | A measured case where write-behind emits cause a correctness bug in a 1P middleware that cannot opt in. |
| A separately committed emission channel for middleware | Two journals for one execution break the single ordered log every fold relies on. | Nothing: invariant. |
| Count from `STEP_STARTED` in a projection | `STEP_STARTED` is drained only for `idempotent: false` tools, and the lease middleware reads the fold, not a projection. | — |
