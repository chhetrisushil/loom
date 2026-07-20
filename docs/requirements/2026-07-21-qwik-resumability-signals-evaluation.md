# Qwik-style resumability signals in loom — evaluation

- Date: 2026-07-21
- Status: Evaluation complete → verdict recorded in [ADR 0067](../adr/0067-reactive-graph-resumability-rejected.md)
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). No implementation proposed.
- Anchors: the ST-R streams/pipes rejection ([db-copilot infrastructure](2026-07-15-db-copilot-infrastructure.md)),
  live-query as a read-model (ADR 0040), plugin packaging (ADR 0043), no compiler plugin API (ADR 0044),
  placement-verdict pattern (ADR 0051), suspension-transfer rejection (ADR 0052 D3).

## The question

Would **Qwik-style resumability signals** benefit loom, and if so should they be kernel or
plugin?

"Qwik resumability signals" is a specific thing, not reactivity in general. Qwik's core
innovation is: reactive state cells (`useSignal`/`useStore`) with **automatic dependency
tracking**, where the *entire reactive graph* — signal values + the subscription graph +
closures-as-QRLs — is **serialized at the SSR→client boundary** so the client **resumes without
re-executing or re-hydrating**, attaching listeners lazily via QRL lazy-import + event
delegation. The `$` is the serializable-lazy boundary: a QRL is a lazy chunk reference **plus a
captured lexical scope**.

The question is natural because loom *looks* Qwik-adjacent from two angles: it has a `$`-based
compiler (`tools/compiler`) that already does Qwik-like *code* resumability, and an
event-sourced render layer that is already fine-grained-reactive. This doc asks whether adopting
Qwik's *state* resumability adds anything, evaluated — per ADR 0051's discipline — against the
*best existing loom mechanism*, not against an app approximating the proposed primitive.

## What loom already has

**Two resumabilities, neither of them Qwik's.**

1. **Code resumability (compiler).** `handler$(fn)` is `{ _loomHandlerRef: true, fn }`
   (`packages/core/src/builders/step.ts:40-44`). The compiler extracts the function *body* into a
   virtual chunk and rewrites the handler in place to `() => import("<chunkVirtualId>")`
   (`tools/compiler/src/transform.ts:104-124`). The chunk source is rebuilt from the file's
   import lines + the function text only (`buildChunkSource`) — **no captured lexical scope**. So
   on resume/replay only the specific step chunks needed load, rather than the whole flow module.
   The projection fold-map gets the same treatment, and goes one step further: it is code-split
   *and* event-gated — the descriptor
   `{ _loomProjectionHandlersRef: true, eventTypes: [...], load: () => import(...) }` records the
   event-type keys statically so the runtime loads the chunk only when a matching event fires,
   without importing it first (`tools/compiler/src/transform.ts:213-293`). That is precisely
   Qwik's "load the handler only when the event that needs it fires," applied to the reactive fold
   side.

2. **Execution / state resumability (runtime).** Event-sourced: `ctx.suspend`/`resume`, frames
   keyed by step id, `decide`/`execute` results logged and served on replay
   (`packages/workflow-runtime`, `packages/replay-vm`). State is `fold(events)` and nothing else.
   This resumability is durable, crash-recoverable, cross-node, and verifiable.

**The render stack is already fine-grained-reactive without signals.** Event-sourced projections
(`packages/projection-runtime`, `ProjectionRuntime.subscribe` with microtask coalescing) +
**declarative** widget bindings `{ projectionId, path }` (`packages/blueprint-runtime/src/types.ts`)
+ a per-widget "fiber" React renderer (`plugins/renderer-react/src/fiber/FiberWidget.tsx`) using
`useSyncExternalStore` + path-granular caching (`plugins/renderer-react/src/hooks/useWidgetValue.ts:24-54`).
SSR seeds projection state synchronously (`seedState`), so there is no empty-flash on first paint.
Interactivity is a single app-level `onAction(WidgetAction{ type, widgetId, payload })` plus a
static kind→component registry — there is no per-widget closure to lazily reattach.

