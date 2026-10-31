import type { LeaseStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import type { SnapshotCodecName } from "@loom/snapshot-runtime";
import type { Pool, PoolConfig } from "pg";
import { PostgresArchiveStore } from "./PostgresArchiveStore";
import { PostgresBranchRegistry } from "./PostgresBranchRegistry";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresLeaseStore } from "./PostgresLeaseStore";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import { type PgConfig, toPool } from "./pool";

export interface PostgresStorageOptions {
  /** Standard `postgres://…` connection string, or a `PgConfig` pool spec. */
  url: PgConfig;
  /** Also provision a branch registry for fork/branch. */
  branching?: boolean;
  /**
   * NOTIFY buckets for interest-filtered cross-node delivery — see
   * {@link PostgresEventStore}'s options. Every node on the database must agree. Default 16.
   */
  notifyBuckets?: number;
  /**
   * L10 / ADR 0108 D3 — how long the one-time `events.execution_id` collation conversion may
   * wait for its table lock at boot (default 2000 ms; it gives up with a WARNING). The preset
   * builds the event store first on its shared pool, so this value is the one that migrates.
   */
  migrationLockTimeoutMs?: number;
  /** ADR 0118 D1 — run the one-time park-fence backfill at boot (default `true`); see {@link PostgresEventStore}. */
  backfillParkFences?: boolean;
  /** ADR 0136 — opt in to lz4 for `snapshots.state` (default `"default"`); see `MigrateOptions.snapshotCompression`. */
  snapshotCompression?: "lz4" | "default";
  /**
   * ADR 0140 - opt in to zstd-compressed snapshot states in a `snapshots.state_z BYTEA` column (default
   * `"none"`: JSONB, schema untouched). Needs Node >= 22.15 (throws at construction otherwise). The column
   * is provisioned at boot, fail soft (one warning, JSONB writes continue). Old snapshots stay readable and
   * are never rewritten; see `PostgresSnapshotStoreOptions.codec`.
   */
  snapshotCodec?: SnapshotCodecName;
}

/**
 * A `defineConfig({ storage })` preset for network-backed Postgres. Returns a
 * `custom` storage descriptor with the Postgres stores constructed — so `@loom/app`
 * never depends on `pg` (ADR 0043: storage backends are symmetric presets, so a
 * third-party backend is wired exactly like this first-party one).
 *
 * **One pool, shared by every store.** Each store used to build its own from the same
 * connection string, so this preset opened three — three times the connections per node,
 * against a `max_connections` that binds well before throughput does at scale. Sharing also
 * removes the concurrent-migration race those separate pools created (fixed independently
 * in `schema.ts`, but there is no reason to keep provoking it).
 *
 * Ownership: the pool is built here, so `eventStore.close()` — which owns only what it was
 * handed — will not end it. The returned descriptor's stores share one lifetime; close the
 * event store to release the stores, and the pool is ended alongside it.
 *
 * `leaseStore` (ADR 0130 D11) is the heartbeat-lease store CO-LOCATED with the event store: the
 * same pool and database, so a multi-node deployment gets cluster-visible leases with no extra
 * config and the lease and the log share one failure domain. An accessor on the factory's
 * result (no `EventStore` SPI change); `defineConfig` does not read it yet.
 */
export function postgresStorage(
  options: PostgresStorageOptions
): CustomStorage & { leaseStore: LeaseStore } {
  const { pool, owned } = toPool(options.url);
  const eventStore = new PostgresEventStore(pool, {
    ...(options.notifyBuckets !== undefined && { notifyBuckets: options.notifyBuckets }),
    ...(options.migrationLockTimeoutMs !== undefined && {
      migrationLockTimeoutMs: options.migrationLockTimeoutMs,
    }),
    ...(options.backfillParkFences !== undefined && {
      backfillParkFences: options.backfillParkFences,
    }),
    ...(options.snapshotCompression !== undefined && {
      snapshotCompression: options.snapshotCompression,
    }),
  });
  const snapshotStore = new PostgresSnapshotStore(pool, {
    ...(options.snapshotCodec !== undefined && { codec: options.snapshotCodec }),
    ...(options.migrationLockTimeoutMs !== undefined && {
      migrationLockTimeoutMs: options.migrationLockTimeoutMs,
    }),
  });
  const archiveStore = new PostgresArchiveStore(pool);
  const leaseStore = new PostgresLeaseStore(pool);
  const branchRegistry = options.branching === true ? new PostgresBranchRegistry(pool) : undefined;

  if (owned) {
    // We created the pool, so we are responsible for ending it. Wrap the event store's
    // close (the one an app calls) to release the shared pool exactly once, after every
    // store that borrows it is done.
    const closeStores = eventStore.close.bind(eventStore);
    eventStore.close = async () => {
      await closeStores();
      await snapshotStore.close();
      await archiveStore.close();
      await leaseStore.close();
      await branchRegistry?.close?.();
      await pool.end();
    };
  }

  return {
    kind: "custom",
    eventStore,
    snapshotStore,
    archiveStore,
    leaseStore,
    ...(branchRegistry !== undefined && { branchRegistry }),
  };
}

/**
 * Build a shared pool for callers assembling the Postgres stores by hand.
 *
 * No longer load-bearing for cross-copy wiring — the stores accept any structurally
 * compatible pool now, so a consumer that resolves its own `pg` can pass that pool
 * directly (see `toPool`). What this still gives you is a real `pg.Pool` from THIS
 * package: `totalCount`/`idleCount` and the rest of the surface `PoolLike` deliberately
 * omits, for a caller that wants to instrument or size the pool it shares.
 *
 * Takes connection parameters rather than a {@link PgConfig}: handing it an existing pool
 * was only ever an identity function, and accepting one would force the return type down
 * to `PoolLike`, losing exactly the surface this exists to expose.
 */
export function postgresPool(config: string | PoolConfig): Pool {
  return toPool(config).pool as Pool;
}
