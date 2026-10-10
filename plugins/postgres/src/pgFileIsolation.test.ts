import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

// Guard for `loomTest({ pgDatabasePerFile: true })` (vitest.pgFileSetup.ts): every test file gets its
// OWN database, so a slow `migrate()` (a database-wide advisory lock held until COMMIT, no timeout)
// in one file cannot block a sibling's. Proved here with the real migration lock key: holding it in
// THIS file's database must not be visible from the package-level database a shared run would use.
// Skipped when there is no Postgres or the run opted out with LOOM_TEST_PG_SHARED=1.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const PACKAGE_DB = process.env.LOOM_TEST_POSTGRES_PACKAGE_DB;
const suite =
  PG_URL && PACKAGE_DB && process.env.LOOM_TEST_PG_SHARED !== "1" ? describe : describe.skip;

const MIGRATION_LOCK_NAMESPACE = 0x4c4f4f4d; // schema.ts: "LOOM"
const MIGRATION_LOCK_ID = 1;

suite("per-file test database", () => {
  const pools: Pool[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
  });

  it("a migration lock held in this file's database does not block another database", async () => {
    const mine = new Pool({ connectionString: PG_URL, max: 1 });
    const other = new URL(PG_URL as string);
    other.pathname = `/${PACKAGE_DB}`;
    const theirs = new Pool({ connectionString: other.toString(), max: 1 });
    pools.push(mine, theirs);

    const held = await mine.connect();
    try {
      const { rows } = await held.query<{ d: string }>("SELECT current_database() AS d");
      expect(rows[0]?.d).not.toBe(PACKAGE_DB);
      expect(rows[0]?.d).toContain("pgfileisolation");

      await held.query("BEGIN");
      await held.query("SELECT pg_advisory_xact_lock($1, $2)", [
        MIGRATION_LOCK_NAMESPACE,
        MIGRATION_LOCK_ID,
      ]);
      const probe = await theirs.query<{ got: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS got",
        [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID]
      );
      expect(probe.rows[0]?.got).toBe(true);
      await theirs.query("SELECT pg_advisory_unlock($1, $2)", [
        MIGRATION_LOCK_NAMESPACE,
        MIGRATION_LOCK_ID,
      ]);
    } finally {
      await held.query("ROLLBACK");
      held.release();
    }
  });
});
