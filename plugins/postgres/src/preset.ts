import type { CustomStorage } from "@loom/plugin-kit";
import { PostgresBranchRegistry } from "./PostgresBranchRegistry";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import type { PgConfig } from "./pool";

export interface PostgresStorageOptions {
  /** Standard `postgres://…` connection string, or a `PgConfig` pool spec. */
  url: PgConfig;
  /** Also provision a branch registry for fork/branch. */
  branching?: boolean;
}

/**
 * A `defineConfig({ storage })` preset for network-backed Postgres. Returns a
 * `custom` storage descriptor with the Postgres stores constructed — so `@loom/app`
 * never depends on `pg` (ADR 0043: storage backends are symmetric presets, so a
 * third-party backend is wired exactly like this first-party one).
 */
export function postgresStorage(options: PostgresStorageOptions): CustomStorage {
  return {
    kind: "custom",
    eventStore: new PostgresEventStore(options.url),
    snapshotStore: new PostgresSnapshotStore(options.url),
    ...(options.branching === true && {
      branchRegistry: new PostgresBranchRegistry(options.url),
    }),
  };
}
