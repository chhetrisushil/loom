# @loom/plugin-postgres

The horizontal-scale storage backend for Loom. It implements the storage SPIs on Postgres
(`pg`): `PostgresEventStore` with cross-node live subscribe over LISTEN/NOTIFY,
`PostgresSnapshotStore`, `PostgresBranchRegistry`, `PostgresLeaseStore`, `PostgresTimerStore`,
`PostgresDurableStateStore`, `PostgresReadModelStore` and `PostgresMemoryStore`, behind the same
interfaces as the SQLite stores. Schema is created and migrated on first connect.

## When to use it

Multi-node or shared deployments, where several processes drive executions against one log and need
cluster-visible heartbeat leases. For one machine or local work,
[`@loom/plugin-sqlite`](../sqlite/README.md) is simpler.

## Install

Not published to npm yet: add `"@loom/plugin-postgres": "workspace:*"` in this workspace (the
create-loom-app scaffold does not include it), or a `link:` override from a sibling checkout (see
[AGENTS.md](../../AGENTS.md)). `pg` is its own dependency, so the kernel packages never load it.

## Entry points

`@loom/plugin-postgres` (single entry): the preset `postgresStorage`, `postgresPool` for callers
assembling stores by hand, the store classes, `migratePostgresStores` (run the migration as a deploy
step), `backfillParkFences`, `LEASE_EXPIRED_SQL`, and the types `PgConfig`, `PoolLike`.

## Example

```ts
import { defineConfig } from "@loom/app";
import { postgresStorage } from "@loom/plugin-postgres";

const app = defineConfig({
  storage: postgresStorage({ url: process.env.DATABASE_URL ?? "", branching: true }),
  surfaces: ["default"],
  flows: [],
  durability: { heartbeat: { ttlMs: 30_000 } }, // optional: these are the defaults
});
// at shutdown: closing the event store also ends the pool the preset created
await app.stores.eventStore.close?.();
```

## Key concepts and options

- **`url`** is a `postgres://` string, a `PoolConfig`, or an already-built pool (a pool you pass in is
  never ended by Loom). One pool is shared by every store.
- **`branching`** adds the branch registry for fork/simulate/promote.
- **`notifyBuckets`** (default 16) sets the NOTIFY buckets for interest-filtered cross-node delivery;
  it must be identical on every node of the database.
- **`migrationLockTimeoutMs`** and **`backfillParkFences`** tune boot-time migrations.
- **Co-located leases.** The preset's `leaseStore` shares the pool and database, so `defineConfig`
  gives a multi-node deployment cluster-visible heartbeat leases with no extra config.
- **Fail-closed writes.** A write that cannot be made durable fails the run (`StorageWriteError`).
- Pool sizing, backups, failure recovery and the pre-flight checklist (`loom doctor`):
  [operations.md](../../docs/operations.md#1-postgres-store); scaling past one log:
  [scaling.md](../../docs/scaling.md).
- Running this package's tests needs a database: set `LOOM_TEST_POSTGRES_URL` (CI does).

## See also

- [API reference: `@loom/plugin-postgres`](../../docs/api-reference.org) (scale-out storage).
- [Operations runbook](../../docs/operations.md), [plugins](../../docs/plugins.md),
  [getting started, section 7](../../docs/getting-started.md).
- [ADR 0043](../../docs/adr/0043-plugin-packaging-and-1p-3p-separation.md),
  [ADR 0130](../../docs/adr/0130-sealed-payload-delivery-guard.md).
- [`@loom/plugin-sqlite`](../sqlite/README.md), [`@loom/app`](../../packages/app/README.md).