## Steel-manned benefit survey

Six angles where Qwik-resumability might give loom something it lacks. Five collapse *toward*
reject; one survives as a mundane renderer item.

| Angle | Verdict | Why |
|---|---|---|
| **Cross-device / mid-run UI continuation** | collapses → reject | Any UI state worth continuing across devices must become a **logged fact** (`ctx.emit` a `draft-saved`). Once logged, recompute-from-log already continues it — durably, verifiably, on any surface. A serialized graph would be a *second, non-logged source of truth*, in-memory and lossy (gone on the very crash you feared). This is the ST-R trap inverted. |
| **Offline / edge resume** | collapses → reject | A2UI is already event-sourced patches (`A2UI_PATCH` folded by `A2UIRuntime.handleEvent`, `packages/a2ui/src/A2UIRuntime.ts`); reconnect = replay patches from a sequence / `seed()` from snapshot. Strictly more robust than a serialized in-memory graph. |
| **Multi-surface (terminal + web + mobile)** | collapses → *reject harder* | loom renders each surface independently from one log via declarative blueprints. A serialized JS reactive graph is React/JS-specific and would **not** port to terminal/mobile — *actively worse* for the multi-surface goal. |
| **Server-push GenUI / token streaming** | collapses → already shipped | `ctx.stream` + `A2UI_PATCH` (the ST-0 "already-shipped transports"). |
| **Partial hydration of large dashboards** | reduces to ↓ | Same as the boot-cost item below. |
| **Large agent-generated widget-tree client boot** | **survives (marginal)** | The fiber renderer mounts *every* widget eagerly and each calls `useSyncExternalStore` → `subscribe` on mount (`FiberWidget.tsx`, `useWidgetValue.ts:24-31`). For an N-widget dashboard that is O(N) mount + O(N) subscribe on boot regardless of interaction; Qwik's event delegation pays ~O(interacted). That delta is real. |

**The deep reason five of six collapse.** Qwik *must* serialize its reactive graph because it has
**no durable log** — the serialized graph *is* its continuity substrate. loom already has that
substrate. The `ui` syscall + A2UI is the proof: loom solved *durable, replayable UI* by making
UI mutations **logged events** (`A2UI_PATCH` → `surfaceProjection`), not by serializing a live
graph. On the render plane loom is already "post-Qwik" by a different route — and it never built
the *imperative* subscription graph Qwik has to serialize, because every subscription edge is
**declarative data** (`{ projectionId, path }`), re-derived on mount.

## Placement verdict

| Item | Placement | Rationale |
|---|---|---|
| Signal / serialize-the-reactive-graph **state model** | **REJECT — permanent non-goal** | Second, non-logged source of truth (render-plane twin of ST-R); violates P2. In-memory/single-process/lossy — weaker than the log for the durability it claims. JS/React-specific — worse for multi-surface. Recorded beside `finding$` / `rotate$` / ST-R. |
| Execution / state resumability | **Nothing to adopt** | loom already has a *stronger* form (durable, crash-recoverable, cross-node, verifiable event-sourced replay). Qwik's is the in-memory, single-process, unverifiable version of the same idea. |
| Lazy / event-delegated / virtualized widget hydration | **Ordinary `plugin-renderer-react` perf item — already permitted (ADR 0043), benchmark-gated. NOT a Qwik adoption.** | A renderer-plugin internal refactor: no kernel, no event-schema, no compiler-manifest, no fold. Byte-identical-when-unwired. Stands purely on an N-widget boot benchmark; needs none of Qwik's signal model, closure serialization, or QRL lexical-capture. Kept *separate* so the dead state-model is not re-litigated on every read. |
| Kernel / event-schema change | **None** | KERNEL_ABI stays 1.1.0; EVENT_SCHEMA stays 1.17.0; no `@loom/spec` capability entry. See below. |

