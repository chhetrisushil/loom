export { PostgresEventStore } from "./PostgresEventStore";
export { PostgresSnapshotStore } from "./PostgresSnapshotStore";
export { PostgresBranchRegistry } from "./PostgresBranchRegistry";
export { migrate as migratePostgresStores, NOTIFY_CHANNEL } from "./schema";
export type { PgConfig } from "./pool";
export { PostgresTimerStore } from "./PostgresTimerStore";
export { PostgresDurableStateStore } from "./PostgresDurableStateStore";
export { PostgresReadModelStore } from "./PostgresReadModelStore";

// `postgresPool` is part of the public surface, not an internal of the preset: an app
// assembling the stores by hand needs a pool built by THIS package's `pg`, because
// `toPool` dispatches on `instanceof Pool`. A consumer that resolves its own copy of
// `pg` — anything installed via `link:`/`file:` against a sibling checkout, where the
// dependency is not deduplicated into one store — gets `false` from that check, and its
// pool is then silently treated as a `PoolConfig` and spread into `new Pool(…)`. The
// resulting failure surfaces inside pg's startup packet, nowhere near the call.
//
// Exporting it is what makes the supported path reachable; see `pool.ts`.
export { postgresStorage, postgresPool, type PostgresStorageOptions } from "./preset";
