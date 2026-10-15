# @loom/app

The composition root for a Loom app. `defineConfig` takes one static config object (storage, flows,
surfaces, skills, projections, and the grouped `security` / `observability` / `durability` /
`execution` / `checks` options) and assembles everything else: the durable `WorkflowRuntime`, the
`EffectRuntime` with its middleware, the projection runtime, the A2A bus, the timer service and the
heartbeat-lease wiring. The result is a `LoomApp`, and after boot the wiring is exactly what you
would have written by hand ([ADR 0006](../../docs/adr/0006-config-and-effect-middleware.md)).

## When to use it

Almost always. It is the supported way to build an app, and the scaffold from
[`@loom/create-loom-app`](../../tools/create-loom-app/README.md) already uses it. Construct
[`WorkflowRuntime`](../workflow-runtime/README.md) directly only if you are writing infrastructure
that needs a different composition.

## Install

Not published to npm yet. Inside this repo's workspace use `"@loom/app": "workspace:*"`; from a
sibling checkout use a `link:` override to `../loom/packages/app` (see
[AGENTS.md](../../AGENTS.md)). Storage backends are separate packages you add yourself:
[`@loom/plugin-sqlite`](../../plugins/sqlite/README.md) and
[`@loom/plugin-postgres`](../../plugins/postgres/README.md). The default is in-memory.

## Entry points

`package.json` `exports`: one entry, `@loom/app`. Main values: `defineConfig`, `normalizeConfig`,
`registerFlowsFrom`, `validateFlowGraph`, `manifestWarnings`, `approvalPayload`, `unsafeAutoApprove`,
`progressHub`, `runAgentOnce`. Types: `LoomConfig`, `LoomApp`, `LoomStores`, `StorageConfig` and the
option groups `SecurityOptions`, `ObservabilityOptions`, `DurabilityOptions`, `ExecutionOptions`,
`ChecksOptions`.

## Example

```ts
import { z } from "zod";
import { flow$, handler$, step$ } from "@loom/core";
import { defineConfig } from "@loom/app";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";

const greetStep = step$({
  id: "greet",
  name: "Greet",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string() }),
  handler: handler$(async (input: { name: string }) => ({ message: `Hello, ${input.name}!` })),
});

const runner: FlowRunner<{ name: string }, { message: string }> = async (ctx, input) =>
  ctx.run(greetStep, { name: input.name });

const helloFlow: RegisteredFlow = {
  definition: flow$({
    id: "hello",
    name: "Hello",
    version: "1.0.0",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    steps: [greetStep],
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};

const app = defineConfig({
  storage: { kind: "memory" }, // swap for sqliteStorage(...) / postgresStorage(...) to persist
  surfaces: ["default"],
  flows: [helloFlow],
});

const handle = await app.runtime.start(helloFlow, { name: "Ada" });
const state = await handle.waitForCompletion();
console.log(state.status, state.variables._output); // "completed" { message: "Hello, Ada!" }
await app.close();
```

## Key concepts and options

- **Grouped options.** Cross-cutting concerns are namespaced: `security` (authorizer, policies,
  secrets, resume authenticator, compliance), `observability` (telemetry, `onEvent`, `onWarn`,
  `onStorageError`), `durability` (`snapshotEvery`, `retention`, `heartbeat`), `execution`
  (dispatcher, `effectMiddleware`, `registerEffects`, envelope) and `checks`. The old flat
  spellings throw at `defineConfig` rather than being ignored.
- **`storage`** is `{ kind: "memory" }` or a `custom` descriptor returned by a preset.
- **`app.runtime`, `app.effectRuntime`, `app.projectionRuntime`, `app.stores`, `app.heartbeat`** are
  the pieces you reach into; `app.close()` shuts down timers and stores.
- **Folder convention.** `flowModules`, `toolModules`, `agentModules` etc. take the output of
  `loom gen`, so adding a flow is "add a file".
- **Strict mode** (`security.strict`) turns on the fail-closed defaults.
- Heartbeat leases and recovery are configured under `durability`; see
  [operations.md](../../docs/operations.md#2-heartbeat-leases).

## See also

- [User guide, section 9: Configuration reference](../../docs/user-guide.md#9-configuration-reference)
  and [section 3: Effects and middleware](../../docs/user-guide.md#3-effects--middleware).
- [API reference: Composition](../../docs/api-reference.org) (`@loom/app`).
- [Getting started](../../docs/getting-started.md), [usage guide](../../docs/usage.md),
  [plugins](../../docs/plugins.md), [operations runbook](../../docs/operations.md).
- [`@loom/core`](../core/README.md), [`@loom/workflow-runtime`](../workflow-runtime/README.md),
  [`@loom/effect-runtime`](../effect-runtime/README.md).
