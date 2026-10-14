import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresTimerStore } from "./PostgresTimerStore";
import { migrate } from "./schema";

// ADR 0118 D4 — `CREATE TABLE IF NOT EXISTS` never adds a column to a table an older version
// created, so the re-drive column needs its own guarded migration. Prove it on an OLD-shape table
// (no `redrive`), in a schema of its own. Gated on LOOM_TEST_POSTGRES_URL like the rest.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SCHEMA = `loom_timer_mig_${process.pid}`;

if (PG_URL === undefined) {
  describe.skip("PostgresTimerStore migration (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  let pool: Pool;
  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    } finally {
      await admin.end();
    }
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}`, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  describe("PostgresTimerStore migration (ADR 0118 D4)", () => {
    it("an OLD-shape timers table gains `redrive`, keeps its rows, and accepts a re-drive row", async () => {
      await pool.query(`CREATE TABLE timers (
        execution_id TEXT NOT NULL, wake_at BIGINT NOT NULL, PRIMARY KEY (execution_id, wake_at))`);
      await pool.query("INSERT INTO timers (execution_id, wake_at) VALUES ('old', 50)");
      await migrate(pool);
      await migrate(pool); // idempotent: ADD COLUMN IF NOT EXISTS
      const store = new PostgresTimerStore(pool);
      try {
        await store.schedule({ executionId: "new", wakeAt: 60, redrive: { attempt: 1 } });
        expect(await store.due(100)).toEqual([
          { executionId: "old", wakeAt: 50 },
          { executionId: "new", wakeAt: 60, redrive: { attempt: 1 } },
        ]);
        // the upsert on the PRE-EXISTING plain row gains the flag, and is never downgraded
        await store.schedule({ executionId: "old", wakeAt: 50, redrive: { attempt: 4 } });
        await store.schedule({ executionId: "old", wakeAt: 50 });
        expect((await store.due(100))[0]).toEqual({
          executionId: "old",
          wakeAt: 50,
          redrive: { attempt: 4 },
        });
      } finally {
        await store.close();
      }
    });

    it("a redrive-era timers table (no `refused`) gains it, keeps its rows, and round-trips a refusal row (ADR 0130 D10)", async () => {
      await pool.query("DROP TABLE IF EXISTS timers");
      await pool.query(`CREATE TABLE timers (
        execution_id TEXT NOT NULL, wake_at BIGINT NOT NULL, redrive JSONB,
        PRIMARY KEY (execution_id, wake_at))`);
      await pool.query("INSERT INTO timers (execution_id, wake_at) VALUES ('old', 50)");
      // `migrate` is memoized per pool: a fresh pool on the same schema runs it again
      const fresh = new Pool({
        connectionString: PG_URL,
        options: `-c search_path=${SCHEMA}`,
        max: 2,
      });
      await migrate(fresh);
      await migrate(fresh); // idempotent
      const store = new PostgresTimerStore(fresh);
      try {
        await store.schedule({ executionId: "r", wakeAt: 60, refused: { head: 7 } });
        expect(await store.due(100)).toEqual([
          { executionId: "old", wakeAt: 50 },
          { executionId: "r", wakeAt: 60, refused: { head: 7 } },
        ]);
        expect(await store.due(100, 10, { refused: false })).toEqual([
          { executionId: "old", wakeAt: 50 },
        ]);
      } finally {
        await store.close();
        await fresh.end();
      }
    });
  });
}
