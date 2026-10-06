# @loom/agent-surface

Loom's event-sourced patch protocol for durable, replayable UI surfaces.

## `ctx.ui` and `surface(ctx)` (ADR 0114)

The kernel no longer knows about UI. This package types `ctx.ui` by merging into
`@loom/workflow-runtime`'s `ExecutionContextExtensions`, so `ctx.ui` type-checks wherever
agent-surface is in the program. Composed apps (`@loom/app`) get it automatically; a bare
`WorkflowRuntime` user imports `@loom/agent-surface` (or `@loom/sdk`) and either passes
`surface: createSurfaceEmitter` in the runtime deps or writes `surface(ctx).set(...)`.

## `@loom/workflow-runtime` is an optional peer

The augmentation is a `declare module "@loom/workflow-runtime"`. Consumers WITHOUT workflow-runtime
installed type-check fine under the default `skipLibCheck: true`. Under `skipLibCheck: false` they get
`TS2307: Cannot find module '@loom/workflow-runtime'` from `dist/context.d.ts`: install
`@loom/workflow-runtime` (it is a peer for exactly this reason).
