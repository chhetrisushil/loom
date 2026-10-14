import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./schema";

// An already-migrated database must migrate WITHOUT touching a table lock: `CREATE INDEX IF NOT
// EXISTS` takes SHARE on the table before noticing the index exists, and (lock_timeout=0) hangs
// behind a long-held SHARE UPDATE EXCLUSIVE lock such as an anti-wraparound autovacuum. Gated on
// LOOM_TEST_POSTGRES_URL like the rest.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SCHEMA = `loom_heldlock_${process.pid}`;

if (PG_URL === undefined) {
  describe.skip("migrate under a held table lock (needs LOOM_TEST_POSTGRES_URL)", () => {});
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

  describe("migrate under a held SHARE UPDATE EXCLUSIVE lock", () => {
    it("completes on a migrated database while the hot tables are held", async () => {
      await migrate(pool); // first boot creates everything
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        for (const t of ["events", "snapshots", "timers", "leases", "lineage"]) {
          await holder.query(`LOCK TABLE ${t} IN SHARE UPDATE EXCLUSIVE MODE`);
        }
        let timer: NodeJS.Timeout | undefined;
        // a FRESH pool: `migrate` memoises per pool, so the first pool would skip all DDL
        const second = new Pool({
          connectionString: PG_URL,
          options: `-c search_path=${SCHEMA}`,
          max: 2,
        });
        const outcome = await Promise.race([
          migrate(second).then(() => "done"),
          // timing-bound: a hang is the failure being tested; a healthy migrate is milliseconds.
          new Promise<string>((r) => {
            timer = setTimeout(() => r("hung"), 8000);
          }),
        ]);
        clearTimeout(timer);
        if (outcome === "hung") {
          // release the lock so the hung migrate (and the pool) can finish before we fail
          await holder.query("ROLLBACK");
        }
        await second.end();
        expect(outcome).toBe("done");
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    }, 30_000);
  });
}
