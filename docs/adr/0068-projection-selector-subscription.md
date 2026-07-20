# ADR 0068 — Fine-grained selector-subscription on ProjectionRuntime

- Status: Accepted (2026-07-21)
- Date: 2026-07-21
- Builds on: the reactive-graph resumability verdict ([ADR 0067](0067-reactive-graph-resumability-rejected.md)),
  live-query as a read-model (ADR 0040), plugin packaging (ADR 0043).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA unchanged (1.17.0); no `@loom/spec` capability version bump** (additive method on an
  unversioned framework-agnostic mechanism interface).

## Context

[ADR 0067](0067-reactive-graph-resumability-rejected.md) rejected Qwik-style serialize-the-graph
signals, and identified exactly one framework-agnostic residue worth building *when a second live
rendering surface arrives*: the "wake me only when my bound slice changed" logic, which today lives
trapped in the React `useWidgetValue` hook (`plugins/renderer-react/src/hooks/useWidgetValue.ts`).
Every other live surface — a streaming terminal renderer, a VS Code / editor webview (Gemini
Enterprise), a Claude Code plugin — would otherwise reimplement that path-diffing itself.

That second consumer has now arrived: the GenUI project targets terminal, editor-webview, and
Claude-Code surfaces, all live. Per ADR 0067's D3 evidence gate (and the `finding$`/`rotate$`
"promote on a second consumer" precedent), the generic primitive is now demand-justified rather
than speculative.

`ProjectionRuntime.subscribe` (`packages/projection-runtime`) notifies on *every* projection change
and hands over the whole state; slice-granularity was a per-renderer concern. This ADR lifts it into
the shared, framework-agnostic read-model runtime.

## Decision

### D1 — Add `subscribeSelector` to `ProjectionRuntime` (generic, memoized, change-only)

```ts
subscribeSelector<TState, TSlice>(
  projectionId: string,
  executionId: string,
  selector: (state: TState) => TSlice,
  handler: (slice: TSlice) => void,
  isEqual?: (a: TSlice, b: TSlice) => boolean   // default Object.is
): () => void
```

The runtime memoizes `selector(state)` per subscription and invokes `handler` only when the slice
changes under `isEqual`. It takes a **selector function**, not a path string — so
`projection-runtime` stays UI-agnostic (no path/binding semantics leak in); the caller supplies the
projection: dot-path resolution via the newly-exported `resolvePath` from `@loom/blueprint-runtime`.
Semantics mirror `subscribe`: **change-only** (no call on subscribe; `last` seeded from current
state at subscribe time), and it participates in `coalesceNotifications` (a burst collapses to one
call per changed slice per microtask). Whole-state `subscribe` keeps a zero-overhead fast path — the
selector registry is a separate map, untouched when unused (G2).

### D2 — This is a `packages/*` mechanism, not kernel and not a plugin

`projection-runtime` is a framework-agnostic read-model mechanism (a cache of the log, never an
authority — ADR 0040/0058). Fine-grained subscription is generic mechanism, so it stays in
`packages/*` (not a `plugin-*`, which are vendor/framework adapters — ADR 0043). It touches **no
syscall, no event kind, no fold** — replay is untouched by construction (a read-model never feeds
the fold). Consistent with ADR 0067's "no kernel/event-schema change."

### D3 — React renderer migrates onto it as the proof consumer

`useWidgetValue` and `useDeferredWidgetValue` now subscribe slice-scoped, so `onStoreChange` /
`setValue` fire only when the widget's own slice changes — an unrelated slice's update on the same
projection no longer schedules React work at all (a real reduction, not just relocation). The
equality guard moves from the hooks into the runtime; `useWidgetValue` keeps its stable-ref
`getSnapshot` cache as required by `useSyncExternalStore`. Behavior is unchanged (existing
renderer-react tests stay green). Future surfaces (terminal, editor-webview, Claude Code) consume
`subscribeSelector` + `resolvePath` directly and inherit slice-granular reactivity with no
per-surface diffing.

## Consequences

- New public method on `ProjectionRuntime`; both implementors updated
  (`InMemoryProjectionRuntime`, `BroadcastingProjectionRuntime` — a one-line delegation).
- `resolvePath(state, path)` exported from `@loom/blueprint-runtime` as the generic, null-safe
  dot-path selector helper for surface authors (extracted from the existing `resolveWidgetValue`).
- `KERNEL_ABI_VERSION` stays 1.1.0; `EVENT_SCHEMA_VERSION` stays 1.17.0; the generated maturity
  table is unchanged. Covered by unit tests (slice isolation, change-only, custom `isEqual`,
  coalescing, unsubscribe). The real guarantee is slice isolation: a change to an unrelated slice
  invokes **zero** of the other slices' handlers — so downstream work drops from W handler
  invocations to (changed slices). That is an invocation-count property (asserted by the tests),
  **not** a runtime wall-time speedup: at the runtime level the selector path does slightly *more*
  work (it evaluates W selectors to filter), and the payoff is the O(W) downstream re-renders it
  spares the consumer. The dispatch micro-bench in `projectionStorm.bench.ts` documents that the
  filtering overhead stays bounded.
- The generic seam now exists for the GenUI multi-surface renderers; none of those renderers are
  built here.
