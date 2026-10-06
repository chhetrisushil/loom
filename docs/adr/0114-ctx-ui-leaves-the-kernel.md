# ADR 0114 — `ctx.ui` leaves the kernel

- Status: **Accepted — implemented** (2026-10-07) — design approved after 4 review rounds; see "Implementation notes" for the deviations
- Date: 2026-10-05
- Closes: R14 (agentic-readiness audit, kernel appendix G1)
- Builds on: [ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md) (the layering guard),
  [ADR 0069](0069-a2ui-egress-adapter.md) (the A2UI egress over `agent-surface`),
  [ADR 0102](0102-flow-emits-append-once.md) (`ctx.ui` is a flow-level emit and stamps like one).
- Placement: **kernel removes; `@loom/agent-surface` and `@loom/app` own.** KERNEL_ABI
  1.2.0 → 1.3.0 (shared Wave 2 bump): `ui` is marked `deprecated`, not removed; removal is a MAJOR.
  EVENT_SCHEMA: no change from this ADR.

## Context

`ctx.ui` is a syscall in `KERNEL_SYSCALLS` (`kind: "accessor"`), and `@loom/workflow-runtime` depends
on `@loom/agent-surface`, which pulls `@loom/classify` and `@loom/projection-runtime`.
`WorkflowContext` builds it as `createSurfaceEmitter((eventType, payload) => this.emit(eventType,
payload))`: a typed patch-builder over `emit`. It needs no kernel slot. What it costs is real: the
kernel's build graph includes a UI package, `workflow-runtime/src/types.ts` imports a UI type into the
kernel's own `ExecutionContext`, the layering guard (ADR 0043) forbids kernel → `plugins/*` but is
blind to kernel → *application vocabulary*, and the ABI's own minimality standard (P10) is violated by
the one entry that is mere sugar.

## Decision

### D1 — The kernel stops importing `@loom/agent-surface`

`ExecutionContext.ui` is typed by **declaration merging**, owned by agent-surface:

```ts
// @loom/agent-surface
declare module "@loom/workflow-runtime" {
  interface ExecutionContextExtensions { readonly ui: SurfaceEmitter }
}
```

`ExecutionContext` extends the (empty-by-default) `ExecutionContextExtensions` interface, so
`ctx.ui` type-checks wherever agent-surface is in the program and nowhere else. At runtime the
accessor is supplied by an injected factory, `WorkflowRuntimeDeps.surface?: (emit) => unknown`;
`defineConfig` / `@loom/app`, `@loom/testing` and `@loom/scaffold` pass `createSurfaceEmitter`, so
every composed app is unaffected. `workflow-runtime/package.json` drops `@loom/agent-surface`.

A bare `new WorkflowRuntime(...)` with no `surface` dep gets an accessor that throws a message naming
the dep. That is a behaviour break for direct-runtime users of a `1.x` accessor, which is why the
ABI entry is marked `deprecated: true` in 1.3.0 rather than deleted, and why the injected-factory
choice was an open question (design document §7 question 2). **Decided (user, 2026-10-05, "Break now"):
accept the break now.** The monorepo is lockstep and unpublished, so nothing outside it
holds a `1.x` bare runtime; the implementation PR runs the `loom-examples` / `loom-plugins` suites against
the built dist to measure the blast radius. The alternative (keep the dependency until the 2.0.0 that
removes `ctx.ui`) stays available if a consumer turns up.

### D2 — The sugar moves: `surface(ctx)`

`@loom/agent-surface` exports `surface(ctx) = createSurfaceEmitter(ctx.emit)`, the documented spelling
for code that has a context and no injected factory. `ctx.ui.set(...)` keeps working under D1; new
code and docs use `surface(ctx)`. Docs and decks that show `ctx.ui` (about 25 files) are updated in the
implementation PR, not here.

### D3 — `negotiateBudget` joins the table

The audit's R12 drift (`negotiateBudget` is on `ExecutionContext` but not in `KERNEL_SYSCALLS`) is
fixed in the same bump: the table entry is added with `since: "1.3.0"` and `kind: "call"`, or the
method is declared derived (`decide`) and moved to a helper; the implementation PR picks, the ADR
requires that interface and table agree and a test asserting it.

