import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LeaseStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import { SqliteBranchRegistry } from "./SqliteBranchRegistry";
import { SqliteEventStore } from "./SqliteEventStore";
import { SqliteLeaseStore } from "./SqliteLeaseStore";
import { SqliteSnapshotStore } from "./SqliteSnapshotStore";

export interface SqliteStorageOptions {
  /** Directory holding the `.db` files. Defaults to `.loom`. */
  dir?: string;
  /** Also provision a branch registry (its own DB file to avoid write contention). */
  branching?: boolean;
}

/**
 * A `defineConfig({ storage })` preset for embedded SQLite. Returns a `custom`
 * storage descriptor with the SQLite stores constructed — so `@loom/app` never
 * needs to know SQLite exists (ADR 0043: 1P/3P storage backends are symmetric,
 * each supplied as a preset, none privileged with a `kind`).
 *
 * `leaseStore` (ADR 0130 D11) is the heartbeat-lease store CO-LOCATED with the event store: the
 * same `events.db`, so the lease and the log share one failure domain. It is an accessor on
 * the factory's result, not part of `CustomStorage`, so there is no `EventStore` SPI change;
 * `defineConfig` does not read it yet. The caller closes it (its own connection).
 */
export function sqliteStorage(
  options: SqliteStorageOptions = {}
): CustomStorage & { leaseStore: LeaseStore } {
  const dir = options.dir ?? ".loom";
  mkdirSync(dir, { recursive: true });
  return {
    kind: "custom",
    eventStore: new SqliteEventStore(join(dir, "events.db")),
    snapshotStore: new SqliteSnapshotStore(join(dir, "snapshots.db")),
    leaseStore: new SqliteLeaseStore(join(dir, "events.db")),
    ...(options.branching === true && {
      branchRegistry: new SqliteBranchRegistry(join(dir, "branches.db")),
    }),
  };
}
