# @loom/sdk — the public barrel

One import for the surface most apps use, so an application depends on a single package instead of a
dozen. It adds nothing of its own: every symbol is re-exported from its owning package, which is where it
is documented, and a symbol that is not re-exported is not in the barrel. The composition root is not in
it: `defineConfig` comes from `@loom/app`. Use it when you want one dependency and short imports. Import
an individual package when you want a narrower dependency or a symbol the barrel leaves out.

```ts
import { z } from "zod";
import { flow$, handler$, step$ } from "@loom/sdk";
import type { FlowRunner, RegisteredFlow } from "@loom/sdk";
import { sqliteStorage } from "@loom/sdk/sqlite"; // native dependency, so it sits behind a subpath
import { defineConfig } from "@loom/app"; // the composition root is its own package, not in the barrel

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

- **Kernel and runtime.** `@loom/core`, `@loom/workflow-runtime`, `@loom/orchestration`, plus the event
  and snapshot SPI types and their in-memory stores (`InMemoryAsyncEventStore`,
  `InMemoryAsyncSnapshotStore`).
- **UI.** `@loom/blueprint-runtime`, `@loom/projection-runtime`, `@loom/agent-surface` and
  `@loom/plugin-renderer-terminal`.
- **Agents.** `@loom/llm`, `@loom/reasoning`, `@loom/agent`, `@loom/plugin-mcp`, `@loom/plugin-a2a`, and
  `AgentRegistry` and `globalAgentRegistry` from `@loom/registry`.
- **Intelligence pipeline.** `@loom/capability`, `@loom/intent`, `@loom/planner`, `@loom/memory`,
  `@loom/knowledge`.
- **Subpaths.** `@loom/sdk/sqlite` (`sqliteStorage` and the SQLite stores), `@loom/sdk/postgres`
  (`postgresStorage` and the Postgres stores) and `@loom/sdk/sandbox` (the QuickJS backend and
  `sandboxEval$`, plus the sandbox backend SPI).

## Behaviour that surprises people

- **The native and WASM dependencies are behind subpaths** so a bare `@loom/sdk` import stays lean and
  browser-safe (ADR 0043, ADR 0064): SQLite, Postgres and the QuickJS sandbox load only when you import
  their subpath.
- **Subpaths need a modern module resolution.** They resolve through the package's `exports`. With
  `moduleResolution: "node"` (the old `node10` mode) TypeScript reports the subpath as unresolved; use
  `node16`, `nodenext` or `bundler`.
- **`DecideFn` comes from `@loom/reasoning` only.** `@loom/memory`, `@loom/knowledge` and
  `@loom/reasoning` each define a `DecideFn` of the same shape as `ctx.decide`, and re-exporting more than
  one would collide in this barrel. The other two leave theirs out; pass `ctx.decide` directly.
- **Much is not in the barrel.** `defineConfig` (`@loom/app`), `EffectRuntime`, `tainted` and the
  classification marks (`@loom/classify`), `LocalDispatcher`, `executeGraph`, `foldEvents` and
  `createTelemetryHook` are all absent. Import those packages directly.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loom/sdk` — the public barrel" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [getting started](../../docs/getting-started.md), [usage guide](../../docs/usage.md), [plugins](../../docs/plugins.md).
- ADRs: [0043 plugin packaging and 1P/3P separation](../../docs/adr/0043-plugin-packaging-and-1p-3p-separation.md), [0064 sandbox eval plugin](../../docs/adr/0064-sandbox-eval-plugin.md) (the QuickJS sandbox subpath).
- Source: `packages/sdk/src`.
