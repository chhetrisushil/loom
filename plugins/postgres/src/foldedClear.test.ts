import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresReadModelStore } from "./PostgresReadModelStore";

// ADR 0132 D6/D10: `clear` must not create the folded tables. A store that never used a folded model
// (or whose role cannot run DDL) must clear row models exactly as it did at SPI 1.1.0.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SCHEMA = `loom_fclear_${process.pid}`;

if (PG_URL === undefined) {
  describe.skip("PostgresReadModelStore.clear without folded models (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  let admin: Pool;
  let pool: Pool;
  const exists = async (table: string): Promise<boolean> =>
    (await admin.query("SELECT to_regclass($1) AS r", [`"${SCHEMA}"."${table}"`])).rows[0]?.r !==
    null;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}`, max: 2 });
  }, 60_000);
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  }, 60_000);

  describe("PostgresReadModelStore.clear without folded models (ADR 0132 D6/D10)", () => {
    it("clears row models and creates no folded table", async () => {
      const store = new PostgresReadModelStore(pool);
      await store.apply("m", "x-1", 0, []);
      await store.clear("m");
      expect(await store.watermark("m", "x-1")).toBeNull();
      expect(await exists("read_model_state")).toBe(false);
      expect(await exists("read_model_folds")).toBe(false);
    });

    it("once a folded model was used, clear drops its states and header too", async () => {
      const store = new PostgresReadModelStore(pool);
      await store.beginFold("f", "v1");
      await store.applyFolded({
        modelId: "f",
        executionId: "x-1",
        upToSequence: 1,
        state: { n: 1 },
        key: null,
        scope: null,
        foldVersion: "v1",
      });
      await store.clear("f");
      expect(await store.getFolded("f", ["x-1"])).toEqual([]);
      expect(await exists("read_model_state")).toBe(true);
      // header gone too: a different version is a fresh model, not a rebuild
      expect(await store.beginFold("f", "v2")).toEqual({ rebuilt: false });
    });
  });

  describe("applyFolded vs a concurrent beginFold (ADR 0132 D5)", () => {
    it("a writer blocked on the header lock reports version-mismatch, never stale, and stores nothing", async () => {
      const store = new PostgresReadModelStore(pool);
      await store.beginFold("race", "v1");
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          `INSERT INTO read_model_folds (model_id, version) VALUES ('race', 'v2')
           ON CONFLICT (model_id) DO UPDATE SET version = EXCLUDED.version`
        );
        const pending = store.applyFolded({
          modelId: "race",
          executionId: "x-9",
          upToSequence: 1,
          state: { n: 1 },
          key: null,
          scope: null,
          foldVersion: "v1",
        });
        // timing-bound: wait (condition poll, 10 s cap) until the writer is blocked on the lock.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { rows } = await admin.query(
            `SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%WITH h AS%'`
          );
          if (rows.length > 0) break;
          if (Date.now() > deadline)
            throw new Error("applyFolded never blocked on the header lock");
          await new Promise((r) => setTimeout(r, 25));
        }
        await holder.query("COMMIT");
        expect(await pending).toBe("version-mismatch");
        expect(await store.getFolded("race", ["x-9"])).toEqual([]);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    });
  });
}
