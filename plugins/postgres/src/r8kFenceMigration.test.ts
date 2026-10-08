import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresTimerStore } from "./PostgresTimerStore";
import { backfillParkFences, migrate } from "./schema";

// ADR 0118 (R8k review round 1) — the migration's two one-time steps:
//  - P3-2: backfill the token-0 fence row of every execution PARKED before this version;
//  - P3-5: the timers `redrive` column is added by a bounded, catalog-guarded ALTER (no ACCESS
//    EXCLUSIVE on every boot).
// Gated on LOOM_TEST_POSTGRES_URL like the rest.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SCHEMA = `loom_r8k_mig_${process.pid}`;

if (PG_URL === undefined) {
  describe.skip("R8k migration (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  const fresh = () =>
    new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}`, max: 4 });
  const admin = async <T>(f: (p: Pool) => Promise<T>): Promise<T> => {
    const p = new Pool({ connectionString: PG_URL });
    try {
      return await f(p);
    } finally {
      await p.end();
    }
  };
  beforeAll(async () => {
    await admin(async (p) => {
      await p.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await p.query(`CREATE SCHEMA ${SCHEMA}`);
    });
  });
  afterAll(async () => {
    await admin((p) => p.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
  });

  const ev = (executionId: string, sequence: number, eventType: string) => ({
    id: `${executionId}-${sequence}`,
    workflowId: "w",
    executionId,
    eventType,
    sequence,
    timestamp: sequence,
    payload: {},
  });
  const fenceRows = async (pool: Pool) =>
    (
      await pool.query<{ execution_id: string; fence: string }>(
        "SELECT execution_id, fence FROM fences ORDER BY execution_id"
      )
    ).rows.map((r) => [r.execution_id, Number(r.fence)]);

  describe("R8k D1 — one-time park-fence backfill (P3-2)", () => {
    it("fences a park written before this version, once; an answered one gets none; a real token is untouched", async () => {
      const a = fresh();
      await migrate(a); // schema + marker (empty log)
      // simulate a PRE-VERSION log: parks written without their fence rows, marker absent
      for (const id of ["parked", "answered", "tokened"]) {
        await a.query(
          "INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload) VALUES ($1,'w',$2,'EXECUTION_STARTED',0,0,'{}'), ($3,'w',$2,'EXECUTION_SUSPENDED',1,1,'{}')",
          [`${id}-0`, id, `${id}-1`]
        );
      }
      await a.query(
        "INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload) VALUES ('answered-2','w','answered','EXECUTION_RESUMED',2,2,'{}')"
      );
      await a.query("INSERT INTO fences (execution_id, fence) VALUES ('tokened', 7)");
      await a.query("COMMENT ON TABLE fences IS NULL");
      await a.end();

      const b = fresh(); // a fresh pool re-runs the migration
      await migrate(b);
      expect(await fenceRows(b)).toEqual([
        ["parked", 0],
        ["tokened", 7],
      ]);
      // once: the marker stops a second backfill (delete the row, re-migrate on yet another pool)
      await b.query("DELETE FROM fences WHERE execution_id = 'parked'");
      await b.end();
      const c = fresh();
      await migrate(c);
      expect(await fenceRows(c)).toEqual([["tokened", 7]]);

      // and the backfilled row is what makes the FIRST conditional acquire safe: it exists
      await c.query("COMMENT ON TABLE fences IS NULL");
      await c.end();
      const d = fresh();
      const store = new PostgresEventStore(d);
      await store.acquireFence("never-parked");
      expect(await fenceRows(d)).toContainEqual(["parked", 0]);
      await store.close();
    });

    it("opt-out skips the boot backfill; backfillParkFences (batched, temp index dropped) does it offline, once", async () => {
      const a = fresh();
      await migrate(a);
      await a.query("DELETE FROM events"); // earlier cases left parks in this schema
      for (const id of ["o1", "o2", "o3", "o4"]) {
        await a.query(
          "INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload) VALUES ($1,'w',$2,'EXECUTION_STARTED',0,0,'{}'), ($3,'w',$2,'EXECUTION_SUSPENDED',1,1,'{}')",
          [`${id}-0`, id, `${id}-1`]
        );
      }
      await a.query(
        "INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload) VALUES ('o2-2','w','o2','EXECUTION_RESUMED',2,2,'{}')"
      );
      await a.query("DELETE FROM fences");
      await a.query("COMMENT ON TABLE fences IS NULL");
      await a.end();

      const b = fresh();
      await migrate(b, { backfillParkFences: false });
      expect((await fenceRows(b)).map((r) => r[0])).not.toContain("o1"); // skipped at boot
      const r = await backfillParkFences(b, { batchSize: 2 }); // 4 executions = 2 batches
      expect(r.inserted).toBe(3);
      expect((await fenceRows(b)).map((x) => x[0])).toEqual(["o1", "o3", "o4"]);
      const idx = await b.query(
        "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_suspended_r8k_tmp' AND schemaname = current_schema()"
      );
      expect(idx.rowCount).toBe(0); // the temporary index is gone
      expect((await backfillParkFences(b)).inserted).toBe(0); // marker: runs once
      await b.end();
    });

    it("deleteExecution removes the inert token-0 row but KEEPS a real token (P3-4)", async () => {
      const p = fresh();
      const store = new PostgresEventStore(p);
      await store.append(ev("d0", 0, "EXECUTION_STARTED"));
      await store.append(ev("d0", 1, "EXECUTION_SUSPENDED"));
      await store.append(ev("d1", 0, "EXECUTION_STARTED"));
      await store.append(ev("d1", 1, "EXECUTION_SUSPENDED"));
      await store.acquireFence("d1");
      expect(await fenceRows(p)).toEqual(
        expect.arrayContaining([
          ["d0", 0],
          ["d1", 1],
        ])
      );
      await store.deleteExecution("d0");
      await store.deleteExecution("d1");
      const rows = await fenceRows(p);
      expect(rows).not.toContainEqual(["d0", 0]);
      expect(rows).toContainEqual(["d1", 1]);
      await store.close();
    });
  });

  describe("R8k D4 — bounded timers.redrive migration (P3-5)", () => {
    it("an already-migrated table is NOT altered on boot: an open reader does not block the migration", async () => {
      const p = fresh();
      await migrate(p);
      await p.end();
      const reader = fresh();
      const rc = await reader.connect();
      await rc.query("BEGIN");
      await rc.query("SELECT count(*) FROM timers"); // ACCESS SHARE held for the whole test
      const q = fresh();
      const t0 = Date.now();
      // pre-fix: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` waits for ACCESS EXCLUSIVE behind it
      await migrate(q, { lockTimeoutMs: 20_000 });
      expect(Date.now() - t0).toBeLessThan(10_000); // timing-bound: a blocked migration waits the 20 s lockTimeout
      await rc.query("ROLLBACK");
      rc.release();
      await reader.end();
      await q.end();
    });

    it("an OLD-shape table behind an open reader fails the boot within lockTimeoutMs (retryable), then succeeds once released", async () => {
      const setup = fresh();
      await setup.query("DROP TABLE IF EXISTS timers");
      await setup.query(`CREATE TABLE timers (
        execution_id TEXT NOT NULL, wake_at BIGINT NOT NULL, PRIMARY KEY (execution_id, wake_at))`);
      await setup.end();
      const reader = fresh();
      const rc = await reader.connect();
      await rc.query("BEGIN");
      await rc.query("SELECT count(*) FROM timers");
      const q = fresh();
      const t0 = Date.now();
      await expect(migrate(q, { lockTimeoutMs: 400 })).rejects.toThrow(
        /lock timeout|lock_timeout|lock/i
      );
      expect(Date.now() - t0).toBeLessThan(10_000); // timing-bound: an ignored lock_timeout hangs until the reader is released
      await rc.query("ROLLBACK");
      rc.release();
      await reader.end();
      await migrate(q, { lockTimeoutMs: 400 }); // not cached: retryable
      const store = new PostgresTimerStore(q);
      await store.schedule({ executionId: "x", wakeAt: 1, redrive: { attempt: 1 } });
      expect(await store.due(10)).toEqual([
        { executionId: "x", wakeAt: 1, redrive: { attempt: 1 } },
      ]);
      await store.close();
    });
  });
}
