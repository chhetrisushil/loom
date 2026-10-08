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
        id TEXT NOT NULL, workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        event_type TEXT NOT NULL, sequence BIGINT NOT NULL, timestamp BIGINT NOT NULL,
        payload JSONB NOT NULL, metadata JSONB)`);
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
      // Indexes after the bulk load (much cheaper than maintaining them row by row), with the
      // same definitions the pre-L10 schema had.
      await admin.query("ALTER TABLE events ADD PRIMARY KEY (id)");
      await admin.query("ALTER TABLE events ADD UNIQUE (execution_id, sequence)");
      await admin.query("CREATE INDEX idx_events_exec ON events (execution_id, sequence ASC)");
      await admin.query("ANALYZE events");
    }

    // A rebuild whose duration is a schema-set LOWER BOUND, independent of machine load: a CHECK
    // constraint whose function sleeps SLEEP_MS per row is re-validated by the ALTER, so the
    // collation rebuild takes >= ROWS * SLEEP_MS however fast the machine is. The tests that
    // need "a rebuild longer than a session statement_timeout" used to get that from 300k rows
    // against a 200ms budget, but the rebuild's duration and every NON-exempt migration
    // statement's duration both scale with load, so on a loaded machine the migration tripped
    // its own 200ms budget (57014). Now the budget sits far below the floor and far above the
    // ordinary statements' idle cost.
    const REBUILD_ROWS = 5; // legacyTable seeds 5 named rows; its bulk load is 0
    const REBUILD_SLEEP_MS = 600; // rebuild floor = 3s
    // < floor, and ~75x the idle cost of a non-exempt migration step. RESIDUAL: the non-exempt
    // statements must still finish inside this budget, so a machine stalled ~75x slower than
    // idle could still trip it (57014). Accepted: that is far past the load seen in full-suite
    // runs (the old 200ms budget failed at ~10x), and widening it would erode the floor gap.
    const BUDGET_MS = 1500;
    async function legacyTableWithSlowRebuild(admin: Pool): Promise<void> {
      await legacyTable(admin, 0);
      const seeded = await admin.query("SELECT count(*)::int AS n FROM events");
      expect(seeded.rows[0].n).toBe(REBUILD_ROWS); // the >= 3s floor is ROWS * SLEEP_MS
      await admin.query(`CREATE FUNCTION slow_ok(t text) RETURNS boolean
        LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN PERFORM pg_sleep(${REBUILD_SLEEP_MS / 1000}); RETURN true; END $$`);
      await admin.query(
        "ALTER TABLE events ADD CONSTRAINT slow_check CHECK (slow_ok(execution_id))"
      );
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

    /** Poll pg_locks until the advisory-lock (granted, waiting) counts satisfy `ok`. */
    async function waitForAdvisory(
      admin: Pool,
      ok: (granted: number, waiting: number) => boolean,
      what: string
    ): Promise<void> {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const { rows } = await admin.query<{ granted: number; waiting: number }>(
          `SELECT count(*) FILTER (WHERE granted)::int AS granted,
                  count(*) FILTER (WHERE NOT granted)::int AS waiting
           FROM pg_locks WHERE locktype = 'advisory' AND database = (
             SELECT oid FROM pg_database WHERE datname = current_database())`
        );
        if (ok(rows[0]!.granted, rows[0]!.waiting)) return;
        if (Date.now() > deadline) throw new Error(`advisory-lock ${what} never observed`);
        await new Promise((r) => setTimeout(r, 25));
      }
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
    }, 180_000);

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
    }, 180_000);

    it("gives up (55P03) while the lock is still held", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      const holder = await admin.connect();
      try {
        await legacyTable(admin);
        // An open transaction holding even the weakest lock blocks the ALTER's ACCESS EXCLUSIVE.
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM events LIMIT 1");
        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        const store = new PostgresEventStore(pool, { migrationLockTimeoutMs: 200 });
        const page = await store.listExecutionsPage({ limit: 5 });
        await store.close();
        await pool.end();
        expect(page.executionIds).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
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
    }, 180_000);

    it("completes the conversion under a session statement_timeout shorter than the rebuild", async () => {
      // A pool-level statement_timeout shorter than the index rebuild used to abort the
      // conversion (57014) on EVERY boot — taking the exclusive lock each time — so the column
      // never converted. The rebuild is exempted from it; the rest of the migration is not.
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTableWithSlowRebuild(admin);
        const warnings: string[] = [];
        const pool = noticingPool(warnings, `-c statement_timeout=${BUDGET_MS}`);
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
          const started = Date.now();
          await migrate(pool);
          // The conversion really did run past the budget rather than being skipped.
          expect(Date.now() - started).toBeGreaterThan(REBUILD_ROWS * REBUILD_SLEEP_MS - 500);
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

        const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;

        const warnings: string[] = [];
        const pool = noticingPool(warnings, "-c lock_timeout=1000");
        const started = Date.now();
        // Prove WHICH wait timed out: while the migration is pending, some other backend must
        // be seen waiting on THIS schema's `snapshots` (not on the advisory key, whose wait is
        // exempt from the caller's timeouts and could otherwise also yield a 55P03).
        let sawSnapshotsWait = false;
        let settled = false;
        const outcome = migrate(pool, { lockTimeoutMs: 5_000 }).finally(() => {
          settled = true;
        });
        const poll = (async () => {
          while (!settled) {
            const { rowCount } = await admin.query(
              `SELECT 1 FROM pg_locks
               WHERE locktype = 'relation' AND NOT granted AND pid <> $1
                 AND relation = to_regclass($2)`,
              [holderPid, `${legacy}.snapshots`]
            );
            if ((rowCount ?? 0) > 0) sawSnapshotsWait = true;
            await new Promise((r) => setTimeout(r, 25));
          }
        })();
        try {
          await expect(outcome).rejects.toMatchObject({ code: "55P03" });
          await poll;
        } finally {
          await pool.end();
        }
        expect(sawSnapshotsWait).toBe(true);
        expect(Date.now() - started).toBeLessThan(15_000); // timing-bound: a missing lock_timeout blocks indefinitely
        expect(warnings).toEqual([]);
      } finally {
        if (release !== undefined) clearTimeout(release);
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await admin.end();
      }
    }, 180_000);

    it("peers booting during a long conversion wait for it, whatever their own timeouts", async () => {
      // Waiting on the migration's advisory lock is serialization, not a hang: a peer whose
      // pool has a short statement_timeout or lock_timeout must queue behind a one-time rebuild
      // rather than fail its migration (after which its store rejects every call until restart).
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTableWithSlowRebuild(admin);
        const warnings: string[] = [];
        const pools = [
          noticingPool(warnings, `-c statement_timeout=${BUDGET_MS}`),
          noticingPool(warnings, `-c statement_timeout=${BUDGET_MS}`),
          noticingPool(warnings, `-c statement_timeout=${BUDGET_MS} -c lock_timeout=300`),
        ];
        try {
          const first = migrate(pools[0]!);
          // The first migrator must hold the advisory lock (mid-rebuild) before peers arrive.
          await waitForAdvisory(admin, (granted) => granted >= 1, "holder");
          const peers = [migrate(pools[1]!), migrate(pools[2]!)];
          // Prove both peers really queued on the advisory lock (not yet granted).
          await waitForAdvisory(admin, (_g, waiting) => waiting >= 2, "peers");
          await Promise.all([first, ...peers]);
        } finally {
          await Promise.all(pools.map((p) => p.end()));
        }
        expect(await collation(admin)).toBe("C");
        expect(warnings).toEqual([]);
      } finally {
        await admin.end();
      }
    }, 300_000);
  });
}
