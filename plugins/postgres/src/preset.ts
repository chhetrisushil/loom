import type { CustomStorage } from "@loom/plugin-kit";
import type { Pool } from "pg";
import { PostgresBranchRegistry } from "./PostgresBranchRegistry";
import { PostgresEventStore } from "./PostgresEventStore";
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
 */
export function postgresStorage(options: PostgresStorageOptions): CustomStorage {
  const { pool, owned } = toPool(options.url);
  const eventStore = new PostgresEventStore(pool, {
    ...(options.notifyBuckets !== undefined && { notifyBuckets: options.notifyBuckets }),
  });
  const snapshotStore = new PostgresSnapshotStore(pool);
  const branchRegistry = options.branching === true ? new PostgresBranchRegistry(pool) : undefined;

  if (owned) {
    // We created the pool, so we are responsible for ending it. Wrap the event store's
    // close (the one an app calls) to release the shared pool exactly once, after every
    // store that borrows it is done.
    const closeStores = eventStore.close.bind(eventStore);
    eventStore.close = async () => {
      await closeStores();
      await snapshotStore.close();
      await branchRegistry?.close?.();
      await pool.end();
    };
  }

  return {
    kind: "custom",
    eventStore,
    snapshotStore,
    ...(branchRegistry !== undefined && { branchRegistry }),
  };
}

/** Build a shared pool for callers assembling the Postgres stores by hand. */
export function postgresPool(config: PgConfig): Pool {
  return toPool(config).pool;
}
