# @loomwork/plugin-read-model

Durable, queryable indexes over the event log, across executions. The log is the only authority and has no
cross-execution query; a read model is a cache of it with a watermark, so you can drop one and rebuild it
by re-scanning. There are two kinds. A **row model** turns each matching event into indexed rows you query
by equality (for example "high-severity findings for this target"). A **folded model** keeps one durable
state per execution, produced by a `projection$` reducer, and is read by execution id or app key (ADR
0058, ADR 0132). Durable backends are `SqliteReadModelStore` (`@loomwork/plugin-sqlite`) and
`PostgresReadModelStore` (`@loomwork/plugin-postgres`).

```ts
import { defineConfig } from "@loomwork/app";
import { projection$ } from "@loomwork/core";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryReadModelStore, ReadModelService } from "@loomwork/plugin-read-model";

const events = new InMemoryAsyncEventStore();
const models = new ReadModelService(new InMemoryReadModelStore(), {
  onError: (err, event) => console.warn("read model apply failed", event.id, err),
});

// Row model: one indexed row per matching event.
models.register({
  id: "findings-by-target",
  version: "1",
  kinds: ["FINDING_RECORDED"],
  indexes: ["target", "severity"],
  extract: (e) => {
    const p = e.payload as { target: string; severity: string };
    return [{ fields: { target: p.target, severity: p.severity } }];
  },
});

// Folded model: one durable state per execution.
const ready = models.registerFolded({
  projection: projection$<{ steps: number }>({
    id: "progress",
    name: "Progress",
    version: "1",
    initialState: { steps: 0 },
    handlers: { STEP_COMPLETED: (s) => ({ steps: s.steps + 1 }) },
  }),
});

export const app = defineConfig({
  storage: { kind: "custom", eventStore: events },
  observability: { onEvent: (e) => models.handleEvent(e) }, // the live tail
});

export async function read(executionIds: string[]) {
  await ready;
  await models.catchUp([events]); // restart recovery, other nodes, archives
  const high = await models.query("findings-by-target", { where: { severity: "high" }, limit: 50 });
  const states = await models.getMany<{ steps: number }>("progress", executionIds);
  return { high: high.rows, states };
}
```

## Surface

- **Service.** `ReadModelService`: `register`, `registerFolded`, `handleEvent`, `catchUp`, `rebuild`,
  `drain`, and the pins `pins()` / `checkPins()` for declared versions (ADR 0095).
- **Reads.** `query` (keyset cursor, optional `kind` and `where`) for rows; `getMany`, `getManyByKey` and
  `refresh` for folded states.
- **Erasure.** `purge(modelId, where)` for rows, `purgeFolded(modelId, selector)` for folded states.
- **Stores.** `InMemoryReadModelStore`; `ReadModelStore` is the SPI (`READ_MODEL_STORE_SPI_VERSION`
  1.2.0), proven by `runReadModelStoreConformance` in `@loomwork/conformance`.

## Behaviour that surprises people

- **A cache, not an authority.** Ingestion converges from any mix of live tail, catch-up and several
  nodes, because rows apply idempotently by row id and watermarks only move forward. Queries are never
  recorded, so replay never touches a read model.
- **Live ingestion cannot fail the run.** `handleEvent` fans out synchronously and applies
  asynchronously; errors go to `onError`. Without one the default rethrows asynchronously. `catchUp`
  errors throw to you, and a source that cannot enumerate executions makes the scan refuse.
- **Changing an extractor is silent.** The watermark is already past the old events, so only `rebuild`
  re-derives rows. Declare a `version` and compare it with `pins()`. A folded model requires `version`, and
  changing it (or its sensitive map) drops its state on `registerFolded`; the next `catchUp` re-folds it.
- **Folded models fold one execution at a time, in sequence order, with no gaps.** A hole in the live
  tail (a restart mid-run) raises `FoldGapError` unless a `liveSource` fills it; `catchUp` heals it.
  `keyOf` and `scopeOf` see only the execution id, never event data. A handler returning `null` or
  `undefined` is refused.
- **`getMany` always reads the store.** The per-node fold cache serves only the live write path
  (default 1024 entries; `foldCache: false` turns it off). At most 1,000 keys per call, else `RangeError`.
- **Handlers get a masked event.** Paths in the `sensitive` map arrive as `"[redacted]"`, and a state
  that still holds a sealed value is refused with `SensitiveStateError`, which never carries the value.
- **Erasure is narrow.** `purge` needs a backend that implements it (else `PurgeUnsupportedError`),
  refuses an empty filter and leaves watermarks alone. `purgeFolded` tombstones, but a `rebuild` can
  re-derive from a log that still holds the plaintext. To make an erasure survive a rebuild, shred the log
  itself. Clearing a whole model is the only other removal and costs a re-scan of the log.

## See also

- API reference: section "`@loomwork/plugin-read-model` — durable cross-execution indexes" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [log and read models](../../docs/user-guide/log-and-read-models.md).
- ADRs: [0058 read-model plugin](../../docs/adr/0058-read-model-plugin.md),
  [0132 folded-state read model](../../docs/adr/0132-folded-state-read-model.md),
  [0095 binding-semantics pin](../../docs/adr/0095-binding-semantics-pin.md).

## Install

`npm install @loomwork/plugin-read-model` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).
