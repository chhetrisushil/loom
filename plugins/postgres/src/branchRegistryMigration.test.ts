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
  const LEGACY_REFS = 50_000;

  afterAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`).finally(() => admin.end());
  });

  /** A fresh schema holding the pre-L21 `refs` table, analyzed as a live one would be. */
  async function legacyTable(admin: Pool, refs = LEGACY_REFS): Promise<void> {
    await admin.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`);
    await admin.query(`CREATE SCHEMA ${legacy}`);
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

  const collation = async (admin: Pool): Promise<string> =>
    (
      await admin.query<{ c: string }>(
        `SELECT c.collname AS c FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
         WHERE a.attrelid = 'refs'::regclass AND a.attname = 'name'`
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

  describe("L21 migration of a pre-L21 refs table", () => {
    it('converts name to COLLATE "C" in place, re-analyzes it, and pages index-only', async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin);
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
        expect(waited).toBeLessThan(5_000);
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

    it("issued once per pool and idempotent when the pool re-migrates (name already COLLATE C)", async () => {
      const admin = new Pool({ connectionString: PG_URL, options: `-c search_path=${legacy}` });
      try {
        await legacyTable(admin, 100);
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
    }, 60_000);
  });
}
