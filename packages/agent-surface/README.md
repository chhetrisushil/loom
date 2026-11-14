# @loomwork/agent-surface

Loom's event-sourced patch protocol for durable, replayable UI surfaces.

## `ctx.ui` and `surface(ctx)` (ADR 0114)

The kernel no longer knows about UI. This package types `ctx.ui` by merging into
`@loomwork/workflow-runtime`'s `ExecutionContextExtensions`, so `ctx.ui` type-checks wherever
agent-surface is in the program. Composed apps (`@loomwork/app`) get it automatically; a bare
`WorkflowRuntime` user imports `@loomwork/agent-surface` (or `@loomwork/sdk`) and either passes
`surface: createSurfaceEmitter` in the runtime deps or writes `surface(ctx).set(...)`.

## `@loomwork/workflow-runtime` is an optional peer

The augmentation is a `declare module "@loomwork/workflow-runtime"`. Consumers WITHOUT workflow-runtime
installed type-check fine under the default `skipLibCheck: true`. Under `skipLibCheck: false` they get
`TS2307: Cannot find module '@loomwork/workflow-runtime'` from `dist/context.d.ts`: install
`@loomwork/workflow-runtime` (it is a peer for exactly this reason).
