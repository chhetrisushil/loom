import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LeaseStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import type { SnapshotCodecName } from "@loom/snapshot-runtime";
import { SqliteArchiveStore } from "./SqliteArchiveStore";
import { SqliteBranchRegistry } from "./SqliteBranchRegistry";
import { SqliteEventStore } from "./SqliteEventStore";
import { SqliteLeaseStore } from "./SqliteLeaseStore";
import { SqliteSnapshotStore } from "./SqliteSnapshotStore";

export interface SqliteStorageOptions {
  /** Directory holding the `.db` files. Defaults to `.loom`. */
  dir?: string;
  /** Also provision a branch registry (its own DB file to avoid write contention). */
  branching?: boolean;
  /**
   * ADR 0140 - opt in to zstd-compressed snapshot states (default `"none"`: JSON text, as before).
   * Needs Node >= 22.15 (throws at construction otherwise). Old snapshots stay readable; see
   * `SqliteSnapshotStoreOptions.codec`.
   */
  snapshotCodec?: SnapshotCodecName;
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
 * `defineConfig` does not read it yet. It is opened lazily on first access (its own connection) and
 * closed by `eventStore.close()`.
 */
export function sqliteStorage(
  options: SqliteStorageOptions = {}
): CustomStorage & { leaseStore: LeaseStore } {
  const dir = options.dir ?? ".loom";
  mkdirSync(dir, { recursive: true });
  const eventStore = new SqliteEventStore(join(dir, "events.db"));
  // Lazy: a second events.db connection + migrate is opened only when something reads
  // `leaseStore`, and it is closed together with the event store (as the Postgres preset does).
  let lease: SqliteLeaseStore | undefined;
  const closeEvents = eventStore.close.bind(eventStore);
  eventStore.close = async () => {
    await closeEvents();
    await lease?.close();
  };
  return {
    kind: "custom",
    eventStore,
    snapshotStore: new SqliteSnapshotStore(join(dir, "snapshots.db"), {
      ...(options.snapshotCodec !== undefined && { codec: options.snapshotCodec }),
    }),
    archiveStore: new SqliteArchiveStore(join(dir, "archive.db")),
    get leaseStore(): LeaseStore {
      lease ??= new SqliteLeaseStore(join(dir, "events.db"));
      return lease;
    },
    ...(options.branching === true && {
      branchRegistry: new SqliteBranchRegistry(join(dir, "branches.db")),
    }),
  };
}
