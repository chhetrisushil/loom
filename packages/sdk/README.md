# @loomwork/sdk — the public barrel

One import for the surface most apps use, so an application depends on a single package instead of a
dozen. It adds nothing of its own: every symbol is re-exported from its owning package, which is where it
is documented, and a symbol that is not re-exported is not in the barrel. The composition root is not in
it: `defineConfig` comes from `@loomwork/app`. Use it when you want one dependency and short imports. Import
an individual package when you want a narrower dependency or a symbol the barrel leaves out.

```ts
import { z } from "zod";
import { flow$, handler$, step$ } from "@loomwork/sdk";
import type { FlowRunner, RegisteredFlow } from "@loomwork/sdk";
import { sqliteStorage } from "@loomwork/sdk/sqlite"; // native dependency, so it sits behind a subpath
import { defineConfig } from "@loomwork/app"; // the composition root is its own package, not in the barrel

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
    id: "hello", name: "Hello", version: "1.0.0",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    steps: [greetStep],
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};

export const app = defineConfig({ storage: sqliteStorage({ dir: ".data" }), flows: [helloFlow] });
```

## Surface

- **Kernel and runtime.** `@loomwork/core`, `@loomwork/workflow-runtime`, `@loomwork/orchestration`, plus the event
  and snapshot SPI types and their in-memory stores (`InMemoryAsyncEventStore`,
  `InMemoryAsyncSnapshotStore`).
- **UI.** `@loomwork/blueprint-runtime`, `@loomwork/projection-runtime`, `@loomwork/agent-surface` and
  `@loomwork/plugin-renderer-terminal`.
- **Agents.** `@loomwork/llm`, `@loomwork/reasoning`, `@loomwork/agent`, `@loomwork/plugin-mcp`, `@loomwork/plugin-a2a`, and
  `AgentRegistry` and `globalAgentRegistry` from `@loomwork/registry`.
- **Intelligence pipeline.** `@loomwork/capability`, `@loomwork/intent`, `@loomwork/planner`, `@loomwork/memory`,
  `@loomwork/knowledge`.
- **Subpaths.** `@loomwork/sdk/sqlite` (`sqliteStorage` and the SQLite stores), `@loomwork/sdk/postgres`
  (`postgresStorage` and the Postgres stores) and `@loomwork/sdk/sandbox` (the QuickJS backend and
  `sandboxEval$`, plus the sandbox backend SPI).

## Behaviour that surprises people

- **The native and WASM dependencies are behind subpaths** so a bare `@loomwork/sdk` import stays lean and
  browser-safe (ADR 0043, ADR 0064): SQLite, Postgres and the QuickJS sandbox load only when you import
  their subpath.
- **Subpaths need a modern module resolution.** They resolve through the package's `exports`. With
  `moduleResolution: "node"` (the old `node10` mode) TypeScript reports the subpath as unresolved; use
  `node16`, `nodenext` or `bundler`.
- **`DecideFn` comes from `@loomwork/reasoning` only.** `@loomwork/memory`, `@loomwork/knowledge` and
  `@loomwork/reasoning` each define a `DecideFn` of the same shape as `ctx.decide`, and re-exporting more than
  one would collide in this barrel. The other two leave theirs out; pass `ctx.decide` directly.
- **Much is not in the barrel.** `defineConfig` (`@loomwork/app`), `EffectRuntime`, `tainted` and the
  classification marks (`@loomwork/classify`), `LocalDispatcher`, `executeGraph`, `foldEvents` and
  `createTelemetryHook` are all absent. Import those packages directly.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/sdk` — the public barrel" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [getting started](../../docs/getting-started.md), [usage guide](../../docs/usage.md), [plugins](../../docs/plugins.md).
- ADRs: [0043 plugin packaging and 1P/3P separation](../../docs/adr/0043-plugin-packaging-and-1p-3p-separation.md), [0064 sandbox eval plugin](../../docs/adr/0064-sandbox-eval-plugin.md) (the QuickJS sandbox subpath).
- Source: `packages/sdk/src`.