**No kernel/event-schema sliver.** The candidate — a "UI-continuation event" / "serialized-graph
snapshot" event kind so a UI resumes mid-run on another device — is exactly **ST-R on the render
plane**: a bulk, opaque, render-framework-specific blob in the durable log that verifies nothing
on replay, and a cousin of the permanently-rejected identity-preserving suspension transfer
(ADR 0052 D3). It fails P2 (a non-fold-derived input to state) and P10 (framework-specific
reactivity as a hidden fold input). Every genuine need it purports to serve already routes to an
existing syscall/transport: meaningful cross-device UI state → `ctx.emit` (any device recomputes
it); server-push / token streaming → `ctx.stream` + `A2UI_PATCH`; resume-from-snapshot of a
surface → `A2UIRuntime.seed` / `surfaceProjection` / `seedState`; ephemeral client state
(scroll/focus) → definitionally not durable, and if it must be it becomes a logged fact and the
first case applies. This mirrors ADR 0040 (live-query shipped with zero ABI/event-schema change).

## Precise claims (avoid the overclaims)

- **loom has QRL's code-splitting, deliberately not its lexical-capture.** QRL is two things: a
  lazy chunk ref *and* a serialized closure environment. loom's chunking is only the first — it
  relocates the function body and reconstructs imports, capturing **no lexical state**
  (`tools/compiler/src/transform.ts:104-124`). That omission is deliberate and correct: closure
  capture would be a non-logged fold input (P2). The missing half is exactly the half loom forbids.
  ADR 0044 (no compiler plugin API; the manifest is the build-time contract) closes the compiler
  surface where such capture would otherwise be bolted on.
- **`seedState` + fiber is seeded hydration, not resumability.** `seedState` resumes *data*
  (synchronous seed → no empty-flash, `useWidgetValue.ts:52-54`), but the client still re-executes
  the component tree (mounts every widget) and re-establishes every subscription. Qwik's defining
  property — skip re-execution, lazy-attach listeners — loom does *neither*. The honest gap is the
  O(N) mount + subscribe boot cost, addressable with virtualization/lazy-mount and needing zero
  signal model.
- **loom never built the graph Qwik serializes.** Every subscription edge is declarative
  `widget.binding = { projectionId, path }`, static serializable data re-derived on mount. Qwik
  must serialize its *imperative* subscription graph (edges created by running code that reads
  signals). loom achieved "resumability of the reactive graph" *structurally* by making the graph
  declarative — the only residual is the mount/subscribe calls.

## Evidence anchors

- `tools/compiler/src/transform.ts:104-124` — QRL-half chunking (handler body → lazy `import()`, no lexical capture).
- `tools/compiler/src/transform.ts:213-293` — event-gated projection-handler lazy-load descriptor.
- `packages/core/src/builders/step.ts:40-44` — `handler$` shape.
- `plugins/renderer-react/src/fiber/FiberWidget.tsx` — eager O(N) widget mount (the one real gap).
- `plugins/renderer-react/src/hooks/useWidgetValue.ts:24-54` — declarative subscribe + seeded hydration.
- `packages/blueprint-runtime/src/types.ts` — `{ projectionId, path }` binding + `WidgetAction` / `onAction`.
- `packages/a2ui/src/A2UIRuntime.ts` — durable UI already inside P2 via patches-as-events (`seed`, `handleEvent`).
- `packages/projection-runtime/src/InMemoryProjectionRuntime.ts` — `subscribe` / `seedState`.
- `docs/requirements/2026-07-15-db-copilot-infrastructure.md` §ST-R — the streams/pipes rejection this mirrors.
- `packages/workflow-runtime/src/abi.ts` — `KERNEL_ABI_VERSION = "1.1.0"` (unchanged).
- `packages/replay-vm/src/eventHandlers.ts` — `EVENT_SCHEMA_VERSION = "1.17.0"` (unchanged).
