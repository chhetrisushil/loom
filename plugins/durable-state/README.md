# @loomwork/plugin-durable-state — typed, versioned state that survives between runs

Keyed state that a bounded run loads at the start and saves at the end, for work that wakes on a
schedule and has to remember something between wakes (a cursor, a watermark, counters). Each value has
a zod schema and a contract version, older versions are migrated on load, and writes are
compare-and-set on a revision. `load`, `save` and `clear` run as recorded effects, so on replay the
recorded result is used and the store is not read again (ADR 0053). Use it directly for any
carried state, or through `sentinelState` for a `schedule$`-driven agent.

```ts
import { defineConfig } from "@loomwork/app";
import { flow$ } from "@loomwork/core";
import { InMemoryDurableStateStore, durableState } from "@loomwork/plugin-durable-state";
import type { FlowRunner, RegisteredFlow } from "@loomwork/workflow-runtime";
import { z } from "zod";

const watcher = durableState({
  id: "watcher.state",
  version: 2,
  schema: z.object({ cursor: z.string(), failures: z.number() }),
  // migrations[n] turns a version-n payload into version n+1
  migrations: { 1: (old) => ({ ...(old as { cursor: string }), failures: 0 }) },
  store: new InMemoryDurableStateStore(), // use SqliteDurableStateStore / PostgresDurableStateStore to persist
});

const runner: FlowRunner<unknown, { cursor: string }> = async (ctx) => {
  const loaded = await watcher.load(ctx, "tenant-1"); // { found, value, revision, migrated, ... }
  const next = { cursor: "next-page", failures: loaded.value?.failures ?? 0 };
  await watcher.save(ctx, "tenant-1", next, loaded.revision); // revision 0 means "create"
  return { cursor: next.cursor };
};

const io = z.object({}).passthrough();
const flow: RegisteredFlow = {
  definition: flow$({ id: "watch", name: "Watch", version: "1.0.0", inputSchema: io, outputSchema: z.any(), steps: [] }),
  runner: runner as FlowRunner<unknown, unknown>,
};

export const app = defineConfig({
  storage: { kind: "memory" },
  flows: [flow],
  execution: { registerEffects: (effects) => watcher.register(effects) },
});
```

## Surface

- **`durableState(config)`** returns a handle with `load(ctx, key)`, `save(ctx, key, value, expectedRevision)`,
  `clear(ctx, key)`, `register(effects)`, and the underlying `tasks`, `effects` and `toolIds`
  (`<id>.load`, `<id>.save`, `<id>.clear`). Register the effects at the composition root before a flow
  calls them. Pass `{ stepId }` for a second load or save of the same handle in one run.
- **`sentinelState(config)`** derives the key `sentinel:<scheduleId>` from a `schedule$` definition and
  exposes `load(ctx)`, `save(ctx, value, expectedRevision)` and `clear(ctx)` without the key argument.
- **Stores.** `DurableStateStore` is the SPI: `load`, `save` with an expected revision, `clear`.
  `InMemoryDurableStateStore` is here; durable ones are `SqliteDurableStateStore`
  (`@loomwork/plugin-sqlite`) and `PostgresDurableStateStore` (`@loomwork/plugin-postgres`).
- **Errors.** `RevisionConflictError` and `StateContractMismatchError` (reasons: `no-migration-path`,
  `migration-failed`, `future-version`, `validation-failed`).

## Behaviour that surprises people

- **A bad contract fails loudly.** A missing migration step, a migration that throws, a stored version
  newer than yours, or a payload that fails the current schema all throw `StateContractMismatchError`;
  state is never coerced. A `save` also validates against the schema before writing.
- **Migrating on load does not rewrite the stored value.** `load` reports `migrated: { from, to }`; the
  stored envelope changes on your next `save`.
- **Conflicts are not retried for you.** A stale `expectedRevision` throws `RevisionConflictError`.
  The exception is a crash-recovery re-run of a `save` that already committed, which is adopted when
  the stored envelope equals what it tried to write.
- **This is not `memory$`.** It is journaled step output, so a read during replay returns what the
  original run saw, even if the store has changed since.

## Status / See also

`npm install @loomwork/plugin-durable-state` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

- [ADR 0053](../../docs/adr/0053-durable-state-plugin.md) and
  [ADR 0051](../../docs/adr/0051-perpetual-agents-placement-schedule-remodel.md): the design.
- `@loomwork/plugin-sentinel` bundles this with a schedule and claim-checked telemetry.
- API reference: section "`@loomwork/plugin-durable-state` — carry state across wakes" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/plugins.md](../../docs/plugins.md), [docs/user-guide.md](../../docs/user-guide.md).
