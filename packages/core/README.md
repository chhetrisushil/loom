# @loom/core

The authoring layer of Loom: the types and the declarative `$` builders (`flow$`, `step$`,
`handler$`, `tool$`, `agent$`, `skill$`, `projection$`, `policy$`, `schedule$`, `memory$`) that
describe a durable workflow as plain, serializable data. `@loom/core` has no runtime behaviour of its
own: it defines the vocabulary (definitions, the `EventEnvelope`, `Execution` state, typed errors,
content hashes) that every other package builds on. The code that actually runs a definition lives
in [`@loom/workflow-runtime`](../workflow-runtime/README.md).

## When to use it

- You are writing flows, steps, tools or agents. Every Loom app imports its builders from here.
- You are writing a package or plugin that needs the shared types (`EventEnvelope`, `ExecutionState`,
  `FlowDefinition`, `StepError`, ...) without pulling in a runtime.

Most apps get the rest of the framework through [`@loom/app`](../app/README.md)'s `defineConfig`;
`@loom/core` is the one package you import in every flow file.

## Install

Loom's `@loom/*` packages are not published to npm yet (publishing is deferred). Inside this repo's
pnpm workspace depend on it as `"@loom/core": "workspace:*"`. From a sibling checkout (for example
`loom-examples`) use a `link:` path override to `../loom/packages/core`; see
[AGENTS.md](../../AGENTS.md) and [getting-started](../../docs/getting-started.md#1-scaffold-an-app).

## Entry points

`package.json` `exports`: a single entry, `@loom/core`, with CommonJS (`dist/index.js`) and ESM
(`dist/esm/index.js`) builds and types (`dist/index.d.ts`). The package is `sideEffects: false`.

## Example

```ts
import { z } from "zod";
import { flow$, handler$, step$ } from "@loom/core";

const greetStep = step$({
  id: "greet",
  name: "Greet",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  handler: handler$(async (input: { name: string }) => ({ message: `Hello, ${input.name}!` })),
});

export const helloFlow = flow$({
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  steps: [greetStep],
});
```

A definition is only data. To run it, pair it with a runner function (`async (ctx, input) => ...`)
and register it; see [`@loom/workflow-runtime`](../workflow-runtime/README.md) and
[`@loom/app`](../app/README.md).

## Key concepts

- **Builders** return plain objects tagged with `_tag`; they are hashable and safe to serialize.
  `flowContentHash` / `flowHashMatches` / `canonicalJson` give a flow a stable content address, and
  `checkVersionPins` verifies pinned versions (see
  [ADR 0095](../../docs/adr/0095-binding-semantics-pin.md)).
- **`handler$`** wraps the function a `step$` runs, so the compiler (`@loom/compiler`) can extract it
  and a resumed process can load it lazily.
- **Typed failures**: `StepError`, `SuspendError`, `StorageWriteError`, `fail`, `exposeError` and the
  `TypedFailure` shape; see [ADR 0060](../../docs/adr/0060-typed-failure-channels.md).
- **State is a fold**: `EventEnvelope`, `KERNEL_EVENT_KINDS` and `executionFromState` describe the log
  the runtime folds into an `Execution`.

Determinism rules for code inside flows: [user guide section 14](../../docs/user-guide.md#14-determinism-rules--pitfalls).

## See also

- [API reference: Authoring builders](../../docs/api-reference.org) (`@loom/core`).
- [User guide, section 1: Flows, steps and handlers](../../docs/user-guide.md#1-flows-steps--handlers)
  and [section 2: The ExecutionContext](../../docs/user-guide.md#2-the-executioncontext).
- [Getting started](../../docs/getting-started.md), [usage guide](../../docs/usage.md).
- [`@loom/app`](../app/README.md), [`@loom/workflow-runtime`](../workflow-runtime/README.md).
