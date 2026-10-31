export {
  ExecutionIdTooLongError,
  MAX_EXECUTION_ID_BYTES,
  PostgresEventStore,
} from "./PostgresEventStore";
export { PostgresSnapshotStore, type PostgresSnapshotStoreOptions } from "./PostgresSnapshotStore";
export { PostgresArchiveStore } from "./PostgresArchiveStore";
export { PostgresBranchRegistry } from "./PostgresBranchRegistry";
export {
  migrate as migratePostgresStores,
  ensureSnapshotZstd,
  backfillParkFences,
  NOTIFY_CHANNEL,
} from "./schema";
export type { MigrateOptions, BackfillParkFencesOptions } from "./schema";
// `PoolLike` is the whole pool surface these stores use. Exported because it is the
// contract for bringing your own pool: satisfy it and the stores take it, whichever copy
// of `pg` built it — or whether `pg` built it at all.
export type { PgConfig, PoolLike } from "./pool";
export { EXPIRED_SQL as LEASE_EXPIRED_SQL, PostgresLeaseStore } from "./PostgresLeaseStore";
export { PostgresTimerStore } from "./PostgresTimerStore";
export { PostgresDurableStateStore } from "./PostgresDurableStateStore";
export {
  PostgresReadModelStore,
  type PostgresReadModelStoreOptions,
} from "./PostgresReadModelStore";
export { foldedStateDdl, type FoldedTableOptions } from "./foldedState";
export { PostgresMemoryStore } from "./PostgresMemoryStore";

// `postgresPool` is public because an app assembling the stores by hand may want a real
// `pg.Pool` from THIS package — the sizing/instrumentation surface (`totalCount` and
// friends) that `PoolLike` deliberately omits. It is no longer required for cross-copy
// wiring: `toPool` recognises a pool structurally, so a consumer resolving its own `pg`
// passes that pool straight in. See `pool.ts`.
export { postgresStorage, postgresPool, type PostgresStorageOptions } from "./preset";
