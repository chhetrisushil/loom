# ADR 0027 — Advisory pre-warming at cold-start boundaries

- Status: Accepted (implemented 2026-07-10 — `Effect.warm`/`EffectRuntime.warm`, K7 `IsolatedToolEffect` warming, `LlmProvider.warm`, `TimerService.warmLeadMs`, `WorkflowRuntime.warmFlow`, `defineConfig({ timers: { warmLeadMs } })`)
- Date: 2026-07-10
- Builds on: [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (M6 — the advisory plane & the `Warmer` seam), [ADR 0019](0019-k7-data-plane-isolation-and-egress-control.md) (K7 — the isolated executor)

## Context

Some resources Loom drives are **cold on first use**: the K7 isolated executor forks a
child process and `require`s the tool module (~50–200 ms), an LLM provider opens a
connection / warms a model cache, a scheduled flow's first effect touches a remote
backend. Today those costs are paid lazily on the *first* invocation, on the critical
path of whatever request happened to be first.

[ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) already reserved the
**advisory plane** (P10): work that can affect *latency* only through off-log warming,
and is never a hidden input to the fold. It introduced an optional `Warmer` seam on
`EffectRuntime` for exactly this. What was missing was (a) a first-class, per-effect
warm hook the built-in effects (K7 child, LLM provider) could implement, and (b) a way
to *trigger* warming ahead of a known-future need — most obviously a scheduled
(`schedule$`) execution, whose fire time is deterministic.

Loom 2.0 deliberately **dropped speculative execution** from the durable core. Pre-warming
must therefore stay strictly in the advisory plane: it may spin up a resource, but it may
never run an effect, emit an event, or influence a verdict. Warming a mispredicted resource
wastes a little I/O — nothing more.

## Decision

Add an **opt-in, latency-only** warm seam, wired at the three genuine cold-start boundaries
and nowhere else. Two non-negotiables from the kernel-hardening evaluation carry over:
**G1** (preserve P2 pure replay + P9 log-only non-determinism) and **G2** (additive /
opt-in — byte-identical when unwired).

**W1 — `Effect.warm?()` + `EffectRuntime.warm(toolId)`.** An optional advisory hook on the
`Effect` interface. `EffectRuntime.warm(toolId)` looks up the effect, calls its `warm()`
(swallowing any failure), and also fires the existing `Warmer` seam. Crucially it does
**not** authorize, meter, schedule, or emit — **warming is not invoking**. A warm failure is
a silent no-op; the real call simply runs cold. Idempotent and safe to call repeatedly.

**W2 — K7 isolated executor (the headline win).** `IsolatedToolEffect.warm()` pre-spawns the
persistent child process; `spec.warm: true` does it eagerly at construction. This realizes
the K7-A4 "poolable / warm executor" the K7 amendment called for (previously the child was
forked lazily on first `execute`).

**W3 — LLM provider.** `LlmProvider.warm?()` + `createLlmEffect` wires `effect.warm() →
provider.warm()`, so keeping a connection / model cache hot is a first-class opt-in path.

**W4 — Scheduled flows.** Because a cron occurrence time is deterministic
(`nextOccurrence`), `TimerService` gains `warmLeadMs`: when the next occurrence falls within
the lead window it calls `WorkflowRuntime.warmFlow(flowId)` (which warms the flow's *first*
step's effect — the initial-latency one; later steps warm via the per-execute `Warmer` as
they run). Deduped per occurrence, off by default, exposed via
`defineConfig({ timers: { warmLeadMs } })`.

## Consequences

- **Latency, not throughput.** Pre-warming hides a one-time cold start; it does not increase
  steady-state capacity. So it is scoped to real I/O / cold-start boundaries (K7 child, LLM
  connection, scheduled fires) and explicitly *not* applied to in-process hot paths (the fold,
  local stores, middleware) where it would buy nothing and only add risk. A broad speculative
  pass was rejected.
- **Determinism untouched (G1).** No warm path emits an event or feeds the fold; replay is
  byte-identical whether or not anything was warmed. `EVENT_SCHEMA_VERSION` is unchanged — this
  ADR adds **no** new event type.
- **Zero-overhead when unwired (G2).** No `warm()` implementations and no `warmLeadMs` ⇒ the
  code paths are byte-identical to before. Every seam is additive and optional.
- **Measured (K7):** first-call latency **~54.2 ms cold → ~2.0 ms warm** (~52 ms of fork +
  module-require hidden). See [benchmarks](../benchmarks.md#advisory-pre-warming--cold-start-hidden-pr-64).
- **Mispredict cost is bounded:** an idle child or a needless connection — never a wrong result.
  This is why every path is opt-in and lands on high-probability boundaries.

## Verification

- `EffectRuntime.warm` — calls the effect hook, fires the `Warmer` seam, no-ops on an
  unregistered id, swallows a warm failure, and **does not** invoke the effect (P10).
- K7 `IsolatedToolEffect` — `warm()` pre-spawns the child before the first `execute`;
  `spec.warm: true` spawns eagerly at construction; warming is idempotent; a warmed child still
  runs correctly.
- LLM — `createLlmEffect` delegates `effect.warm()` to `provider.warm()`; no `warm` when the
  provider implements none.
- Scheduling — `WorkflowRuntime.warmFlow` warms the first step only (no-op for unknown flows);
  `TimerService.warmLeadMs` warms once per occurrence within the window, skips beyond it, and is
  off by default.
- Full suite green; the DS&A/pre-warm branch merged to `main` as PR #64 (commit `89334fc`).

> **Relationship to ADR 0016:** this ADR *extends* the M6 `Warmer` seam from "an optional
> off-log hook" to a wired capability across the three cold-start boundaries. The advisory-plane
> contract (P10) is unchanged; only the surface that uses it grew.