### D4 — The layering guard learns the inverse rule

`layering.ts` gains a second invariant: **a `KERNEL_PACKAGES` member depends only on other
`KERNEL_PACKAGES` members** (a closed set, today satisfied by everything except this one edge, so the
test fails before D1 and passes after). A kernel package that needs an external type must take it
structurally. The first test of the new rule is written to fail against `main` and to be the PR's
acceptance.

## Replay and migration

No event or fold change: `ctx.ui` was always `emit`, and the emitted events keep their kinds and
`flowEmit` stamps. The only migration is the dependency edge and the docs.

## Tests

The new layering invariant (red on `main`, green after); `ctx.ui` works for `defineConfig` apps and for
a bare runtime given `surface`; throws a clear error for a bare runtime without it; the ABI table and
`ExecutionContext` agree (`abi.test.ts` extended); `surface(ctx)` produces byte-identical events to
the old accessor (a fold-equality test over a recorded surface log).

## Rejected

- **Deleting `ctx.ui` now**: a MAJOR; deprecation first.
- **A generic "context extension registry"** for third parties: a seam with one user. Declaration merging
  plus one injected factory is enough, and a second extension would be the evidence to revisit.

## Implementation notes (2026-10-07)

- **D1.** As designed. `ctx.ui` is a lazy, memoised getter on `WorkflowContextImpl`: with no factory it throws
  (`ctx.ui is not available: ... pass surface: createSurfaceEmitter ... or use surface(ctx)`), so a bare runtime
  breaks only when a flow touches `ctx.ui`, not at construction. `@loom/agent-surface` now has an OPTIONAL
  PEER on `@loom/workflow-runtime` (types only, for the merge; a dev dependency for its own tests); the inverse edge is gone, so there is no cycle. The kernel's
  own tests inject a tiny local stub (`testSurface.ts`) instead of importing agent-surface.
- **`@loom/testing` and `@loom/scaffold` need no `surface` argument.** Neither constructs a `WorkflowRuntime`: both go
  through `defineConfig`, which now passes `createSurfaceEmitter`. What the scaffold/appgen DID need was the
  *type*: a generated flow that wrote `ctx.ui.set(...)` no longer type-checks unless agent-surface is in the
  program, so `@loom/appgen` emits `surface(ctx).set(...)` plus the import (`ensureUi` reuses an existing import of
  any form, aliasing around a colliding local `surface`), and the scaffold's package.json depends on
  `@loom/agent-surface`. `@loom/testing` is covered by a test that `ctx.ui` writes a `SURFACE_PATCH` through `createTestApp`.
- **Type reach (review round 1).** `@loom/app` re-exports `type SurfaceEmitter` from `@loom/agent-surface`, which pulls
  agent-surface's `declare module "@loom/workflow-runtime"` into every program that imports `@loom/app`: composed apps
  keep `ctx.ui` typed with no agent-surface import. Bare-runtime users import `@loom/agent-surface` (or `@loom/sdk`,
  which re-exports it). Proven by `tools/testing/src/uiTypes.test.ts`, which runs tsc over an `@loom/app`-only consumer
  (and a negative control). The peer is optional: under `skipLibCheck: true` an agent-surface consumer WITHOUT
  workflow-runtime type-checks; under `skipLibCheck: false` it errors TS2307 on agent-surface's `context.d.ts`, so
  install `@loom/workflow-runtime` (documented in the agent-surface README).
- **D3.** `negotiateBudget` is added to the table as a `call` (`since: "1.3.0"`), not declared derived. The test
  (`abi.test.ts`) reads `ExecutionContext` through the TypeScript compiler API (own members, any `extends`/formatting) and asserts its members equal the table minus `ui`.
- **D4.** The closed set needed ONE addition the ADR did not foresee: `effect-runtime` has always imported
  `@loom/classify` (a vocabulary leaf with only `zod` behind it). It joins `KERNEL_PACKAGES` rather than being
  carved out as an exception; `workflow-runtime` -> `agent-surface` is the only edge that was red on `main` once it did.
- **Fold-equality test** lives in `@loom/agent-surface` (`context.test.ts`): the injected `ctx.ui`, `surface(ctx)` and
  the pre-0114 in-kernel accessor give a byte-identical event log and an equal surface fold.
