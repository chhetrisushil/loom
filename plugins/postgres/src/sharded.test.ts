import { runEventStoreConformance } from "@loom/conformance";
import { ShardedEventStore, TenantScopedEventStore } from "@loom/event-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";

// L10 — `ShardedEventStore` over REAL Postgres shards. The scatter-gather pager merges shard
// pages in JavaScript and resumes every shard from the merged page's last id, so it is only
// correct if each shard pages in the same order JavaScript merges in. A Postgres database
// whose collation is not "C" (any `initdb --locale=en_US.UTF-8`, i.e. most of them) paged in
// that collation and silently skipped ids. The in-memory kit runs cannot see this: only a
// real database has a collation. Run this against a non-C cluster to make it meaningful.
//
// Each shard gets its own schema, and each conformance case its own set of shards, because
// the kit reuses fixed execution ids ("x", "y", …) across cases. The stores own their pools
// (a connection string, not a Pool), so `close()` releases them and only one case's worth of
// connections is ever open.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;

const SHARDS = 3;
const CASES = 32; // comfortably above the EventStore kit's case count, per composition
const COMPOSITIONS = ["raw", "tenant"] as const;
const schemaName = (c: string, i: number, s: number): string =>
  `loom_shard_${process.pid}_${c}_${i}_${s}`;

if (PG_URL === undefined) {
  describe.skip("ShardedEventStore over Postgres (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  const allSchemas = COMPOSITIONS.flatMap((c) =>
    Array.from({ length: CASES }, (_, i) =>
      Array.from({ length: SHARDS }, (_, s) => schemaName(c, i, s))
    ).flat()
  );

  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (const s of allSchemas) {
        await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
        await admin.query(`CREATE SCHEMA ${s}`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  afterAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (const s of allSchemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  const shardsFor = (c: (typeof COMPOSITIONS)[number], i: number): PostgresEventStore[] =>
    Array.from(
      { length: SHARDS },
      (_, s) =>
        new PostgresEventStore({
          connectionString: PG_URL,
          options: `-c search_path=${schemaName(c, i % CASES, s)}`,
          max: 2,
        })
    );

  let nextRaw = 0;
  runEventStoreConformance(
    () => new ShardedEventStore(shardsFor("raw", nextRaw++)),
    "ShardedEventStore(3x Postgres)"
  );

  // The composition `TenantScopedEventStore` documents: sharding outermost, each shard a
  // tenant's view of its own database.
  let nextTenant = 0;
  runEventStoreConformance(
    () =>
      new ShardedEventStore(
        shardsFor("tenant", nextTenant++).map((s) => new TenantScopedEventStore(s, "acme"))
      ),
    "Sharded(TenantScoped(Postgres))"
  );

  // An existing deployment: `events` created before L10, so its column carries the DATABASE
  // collation. The migration must convert it in place, keep the rows, and leave the paging
  // query index-served.
  describe("L10 migration of a pre-L10 events table", () => {
    const legacy = `loom_shard_${process.pid}_legacy`;
    afterAll(async () => {
      const admin = new Pool({ connectionString: PG_URL });
      await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`).finally(() => admin.end());
    });

    it('converts execution_id to COLLATE "C" in place, and pages in code point order', async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`);
        await admin.query(`CREATE SCHEMA ${legacy}`);
        // The pre-L10 DDL, verbatim for the columns that matter.
        await admin.query(`CREATE TABLE events (
          id TEXT NOT NULL PRIMARY KEY, workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL,
          event_type TEXT NOT NULL, sequence BIGINT NOT NULL, timestamp BIGINT NOT NULL,
          payload JSONB NOT NULL, metadata JSONB, UNIQUE (execution_id, sequence))`);
        await admin.query("CREATE INDEX idx_events_exec ON events (execution_id, sequence ASC)");
        const ids = ["a_b", "A1", "ab", "a-b", "B"];
        for (const id of ids) {
          await admin.query(
            `INSERT INTO events VALUES ($1, 'wf', $2, 'STEP_COMPLETED', 0, 0, '{}'::jsonb, NULL)`,
            [`${id}-0`, id]
          );
        }
        const collation = async (): Promise<string> =>
          (
            await admin.query<{ c: string }>(
              `SELECT attcollation::regcollation::text AS c FROM pg_attribute
               WHERE attrelid = 'events'::regclass AND attname = 'execution_id'`
            )
          ).rows[0]!.c;
        expect(await collation()).not.toBe('"C"');

        const store = new PostgresEventStore({
          connectionString: PG_URL,
          options: `-c search_path=${legacy}`,
          max: 2,
        });
        const page = await store.listExecutionsPage({ limit: 10 });
        await store.close();
        expect(page.executionIds).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
        expect(await collation()).toBe('"C"');
        // Still index-served: a sequential scan + sort here is O(table) per page.
        await admin.query("SET enable_seqscan = off");
        const plan = (
          await admin.query<{ "QUERY PLAN": string }>(
            `EXPLAIN SELECT DISTINCT execution_id COLLATE "C" AS execution_id FROM events
             WHERE execution_id COLLATE "C" > 'a' ORDER BY 1 LIMIT 10`
          )
        ).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");
        expect(plan).toMatch(/Index Only Scan using idx_events_exec/);
        expect(plan).not.toMatch(/Sort/);
      } finally {
        await admin.end();
      }
    });
  });
}
