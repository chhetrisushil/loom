# @loomwork/plugin-kit — authoring a storage preset

The type contract a storage plugin returns, so its wiring is checked by the compiler. A storage preset is
a function from your options to a `custom` storage descriptor (`CustomStorage`: an event store, a snapshot
store, and optionally a branch registry and an archive store) that an app passes as
`defineConfig({ storage })`. The package depends only on the event and snapshot store interface packages,
never on `@loomwork/app`, so a plugin can be typed against the contract without pulling in the composition
layer or creating a dependency cycle. You use it when you write a backend, such as the SQLite and Postgres
plugins do. Apps do not import it.

```ts
import { defineConfig } from "@loomwork/app";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { defineStoragePreset } from "@loomwork/plugin-kit";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { helloFlow } from "./config"; // any registered flow

// A plugin's preset: options in, a `custom` storage descriptor out. Swap the in-memory stores
// for your own EventStore and SnapshotStore implementations.
export const scratchStorage = defineStoragePreset((_options: { label: string }) => ({
  kind: "custom",
  eventStore: new InMemoryAsyncEventStore(),
  snapshotStore: new InMemoryAsyncSnapshotStore(),
}));

// The preset's result is the `storage` value; the app wires it like a first-party backend.
export const app = defineConfig({ storage: scratchStorage({ label: "test" }), flows: [helloFlow] });
```

## Surface

- **`CustomStorage`:** `kind: "custom"`, `eventStore`, `snapshotStore`, and optional `branchRegistry` and
  `archiveStore`. It is structurally the same as the `custom` arm of `@loomwork/app`'s `StorageConfig`,
  declared here so plugins need not depend on the app.
- **`StoragePreset<Options>`:** `(options) => CustomStorage`; `Options` defaults to `void` for a preset
  with no arguments.
- **`defineStoragePreset(fn)`:** an identity helper that pins `fn` to that contract, so `options` is
  inferred and a returned shape that drifts is a type error.

## Behaviour that surprises people

- **A preset with no `archiveStore` cannot compact.** Compaction moves the events it removes into the
  archive, and without one it refuses, failing closed (ADR 0138). A durable preset should supply one beside
  its event store. `@loomwork/conformance` has kits to prove each store.
- **There is no privileged `kind`.** First-party and third-party backends are wired the same way, as a
  preset returning `custom` storage (ADR 0043). `{ kind: "memory" }` is the only built-in alternative.
- **A preset may return more than `CustomStorage`.** `sqliteStorage` returns the descriptor plus a
  `leaseStore` accessor (the heartbeat-lease store beside the event store), typed as
  `CustomStorage & { leaseStore: LeaseStore }`.
- **Name the contract type; do not copy its shape.** An imported `CustomStorage` turns a contract change
  into a compile error where a copied shape would silently stop matching.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/plugin-kit` — authoring a storage preset" in [docs/api-reference.org](../../docs/api-reference.org). It lists `CustomStorage` without `archiveStore`, which the source has.
- Guide: [plugins, authoring a plugin (worked example: a storage backend)](../../docs/plugins.md#authoring-a-plugin-worked-example-a-storage-backend).
- ADRs: [0043 plugin packaging and 1P/3P separation](../../docs/adr/0043-plugin-packaging-and-1p-3p-separation.md), [0138 compaction archives](../../docs/adr/0138-compaction-archives-what-it-removes.md), [0033 SPI conformance](../../docs/adr/0033-spi-conformance-contracts.md).
- Source: `packages/plugin-kit/src`. Real presets: [`@loomwork/plugin-sqlite`](../../plugins/sqlite/README.md), [`@loomwork/plugin-postgres`](../../plugins/postgres/README.md).
