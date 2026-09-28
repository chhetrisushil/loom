import { runEventStoreConformance } from "@loom/conformance";
import { ShardedEventStore, TenantScopedEventStore } from "@loom/event-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { migrate } from "./schema";

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
  // collation. The migration must convert it in place, keep the rows, re-ANALYZE the column
  // (ALTER ... TYPE drops its statistics, and the planner then seq-scans + sorts), and — when
  // the conversion cannot run — boot anyway with a WARNING naming the manual statements.
  describe("L10 migration of a pre-L10 events table", () => {
    const legacy = `loom_shard_${process.pid}_legacy`;
    const LEGACY_EXECUTIONS = 50_000;

    afterAll(async () => {
      const admin = new Pool({ connectionString: PG_URL });
      await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`).finally(() => admin.end());
    });

    /** A fresh schema holding the pre-L10 `events` table, analyzed as a live one would be. */
    async function legacyTable(admin: Pool, executions = LEGACY_EXECUTIONS): Promise<void> {
      await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`);
      await admin.query(`CREATE SCHEMA ${legacy}`);
      // The pre-L10 DDL, verbatim for the columns that matter.
      await admin.query(`CREATE TABLE events (
        id TEXT NOT NULL PRIMARY KEY, workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        event_type TEXT NOT NULL, sequence BIGINT NOT NULL, timestamp BIGINT NOT NULL,
        payload JSONB NOT NULL, metadata JSONB, UNIQUE (execution_id, sequence))`);
      await admin.query("CREATE INDEX idx_events_exec ON events (execution_id, sequence ASC)");
      for (const id of ["a_b", "A1", "ab", "a-b", "B"]) {
        await admin.query(
          `INSERT INTO events VALUES ($1, 'wf', $2, 'STEP_COMPLETED', 0, 0, '{}'::jsonb, NULL)`,
          [`${id}-0`, id]
        );
      }
      // Enough rows that the planner's choice depends on the column's statistics.
      await admin.query(
        `INSERT INTO events SELECT 'z' || g || '-0', 'wf', 'z' || g, 'STEP_COMPLETED', 0, 0, '{}'::jsonb, NULL
         FROM generate_series(1, $1) g`,
        [executions]
      );
      await admin.query("ANALYZE events");
    }

    const collation = async (admin: Pool): Promise<string> =>
      (
        await admin.query<{ c: string }>(
          `SELECT c.collname AS c FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
           WHERE a.attrelid = 'events'::regclass AND a.attname = 'execution_id'`
        )
      ).rows[0]!.c;

    /** A pool whose connections report every server WARNING into `warnings`. */
    function noticingPool(warnings: string[], session = ""): Pool {
      const pool = new Pool({
        connectionString: PG_URL,
        options: `-c search_path=${legacy} ${session}`,
        max: 2,
      });
      pool.on("connect", (client) => {
        client.on("notice", (n) => {
          if (n.severity === "WARNING") warnings.push(n.message ?? "");
        });
      });
      return pool;
    }

    it('converts execution_id to COLLATE "C" in place, re-analyzes it, and pages index-only', async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin);
        expect(await collation(admin)).not.toBe("C");

        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        const store = new PostgresEventStore(pool);
        const page = await store.listExecutionsPage({ limit: 5 });
        await store.close();
        await pool.end();
        expect(page.executionIds).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
        expect(await collation(admin)).toBe("C");
        expect(warnings).toEqual([]);
        // The ALTER dropped the column's statistics; the migration must have restored them.
        const stats = await admin.query(
          `SELECT 1 FROM pg_stats WHERE schemaname = $1 AND tablename = 'events' AND attname = 'execution_id'`,
          [legacy]
        );
        expect(stats.rowCount).toBe(1);
        // The planner's own choice, NOT forced: a seq scan + sort here is O(table) per page.
        const plan = (
          await admin.query<{ "QUERY PLAN": string }>(
            `EXPLAIN SELECT DISTINCT execution_id COLLATE "C" AS execution_id FROM events
             WHERE execution_id COLLATE "C" > 'a' ORDER BY 1 LIMIT 1001`
          )
        ).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");
        expect(plan).toMatch(/Index Only Scan using idx_events_exec/);
        expect(plan).not.toMatch(/Sort|Seq Scan|HashAggregate/);
      } finally {
        await admin.end();
      }
    }, 60_000);

    it("boots with a WARNING when a user view depends on the column, and still pages correctly", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin);
        await admin.query("CREATE VIEW exec_ids AS SELECT DISTINCT execution_id FROM events");
        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        const store = new PostgresEventStore(pool);
        const page = await store.listExecutionsPage({ limit: 5 });
        await store.close();
        await pool.end();
        expect(page.executionIds).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
        expect(await collation(admin)).not.toBe("C");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/0A000/);
        expect(warnings[0]).toContain(
          'ALTER TABLE events ALTER COLUMN execution_id TYPE TEXT COLLATE "C"; ANALYZE events;'
        );
      } finally {
        await admin.end();
      }
    }, 60_000);

    it("gives up on a held table lock after lockTimeoutMs with a WARNING, instead of queueing appends", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      const holder = await admin.connect();
      try {
        await legacyTable(admin);
        // An open transaction holding even the weakest lock blocks the ALTER's ACCESS EXCLUSIVE.
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM events LIMIT 1");
        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        const started = Date.now();
        const store = new PostgresEventStore(pool, { migrationLockTimeoutMs: 200 });
        const page = await store.listExecutionsPage({ limit: 5 });
        const waited = Date.now() - started;
        await store.close();
        await pool.end();
        expect(page.executionIds).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
        expect(waited).toBeLessThan(5_000);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/55P03/);
        await holder.query("ROLLBACK");
        expect(await collation(admin)).not.toBe("C");
        // With the lock released, the next boot converts it.
        const retry = new PostgresEventStore({
          connectionString: PG_URL,
          options: `-c search_path=${legacy}`,
          max: 2,
        });
        await retry.listExecutionsPage({ limit: 1 });
        await retry.close();
        expect(await collation(admin)).toBe("C");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await admin.end();
      }
    }, 60_000);

    it("completes the conversion under a session statement_timeout shorter than the rebuild", async () => {
      // A pool-level statement_timeout shorter than the index rebuild used to abort the
      // conversion (57014) on EVERY boot — taking the exclusive lock each time — so the column
      // never converted. The rebuild is exempted from it; the rest of the migration is not.
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin, 600_000);
        const warnings: string[] = [];
        const pool = noticingPool(warnings, "-c statement_timeout=200");
        try {
          // Proves the premise: the bare ALTER alone does not fit in this session's budget.
          const probe = await pool.connect();
          try {
            await probe.query("BEGIN");
            await expect(
              probe.query('ALTER TABLE events ALTER COLUMN execution_id TYPE TEXT COLLATE "C"')
            ).rejects.toMatchObject({ code: "57014" });
          } finally {
            await probe.query("ROLLBACK").catch(() => {});
            probe.release();
          }
          await migrate(pool);
        } finally {
          await pool.end();
        }
        expect(await collation(admin)).toBe("C");
        expect(warnings).toEqual([]);
      } finally {
        await admin.end();
      }
    }, 120_000);

    it("restores the caller's lock_timeout after the conversion, so later DDL stays bounded", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      const holder = await admin.connect();
      let release: ReturnType<typeof setTimeout> | undefined;
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`);
        await admin.query(`CREATE SCHEMA ${legacy}`);
        // A full current schema, then `events` put back to the pre-L10 collation so the
        // conversion (and its lock_timeout juggling) runs on this boot.
        const setup = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
        await migrate(setup).finally(() => setup.end());
        await admin.query(
          'ALTER TABLE events ALTER COLUMN execution_id TYPE TEXT COLLATE "default"'
        );
        expect(await collation(admin)).not.toBe("C");
        // Hold a table the migration touches AFTER the conversion (its CREATE INDEX IF NOT
        // EXISTS takes a SHARE lock). Released after 10 s, so an unbounded wait would succeed.
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE snapshots IN ACCESS EXCLUSIVE MODE");
        release = setTimeout(() => void holder.query("ROLLBACK").catch(() => {}), 10_000);

        const warnings: string[] = [];
        const pool = noticingPool(warnings, "-c lock_timeout=300");
        const started = Date.now();
        try {
          await expect(migrate(pool, { lockTimeoutMs: 5_000 })).rejects.toMatchObject({
            code: "55P03",
          });
        } finally {
          await pool.end();
        }
        expect(Date.now() - started).toBeLessThan(8_000);
        expect(warnings).toEqual([]);
      } finally {
        if (release !== undefined) clearTimeout(release);
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await admin.end();
      }
    }, 60_000);
  });
}
