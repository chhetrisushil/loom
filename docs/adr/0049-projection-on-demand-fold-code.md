# ADR 0049 — Projections fold on demand: event-type-gated lazy handler chunks

- Status: **Accepted (implemented 2026-07-13)** — compiler + `@loom/projection-runtime` + `@loom/app`
  (PR #155).
- Date: 2026-07-13
- Builds on: [ADR 0044](0044-no-compiler-plugin-api-manifest-as-output-contract.md) (the compiler's
  lazy-chunk output contract for `handler$`/`instructions$`), [ADR 0011](0011-folder-convention-codegen.md)
  (folder-convention discovery).

## Context

`projection$` produced a `ProjectionDefinition` that **nothing consumed**: the projection runtime
folded a *different, incompatible* type (`Projection<TState>`), and there was no adapter — so
`projection$` was exported but dead, and shadowed by the working `surfaces` mechanism. We wanted to
make it real *and* give it the same on-demand code loading that `handler$` enjoys (QwikJS-style): a
projection's fold code should not be parsed/loaded until it is actually needed.

The design fork was **when** a projection's `import()` chunk loads, given the runtime folds
**synchronously** in `handleEvent`:

- **Observe-gated** (truest on-demand): stay fully dormant until first `getState`/`subscribe`, then
  rebuild state from the log. Closest analog to `handler$`, but couples the storage-agnostic
  projection runtime to the event store and makes activation async.
- **Event-type-gated**: record the handled event-type *keys* at compile time; load the chunk on the
  first matching event, buffering until ready. Keeps the runtime storage-agnostic and the fold hot
  path synchronous.
- **Register-time code-split**: load at boot. Bundle-splitting only, not per-use laziness.

## Decision

**Event-type-gated on-demand loading.**

1. **Compiler** — `tryProcessProjection` extracts a `projection$`'s inline `handlers` object literal
   into its own `import()` chunk (exactly like `handler$`/`instructions$`), records the handled
   **event-type keys** (read statically from the property names), and rewrites `handlers` to a
   `ProjectionHandlersRef` (`{ _loomProjectionHandlersRef, eventTypes, load }`). The manifest gains a
   `projections` section. Extraction only happens when every key is statically named
   (`PropertyAssignment`/method with an identifier/string name); a computed/shorthand/spread key
   leaves the projection **eager** (correct, not code-split) rather than emit incomplete `eventTypes`
   or a broken chunk.

2. **Runtime** — `Projection<TState>` gains a `lazy: { eventTypes, load }` form. `handleEvent` gates
   on `eventTypes` **without importing the chunk**; on the first matching event it imports once,
   buffers that + subsequent matching events, drains the buffer in arrival order, then folds
   synchronously thereafter. A projection whose event types never fire never loads its code.

3. **`@loom/app`** — `defineConfig` adapts `ProjectionDefinition → Projection` (a ref becomes an
   event-type-gated `lazy` projection; an inline map stays eager) and adds `projections` +
   `projectionModules` config keys; `loom gen` discovers `app/projections/*.ts`.

Uncompiled (dev / no plugin), `handlers` stays inline and eager — the same dev-vs-compiled duality as
`handler$`.

## Consequences

- `projection$` is no longer dead code and is a genuine on-demand read-model: an app with many
  projections (e.g. a dashboard of widgets) only loads the fold code for projections whose events
  actually occur. `ProjectionDefinition.handlers` is now `(state, event: EventEnvelope) => state`
  (was `(state, payload)`), matching the runtime one-to-one — a safe change since `projection$` had
  zero callers.
- The projection runtime stays storage-agnostic and its fold hot path stays synchronous; no
  log-replay/async-activation was introduced. We accepted a small buffering window during the
  one-time load instead.
- Robustness: a permanently-failing chunk load abandons the projection (frees its buffer, warns once,
  stops retrying) rather than leak an unbounded buffer or re-import on every matching event. The
  read-model is rebuildable from the log.
- Not chosen: observe-gated. If after-the-fact/historical projections (observe a long-completed
  execution) become a first-class need, that path can be added later — it is strictly more machinery.
