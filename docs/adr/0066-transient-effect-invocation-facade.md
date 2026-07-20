# ADR 0066 — `invokeTransient`: a supported façade for non-durable effect invocation

- Status: **Accepted** (`EffectRuntime.invokeTransient` + `WorkflowRuntime` delegate)
- Date: 2026-07-20
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (P0 hydration is a transient service, not a loom run), ADR 0065 (durability
  classes rejected on invariants — "don't make it a run until something durable
  happens"), ADR 0058 (read-model plugin — the durable read surface a transient
  service fronts), K2 (`CapabilityAuthorizer` — enforced transiently).
- Part of: the GenUI/DE corrected series. **DX only — no kernel change.** KERNEL_ABI
  unchanged (1.1.0); no new event types; EVENT_SCHEMA unchanged.

## Context

The DE-series evaluation answered the GenUI hot read path architecturally: P0
hydration is **not a loom run**. A transient interpreter walks the immutable,
content-addressed manifest in plain code; the determinism boundary is crossed
only when something durable happens (drift repair, planning). ADR 0065 drew the
hard line behind it — durability classes / ephemeral runs / flush semantics are
rejected on invariants, not cost.

The mechanism to run an effect off the durable path already existed:
`EffectRuntime.execute(toolId, input, ctx)` writes no events (its sole `emit` is
the K2 authz denial, which also throws) and holds no event store. What was
missing was a **supported entry point**. To use it, an app had to hand-build an
`EffectContext` — inventing `executionId`/`stepId`/`attempt` and a no-op `emit` —
coupling to an internal type whose semantics (`idempotencyKey`, `principal`,
`toolId`, `signal`, `resources`) are subtle and versioned. Every integrator
following loom's own guidance re-derived this; even the in-repo GenUI analog
(`examples/db-observability`) instead defaulted to a **durable** `runtime.start()`
on its hot path, paying per-read `STEP_*` appends it never used.

## Decision

Add `invokeTransient(toolId, input, opts?)`: the framework-owned, versioned
façade over the already-blessed transient path.

### D1 — Ownership of the synthetic context (R2)

`invokeTransient` synthesizes the `EffectContext` internally and calls `execute`.
Callers depend on a stable public signature — `TransientInvokeOptions { signal?,
principal?, label? }` — never on the context shape. The synthetic identity is
throwaway (`executionId: "transient:<label>"`, `stepId: toolId`, `workflowId:
"transient"`, `attempt: 1`); `idempotencyKey` is left unset, so callers must not
rely on provider-side dedup across transient calls (a transient read path is
retry-on-client by design).

### D2 — Zero durable footprint is structural, not conventional (R1)

The `EffectRuntime` holds no event store, journal, or fence. A transient
invocation therefore produces zero envelopes — no `EXECUTION_STARTED`, no
`STEP_*`, no snapshot — by construction, not by a flag. This is the sanctioned
side of the ADR 0065 line: no execution, no fold, no fencing, nothing to recover.
The guarantee is tested end-to-end against an in-memory store that stays empty.

### D3 — Documented middleware contract (R3)

The **same** statically configured effect-runtime middleware chain that a durable
step's effect call runs also runs transiently — retry/backoff and the K2
authorizer are effect-local and remain in force. What is bypassed is everything
*above* this layer: the workflow interpreter's journaling/durability (fold,
`ExecutionJournal`, fencing, snapshots) is not `EffectRuntime` middleware at all,
so there is nothing to opt out of. A caller reasons about the contract without
reading runtime internals.

### D4 — Emit is a drop sink; cancellation via signal (R4, R5)

`ctx.emit` is a no-op: an effect that emits transiently has the event dropped by
construction — never buffered, never later flushed. `opts.signal` is forwarded as
`ctx.signal`, so a caller can bound a transient invocation with a deadline
(propagated to `fetch`/sandbox/providers; `execute` already fails fast on an
already-aborted signal).

### D5 — A `WorkflowRuntime` delegate

Apps hold the top-level `WorkflowRuntime`, so it carries a thin pass-through to
`effectRuntime.invokeTransient`. The façade is *owned* on `EffectRuntime` (next to
`execute`); the delegate is ergonomics.

## Explicitly not in scope

This does **not** reopen DE-2 / DE-7 (ephemeral run durability class), rejected by
ADR 0065 and flagged "do not reintroduce." There is no run that is sometimes
durable, no buffered-then-flushed events, no flush-boundary semantics. The
signature returns `Promise<TOut>`, accepts no event store, and returns no handle —
the guardrail that keeps it on the sanctioned side. If a future change tries to
make it "sometimes durable," that is DE-2 again: reject it there.

## Consequences

- `examples/db-observability` is reworked to the prescribed shape: the hot path
  hydrates transiently (zero events), and `start()`s a durable repair run only on
  a `schemaDrift` — the durable outcome, recorded via `SCHEMA_REPAIRED`. The
  transient failure itself is never a durable fact. This is the worked recipe
  shipped next to the DE-series guidance (see `docs/transient-interpreter.md`).
- A drift now re-walks the plan durably (the transient reads wrote nothing to
  substitute). This is honest — non-durable data must not enter the fold — and
  the double-fetch of non-drifted nodes is paid only on the rare repair path, not
  the hot path.
