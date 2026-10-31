import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { EventStore, TimerStore } from "@loom/event-runtime";
import {
  PostgresEventStore,
  PostgresSnapshotStore,
  PostgresTimerStore,
  migratePostgresStores,
  postgresPool,
} from "@loom/plugin-postgres";
import { SqliteEventStore, SqliteSnapshotStore, SqliteTimerStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";

// The three durable backends the inbox runs on, for tests that must hold where the SQL is real.

export interface Backend {
  name: string;
  skip?: boolean;
  setup(): Promise<void>;
  make(): { eventStore: EventStore; snapshotStore: SnapshotStore; timers: TimerStore };
  teardown(): Promise<void>;
}

/** `tag` keeps two test files' SQLite files and Postgres schemas apart. */
export function inboxBackends(tag: string): [Backend, Backend, Backend] {
  const dir = mkdtempSync(join(tmpdir(), `loom-${tag}-`));
  let n = 0;
  const memory: Backend = {
    name: "memory",
    setup: async () => {},
    make: () => ({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      timers: new InMemoryTimerStore(),
    }),
    teardown: async () => {},
  };
  const sqlite: Backend = {
    name: "sqlite",
    setup: async () => {},
    make: () => {
      const p = join(dir, `${tag}-${++n}.db`);
      return {
        eventStore: new SqliteEventStore(p),
        snapshotStore: new SqliteSnapshotStore(p),
        timers: new SqliteTimerStore(p),
      };
    },
    teardown: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const pgUrl = process.env.LOOM_TEST_POSTGRES_URL;
  const schema = `loom_${tag}_${process.pid}`;
  const pool =
    pgUrl !== undefined
      ? postgresPool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
      : undefined;
  const postgres: Backend = {
    name: "postgres",
    skip: pgUrl === undefined,
    setup: async () => {
      await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool?.query(`CREATE SCHEMA ${schema}`);
      if (pool !== undefined) await migratePostgresStores(pool);
    },
    make: () => ({
      eventStore: new PostgresEventStore(pool as never),
      snapshotStore: new PostgresSnapshotStore(pool as never),
      timers: new PostgresTimerStore(pool as never),
    }),
    teardown: async () => {
      if (pool === undefined || pgUrl === undefined) return;
      // A run settles (EXECUTION_COMPLETED is durable) BEFORE its best-effort inbox retire and
      // checkpoint finish, so a test that waited on "completed" can reach teardown with that work
      // still holding row locks. DROP SCHEMA would then take AccessExclusive locks in the opposite
      // order and deadlock with it (loom #718). `pool.end()` first: it lets every checked-out
      // client (an in-flight retire transaction) finish and release, and later queries from that
      // background work fail fast on the ended pool (the retire is best-effort and reports them to
      // `onStorageError`). Only then is the schema dropped, over a separate connection.
      await pool.end();
      const admin = postgresPool({ connectionString: pgUrl, max: 1 });
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
  return [memory, sqlite, postgres];
}
