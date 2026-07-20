# ADR 0067 — Reactive-graph resumability rejected; lazy widget hydration is a renderer-plugin concern

- Status: Accepted (2026-07-21)
- Date: 2026-07-21
- Builds on: [Qwik-resumability-signals evaluation](../requirements/2026-07-21-qwik-resumability-signals-evaluation.md),
  the ST-R streams/pipes rejection ([db-copilot infrastructure](../requirements/2026-07-15-db-copilot-infrastructure.md)),
  live-query as a read-model (ADR 0040), plugin packaging (ADR 0043), no compiler plugin API (ADR 0044),
  placement-verdict discipline (ADR 0051), suspension-transfer rejection (ADR 0052 D3),
  the execution runtime & decision seam (ADR 0016).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA unchanged (1.17.0); no `@loom/spec` capability entry.**

## Context

Qwik's defining feature is *resumability*: reactive state cells with automatic dependency
tracking, where the entire reactive graph — signal values + the subscription graph +
closures-as-QRLs — is **serialized at the SSR→client boundary** so the client resumes without
re-executing or re-hydrating, attaching listeners lazily via QRL lazy-import + event delegation.
loom looks Qwik-adjacent — it has a `$`-based compiler that already code-splits handler bodies,
and an event-sourced render layer that is already fine-grained-reactive — so the question arose
whether adopting Qwik's *state* resumability (signals) would benefit loom, and if so whether it
belongs in the kernel or a plugin.

Evaluated against the best existing loom mechanism (ADR 0051's discipline), the answer splits. The
full survey is in the evaluation doc; this ADR records the decisions.

## Decisions

### D1 — The signal / serialize-the-reactive-graph *state model* is REJECTED (permanent non-goal)

Recorded beside `finding$` (ADR 0051 D4), `rotate$` (ADR 0052), and ST-R. A serialized reactive
graph is a **second, non-logged source of truth** for state — the render-plane twin of the ST-R
rejection ("unrecorded in-flight data … breaks the determinism boundary"). It violates **P2**
(state is `fold(events)` and nothing else; a serialized graph is a non-fold-derived input). It is
**in-memory / single-process / lossy** — strictly weaker than the log for the very
durability/continuity cases it would claim to serve (it is gone on the crash you feared). And it
is **JS/React-specific** — actively worse for loom's multi-surface goal (terminal + web + mobile
render independently from one log). This is not "low priority"; it is a non-goal.

### D2 — loom already has the resumabilities that matter; there is nothing to adopt

- **Code resumability:** the compiler already extracts `handler$`/`instructions$`/projection
  fold-map bodies into lazy `import()` chunks (`tools/compiler/src/transform.ts`), and the
  projection descriptor is even *event-gated* — `{ _loomProjectionHandlersRef, eventTypes, load }`
  loads a fold handler only when a matching event fires (`transform.ts:213-293`). This is QRL's
  code-splitting, including Qwik's "load the handler only when its event fires."
- **Execution / state resumability:** event-sourced replay (`ctx.suspend`/`resume`, step-keyed
  frames, logged-and-served `decide`/`execute` results) is durable, crash-recoverable, cross-node,
  and verifiable. Qwik's serialize-the-graph resumability is the in-memory, single-process,
  unverifiable version of the same idea.

Stated precisely, so it is not re-litigated: **loom has QRL's code-splitting but deliberately not
its lexical-capture.** `handler$(fn)` is `{ _loomHandlerRef: true, fn }`
(`packages/core/src/builders/step.ts:40-44`); the compiler rewrites it to
`() => import("<chunk>")` with the chunk rebuilt from import lines + function body only — **no
captured lexical scope** (`transform.ts:104-124`). Closure capture is exactly the half loom
forbids under P2; ADR 0044 (no compiler plugin API) keeps that surface closed. Likewise
`seedState` + the fiber renderer is *seeded hydration, not resumability*: it resumes data (no
empty-flash), but the client still re-executes the tree and re-establishes every subscription.

### D3 — Lazy / virtualized widget hydration is a `plugin-renderer-react` perf item — already permitted, benchmark-gated, and NOT a Qwik adoption

The one real gap is client-boot cost: the fiber renderer mounts *every* widget eagerly and each
subscribes on mount (`plugins/renderer-react/src/fiber/FiberWidget.tsx`,
`hooks/useWidgetValue.ts:24-31`) — O(N) mount + O(N) subscribe regardless of interaction. Reducing
that with lazy-mount / event delegation / virtualization is a renderer-plugin internal refactor
allowed by ADR 0043: **no kernel, no event-schema, no compiler-manifest, no fold** involvement,
byte-identical-when-unwired. It stands purely on an N-widget boot benchmark (the same evidence
discipline as fibers/speculation — ADRs 0016/0033/0051/0052) and needs **none** of Qwik's signal
model, closure serialization, or QRL lexical-capture. It is recorded here only to keep it
*separate* from D1: framing it as "Qwik resumability" would mis-file a mundane optimization as a
state-model question and re-open the dead model on every read. This ADR grants it no blessing
beyond this pointer.

Why loom needs none of Qwik's graph machinery: every subscription edge is declarative
`widget.binding = { projectionId, path }` (`packages/blueprint-runtime/src/types.ts`), re-derived
on mount; interactivity is a single app-level `onAction(WidgetAction{ type, widgetId, payload })`
plus a static kind→component registry. There is no imperative reactive graph to serialize and no
per-widget closure to reattach — the problem Qwik exists to solve does not exist in loom's render
model.

### D4 — No kernel or event-schema change; and there is no sliver of one

A "UI-continuation event" / "serialized-graph snapshot" event kind is **ST-R on the render
plane** — a bulk, opaque, render-framework-specific blob that verifies nothing on replay — and a
cousin of the permanently-rejected identity-preserving suspension transfer (ADR 0052 D3). Every
genuine need it purports to serve already routes to an existing syscall/transport: meaningful
cross-device UI state → `ctx.emit` (any device recomputes it from the log); server-push / token
streaming → `ctx.stream` + `A2UI_PATCH`; resume-from-snapshot of a surface → `A2UIRuntime.seed` /
`surfaceProjection` / `seedState`. This mirrors ADR 0040 (live-query shipped with zero
ABI/event-schema change).

## Consequences

- **`KERNEL_ABI_VERSION` stays 1.1.0** (`packages/workflow-runtime/src/abi.ts`); **`EVENT_SCHEMA_VERSION`
  stays 1.17.0** (`packages/replay-vm/src/eventHandlers.ts`). No new syscall, event kind, or
  `@loom/spec` capability entry — the generated maturity table is unchanged.
- The signal/serialize-the-graph state model is a recorded permanent non-goal; future proposals
  should be closed by reference to D1 rather than re-evaluated.
- Lazy/virtualized widget hydration remains available to `plugin-renderer-react` as an ordinary,
  demand-and-benchmark-gated optimization (D3), decoupled from any signals question.
- No code changes land with this ADR; it is a verdict record.
