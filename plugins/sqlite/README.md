# @loom/plugin-sqlite

The zero-server durable backend for Loom. It implements the storage SPIs on embedded SQLite (via
`better-sqlite3`): `SqliteEventStore`, `SqliteSnapshotStore`, `SqliteBranchRegistry`,
`SqliteTimerStore`, `SqliteLeaseStore`, `SqliteDurableStateStore`, `SqliteReadModelStore`,
`SqliteContentStore` and `SqliteMemoryStore`, behind the same interfaces as the in-memory
reference. The native driver lives here so the kernel packages stay free of it.

## When to use it

- Local development, demos and the CLI: `loom logs`, `loom debug` and friends read the `.db` files it
  writes.
- Single-node production where one machine owns the log.
- Not for multi-node deployments: SQLite leases have `host` scope (one machine). Use
  [`@loom/plugin-postgres`](../postgres/README.md) for a shared log.

## Install

Not published to npm yet: `"@loom/plugin-sqlite": "workspace:*"` in this workspace, or a `link:`
override from a sibling checkout (see [AGENTS.md](../../AGENTS.md)). `better-sqlite3` is a native
module, so `pnpm install` must be allowed to build it.

## Entry points

`@loom/plugin-sqlite` (single entry). The one most apps use is the preset
`sqliteStorage({ dir?, branching? })`; the store classes are exported for hand-wiring and tests.

## Example

```ts
import { defineConfig } from "@loom/app";
import { sqliteStorage } from "@loom/plugin-sqlite";

const app = defineConfig({
  storage: sqliteStorage({ dir: ".loom", branching: true }),
  surfaces: ["default"],
  flows: [],
});
// ... run flows; the log is in .loom/events.db (snapshots.db, branches.db alongside)
await app.close();
```

## Key concepts

- `dir` defaults to `.loom`; the preset creates `events.db`, `snapshots.db` and (with
  `branching: true`) `branches.db`.
- The preset also exposes a `leaseStore` over the same `events.db`, so heartbeat leases and the log
  share one failure domain. `defineConfig` picks it up automatically.
- Point the CLI at the file: `npx loom logs --db .loom/events.db <executionId>`.
- `SqliteMemoryStore` and `SqliteContentStore` back `memoryStore` and the content seam
  ([ADR 0046](../../docs/adr/0046-content-store-seam-thin-authoritative-log.md)).
- A storage backend is a preset, never a `kind`
  ([ADR 0043](../../docs/adr/0043-plugin-packaging-and-1p-3p-separation.md)); the SPIs are verified by
  [`@loom/conformance`](../../packages/conformance/README.md).

## See also

- [API reference: `@loom/plugin-sqlite`](../../docs/api-reference.org) (single-node durability).
- [User guide, section 9: Configuration reference](../../docs/user-guide.md#9-configuration-reference),
  [plugins](../../docs/plugins.md), [getting started, section 5](../../docs/getting-started.md).
- [`@loom/plugin-postgres`](../postgres/README.md), [`@loom/app`](../../packages/app/README.md).
