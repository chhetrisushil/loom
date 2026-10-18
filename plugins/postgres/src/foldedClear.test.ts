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
}
