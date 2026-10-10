import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresBranchRegistry } from "./PostgresBranchRegistry";
import { migrate } from "./schema";

// L21 (BranchRegistry SPI 2.0.0, ADR 0108 addendum) — the Postgres half of the fix, run
// against a REAL Postgres cluster (only a real database has a collation; the in-memory kit
// run cannot see this). A `refs` table created before L21 carries the DATABASE collation on
// `name`. The migration must convert it in place, keep the rows, re-ANALYZE the column
// (ALTER ... TYPE drops its statistics, and the planner then seq-scans + sorts), and — when
// the conversion cannot run — boot anyway with a WARNING naming the manual statements. Same
// shape as `sharded.test.ts`'s "L10 migration of a pre-L10 events table", one table smaller.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;

if (PG_URL === undefined) {
  describe.skip("BranchRegistry L21 migration (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  const legacy = `loom_branch_migrate_${process.pid}`;
  // Only the plan-shape test needs enough rows for the planner's choice to depend on the
  // column's statistics; every other test is about control flow (locks, warnings, ordering),
  // so it seeds just the named rows plus a token bulk and stays cheap under a loaded cluster.
  const PLAN_REFS = 50_000;
  const SMALL_REFS = 100;

  afterAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`).finally(() => admin.end());
  });

  /** A fresh schema holding the pre-L21 `refs` table, analyzed as a live one would be. */
  async function legacyTable(admin: Pool, refs = SMALL_REFS): Promise<void> {
    await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`);
    await admin.query(`CREATE SCHEMA ${legacy}`);
    await legacyRefs(admin, refs);
  }

  /** Just the pre-L21 `refs` DDL + rows, assuming the schema already exists. */
  async function legacyRefs(admin: Pool, refs = SMALL_REFS): Promise<void> {
    // The pre-L21 DDL, verbatim for the columns that matter.
    await admin.query(`CREATE TABLE refs (
      name TEXT NOT NULL, execution_id TEXT NOT NULL, tip BIGINT NOT NULL,
      parent_execution_id TEXT, fork_sequence BIGINT,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
    for (const n of ["a_b", "A1", "ab", "a-b", "B"]) {
      await admin.query("INSERT INTO refs VALUES ($1, $2, 1, NULL, NULL, 1, 1)", [n, `exec-${n}`]);
    }
    // Enough rows that the planner's choice depends on the column's statistics.
    await admin.query(
      `INSERT INTO refs SELECT 'z' || g, 'exec-z' || g, 1, NULL, NULL, 1, 1
       FROM generate_series(1, $1) g`,
      [refs]
    );
    // Primary key after the bulk load (much cheaper than maintaining it row by row), same
    // definition the pre-L21 schema had.
    await admin.query("ALTER TABLE refs ADD PRIMARY KEY (name)");
    await admin.query("ANALYZE refs");
  }

  /**
   * Just the pre-L10 `events` DDL + rows (verbatim from `sharded.test.ts`'s `legacyTable`),
   * assuming the schema already exists — for the combined pre-L10 + pre-L21 boot below.
   */
  async function legacyEvents(admin: Pool, rows: number): Promise<void> {
    await admin.query(`CREATE TABLE events (
      id TEXT NOT NULL, workflow_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      event_type TEXT NOT NULL, sequence BIGINT NOT NULL, timestamp BIGINT NOT NULL,
      payload JSONB NOT NULL, metadata JSONB)`);
    await admin.query(
      `INSERT INTO events SELECT 'z' || g || '-0', 'wf', 'z' || g, 'STEP_COMPLETED', 0, 0, '{}'::jsonb, NULL
       FROM generate_series(1, $1) g`,
      [rows]
    );
    await admin.query("ALTER TABLE events ADD PRIMARY KEY (id)");
    await admin.query("ALTER TABLE events ADD UNIQUE (execution_id, sequence)");
    await admin.query("CREATE INDEX idx_events_exec ON events (execution_id, sequence ASC)");
    await admin.query("ANALYZE events");
  }

  /** Both tables pre-migration, in one schema — the L10+L21 boot the reordering (P2) covers. */
  async function legacyBoth(admin: Pool, refsRows = SMALL_REFS, eventsRows = 1000): Promise<void> {
    await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`);
    await admin.query(`CREATE SCHEMA ${legacy}`);
    await legacyRefs(admin, refsRows);
    await legacyEvents(admin, eventsRows);
  }

  const collationOf = async (admin: Pool, table: string, column: string): Promise<string> =>
    (
      await admin.query<{ c: string }>(
        `SELECT c.collname AS c FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
         WHERE a.attrelid = $1::regclass AND a.attname = $2`,
        [table, column]
      )
    ).rows[0]!.c;

  const collation = (admin: Pool): Promise<string> => collationOf(admin, "refs", "name");
  const eventsCollation = (admin: Pool): Promise<string> =>
    collationOf(admin, "events", "execution_id");

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

  /**
   * Poll `pg_locks` until SOME backend other than `excludePid` holds a NOT GRANTED lock
   * request on `table` — i.e. is genuinely blocked waiting for it, not merely "some time has
   * passed" (review round 2, P3). Same technique `sharded.test.ts`'s
   * "restores the caller's lock_timeout..." L10 test uses via `to_regclass`, factored out
   * here since the L21 deadlock repro below needs the identical wait.
   */
  async function waitForBlockedOn(
    admin: Pool,
    table: string,
    excludePid: number,
    timeoutMs = 60_000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rowCount } = await admin.query(
        `SELECT 1 FROM pg_locks
         WHERE locktype = 'relation' AND NOT granted AND pid <> $1
           AND relation = to_regclass($2)`,
        [excludePid, `${legacy}.${table}`]
      );
      if ((rowCount ?? 0) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a blocked lock request on ${table}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  describe("L21 migration of a pre-L21 refs table", () => {
    it('converts name to COLLATE "C" in place, re-analyzes it, and pages index-only', async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin, PLAN_REFS);
        expect(await collation(admin)).not.toBe("C");

        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        const reg = new PostgresBranchRegistry(pool);
        const page = await reg.listRefs({ limit: 5 });
        await reg.close();
        await pool.end();
        expect(page.map((r) => r.name)).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
        expect(await collation(admin)).toBe("C");
        expect(warnings).toEqual([]);
        // The ALTER dropped the column's statistics; the migration must have restored them.
        const stats = await admin.query(
          `SELECT 1 FROM pg_stats WHERE schemaname = $1 AND tablename = 'refs' AND attname = 'name'`,
          [legacy]
        );
        expect(stats.rowCount).toBe(1);
        // The planner's own choice, NOT forced: a seq scan + sort here is O(table) per page.
        const plan = (
          await admin.query<{ "QUERY PLAN": string }>(
            `EXPLAIN SELECT * FROM refs
             WHERE name COLLATE "C" > 'a' ORDER BY name COLLATE "C" ASC LIMIT 5`
          )
        ).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");
        expect(plan).toMatch(/Index (Only )?Scan/);
        expect(plan).not.toMatch(/Sort|Seq Scan/);
      } finally {
        await admin.end();
      }
    }, 180_000);

    it("boots with a WARNING when a user view depends on the column, and still pages correctly", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin);
        await admin.query("CREATE VIEW ref_names AS SELECT name FROM refs");
        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        const reg = new PostgresBranchRegistry(pool);
        const page = await reg.listRefs({ limit: 5 });
        await reg.close();
        await pool.end();
        expect(page.map((r) => r.name)).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
        expect(await collation(admin)).not.toBe("C");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/0A000/);
        expect(warnings[0]).toContain(
          'ALTER TABLE refs ALTER COLUMN name TYPE TEXT COLLATE "C"; ANALYZE refs;'
        );
      } finally {
        await admin.end();
      }
    }, 180_000);

    it("gives up on a held table lock after lockTimeoutMs with a WARNING, instead of queueing writes", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      const holder = await admin.connect();
      try {
        await legacyTable(admin);
        // An open transaction holding even the weakest lock blocks the ALTER's ACCESS EXCLUSIVE.
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM refs LIMIT 1");
        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        const started = Date.now();
        // `PostgresBranchRegistry` has no `migrationLockTimeoutMs` of its own (only
        // `PostgresEventStore` does) — the documented, reliable way to set it for any
        // store is to migrate the pool directly, first (schema.ts's `MigrateOptions
        // .lockTimeoutMs` doc comment); the registry's own `migrate()` call then memoizes
        // to this one.
        await migrate(pool, { lockTimeoutMs: 200 });
        const reg = new PostgresBranchRegistry(pool);
        const page = await reg.listRefs({ limit: 5 });
        const waited = Date.now() - started;
        await reg.close();
        await pool.end();
        expect(page.map((r) => r.name)).toEqual(["A1", "B", "a-b", "a_b", "ab"]);
        expect(waited).toBeLessThan(10_000); // timing-bound: an ignored 200 ms lock_timeout hangs until ROLLBACK
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/55P03/);
        await holder.query("ROLLBACK");
        expect(await collation(admin)).not.toBe("C");
        // With the lock released, the next boot converts it.
        const retry = new PostgresBranchRegistry({
          connectionString: PG_URL,
          options: `-c search_path=${legacy}`,
          max: 2,
        });
        await retry.listRefs({ limit: 1 });
        await retry.close();
        expect(await collation(admin)).toBe("C");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await admin.end();
      }
    }, 180_000);

    it("memoizes per pool, and a later call after conversion is a no-op", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin);
        const pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
        try {
          await migrate(pool);
          expect(await collation(admin)).toBe("C");
          // A second migration call against the same pool is a no-op (memoized) — the DO
          // block's own catalog check makes even a fresh migrate() against this schema a
          // no-op, which is what a later boot of the same deployment does.
          await migrate(pool);
          expect(await collation(admin)).toBe("C");
        } finally {
          await pool.end();
        }
      } finally {
        await admin.end();
      }
    }, 180_000); // migrate() waits on the cluster-wide migration lock, unbounded by design

    it("completes the conversion under a session statement_timeout shorter than the rebuild", async () => {
      // Same premise as `sharded.test.ts`'s equivalent L10 case: a pool-level statement_timeout
      // shorter than the rebuild used to abort the conversion (57014) on EVERY boot — taking the
      // exclusive lock each time — so the column never converted. The rebuild's duration is a
      // schema-set LOWER BOUND, independent of machine speed and row count: a CHECK constraint
      // whose function sleeps SLEEP_MS per row is re-validated by the ALTER, so the rebuild takes
      // >= rows * SLEEP_MS however fast the machine is. (It used to be 3M rows against a 200 ms
      // budget: a fast machine finished the bare ALTER inside the budget and broke the premise,
      // while a loaded one spent minutes building the table.)
      const SLEEP_MS = 800;
      // < the floor (5 rows x 800 ms = 4 s), and ~50x the idle cost of the migration's
      // non-exempt statements. RESIDUAL: those must still finish inside this budget.
      const BUDGET_MS = 2000;
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin, 0);
        const seeded = await admin.query("SELECT count(*)::int AS n FROM refs");
        expect(seeded.rows[0].n).toBe(5); // the floor is 5 * SLEEP_MS
        await admin.query(`CREATE FUNCTION slow_ok(t text) RETURNS boolean
          LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN PERFORM pg_sleep(${SLEEP_MS / 1000}); RETURN true; END $$`);
        await admin.query("ALTER TABLE refs ADD CONSTRAINT slow_check CHECK (slow_ok(name))");
        const warnings: string[] = [];
        const pool = noticingPool(warnings, `-c statement_timeout=${BUDGET_MS}`);
        try {
          // Proves the premise: the bare ALTER alone does not fit in this session's budget.
          const probe = await pool.connect();
          try {
            await probe.query("BEGIN");
            await expect(
              probe.query('ALTER TABLE refs ALTER COLUMN name TYPE TEXT COLLATE "C"')
            ).rejects.toMatchObject({ code: "57014" });
          } finally {
            await probe.query("ROLLBACK").catch(() => {});
            probe.release();
          }
          const started = Date.now();
          await migrate(pool);
          // The conversion really did run past the budget rather than being skipped.
          expect(Date.now() - started).toBeGreaterThan(5 * SLEEP_MS - 500);
        } finally {
          await pool.end();
        }
        expect(await collation(admin)).toBe("C");
        expect(warnings).toEqual([]);
      } finally {
        await admin.end();
      }
    }, 180_000);

    // Review round 1 (P2/1c) — both tables need converting in the SAME migration transaction,
    // and each table's own lock contention is independent of the other's.
    describe("a combined pre-L10 + pre-L21 boot (both tables need converting)", () => {
      it("holding `refs` only: L21 fails soft, L10 (events) still converts", async () => {
        const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
        const holder = await admin.connect();
        try {
          await legacyBoth(admin);
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM refs LIMIT 1");
          const warnings: string[] = [];
          const pool = noticingPool(warnings);
          await migrate(pool, { lockTimeoutMs: 200 });
          await pool.end();
          expect(await collation(admin)).not.toBe("C");
          expect(await eventsCollation(admin)).toBe("C");
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatch(/55P03/);
          expect(warnings[0]).toContain("refs.name");
        } finally {
          await holder.query("ROLLBACK").catch(() => {});
          holder.release();
          await admin.end();
        }
      }, 180_000);

      it("holding `events` only: L10 fails soft, L21 (refs) still converts", async () => {
        const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
        const holder = await admin.connect();
        try {
          await legacyBoth(admin);
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM events LIMIT 1");
          const warnings: string[] = [];
          const pool = noticingPool(warnings);
          await migrate(pool, { lockTimeoutMs: 200 });
          await pool.end();
          expect(await collation(admin)).toBe("C");
          expect(await eventsCollation(admin)).not.toBe("C");
          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toMatch(/55P03/);
          expect(warnings[0]).toContain("events.execution_id");
        } finally {
          await holder.query("ROLLBACK").catch(() => {});
          holder.release();
          await admin.end();
        }
      }, 180_000);
    });

    // Review round 1 (P2) — the deadlock this migration's ordering (and the `deadlock_detected`
    // EXCEPTION arm) exists to survive.
    it("a concurrent transaction reading refs then events deadlocks the migration; it fails soft and keeps L21's conversion (40P01)", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      const holder = await admin.connect();
      try {
        await legacyBoth(admin);
        // Step 1: hold AccessShare(events) for the whole test, acquired BEFORE migration
        // starts, so migration is guaranteed to block on `events` once it gets there.
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM events LIMIT 1");
        const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;

        const warnings: string[] = [];
        const pool = noticingPool(warnings);
        // Step 2: migration runs L21 (refs, uncontended — succeeds immediately, and now HOLDS
        // ACCESS EXCLUSIVE on refs until COMMIT), then blocks on L10 (events, held by `holder`).
        const migration = migrate(pool);

        // Step 3: wait until migration's backend is ACTUALLY blocked on `events` (a NOT
        // granted lock request, polled — not a fixed sleep guessing how long L21's conversion
        // of a 50k-row table takes) before `holder` asks for `refs` too — which migration now
        // holds exclusively. Two transactions, each waiting on a lock the OTHER holds: a real
        // deadlock. `holder` started waiting on `events` BEFORE migration ever attempted it,
        // so migration's own wait is the OLDER one and (per Postgres's deadlock detector)
        // migration is the side whose statement receives the 40P01 — not `holder`'s.
        await waitForBlockedOn(admin, "events", holderPid);
        const holderBlocked = holder.query("SELECT 1 FROM refs LIMIT 1");

        // Migration must fail soft (D3), not throw — the deadlock resolves once its own
        // EXCEPTION arm catches 40P01 and it proceeds to COMMIT, which releases `refs` and
        // unblocks `holder`'s query.
        await expect(migration).resolves.toBeUndefined();
        await expect(holderBlocked).resolves.toBeDefined();
        await pool.end();

        // L21 (refs) committed successfully BEFORE the deadlock; L10 (events) is the one that
        // lost it and was skipped.
        expect(await collation(admin)).toBe("C");
        expect(await eventsCollation(admin)).not.toBe("C");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/40P01/);
        expect(warnings[0]).toContain("events.execution_id");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await admin.end();
      }
    }, 180_000);
  });
}
