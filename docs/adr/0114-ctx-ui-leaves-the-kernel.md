# ADR 0114 — `ctx.ui` leaves the kernel

- Status: **Proposed** (2026-10-05)
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
choice was an open question (design document §7 question 2). **Decided (default, pending user
confirmation): accept the break now.** The monorepo is lockstep and unpublished, so nothing outside it
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
