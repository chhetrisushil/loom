import { afterAll, describe, expect, it } from "vitest";
import { PostgresReadModelStore } from "./PostgresReadModelStore";
import { ensureFoldedTables, foldedNames, foldedStateDdl } from "./foldedState";
import { postgresPool } from "./preset";
import { migrate } from "./schema";

describe("folded-state placement (ADR 0132 D10)", () => {
  it("defaults to unqualified read_model_state / read_model_folds", () => {
    expect(foldedNames()).toMatchObject({
      state: '"read_model_state"',
      folds: '"read_model_folds"',
    });
  });

  it("qualifies a caller-chosen schema and table names", () => {
    const n = foldedNames({
      schema: "docmind",
      tables: { state: "doc_status", folds: "doc_status_folds" },
    });
    expect(n.state).toBe('"docmind"."doc_status"');
    expect(n.folds).toBe('"docmind"."doc_status_folds"');
  });

  it.each(['a"b', "a b", "1abc", "", "x".repeat(49), "a;DROP"])(
    "refuses the identifier %j",
    (bad) => {
      expect(() => foldedNames({ schema: bad })).toThrow(TypeError);
      expect(() => foldedNames({ tables: { state: bad } })).toThrow(TypeError);
      expect(
        () =>
          new PostgresReadModelStore("postgres://invalid.invalid/x", {
            schema: bad,
            manageSchema: false,
          })
      ).toThrow(TypeError);
    }
  );

  it("accepts a 48-character identifier", () => {
    expect(() => foldedNames({ tables: { state: "x".repeat(48) } })).not.toThrow();
  });

  it("emits a scope column, a key index and a scope index for the RLS policy to use", () => {
    const ddl = foldedStateDdl({ schema: "docmind" });
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "docmind"."read_model_state"');
    expect(ddl).toMatch(/scope TEXT/);
    expect(ddl).toMatch(/\(model_id, app_key\)/);
    expect(ddl).toMatch(/\(model_id, scope\)/);
  });
});

const url = process.env.LOOM_TEST_POSTGRES_URL;
describe.skipIf(!url)("folded-state ensure (postgres)", () => {
  const schema = `frm12a_${process.pid}`;
  const pool = url ? postgresPool(url) : undefined;
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.end();
  });

  it("ensureFoldedTables is idempotent and creates both tables in the schema", async () => {
    if (!pool) return;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await ensureFoldedTables(pool, { schema });
    await ensureFoldedTables(pool, { schema });
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
      [schema]
    );
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      "read_model_folds",
      "read_model_state",
    ]);
  });

  it("manageSchema:false runs no DDL, and clear() never creates the folded tables", async () => {
    if (!pool) return;
    await migrate(pool); // the shared tables exist (an app migration owns them); only folded ones are absent
    const store = new PostgresReadModelStore(pool, {
      schema: `${schema}_none`,
      manageSchema: false,
    });
    await expect(store.clear("m")).resolves.toBeUndefined();
    const { rows } = await pool.query("SELECT to_regclass($1) AS t", [
      `"${schema}_none"."read_model_state"`,
    ]);
    expect(rows[0].t).toBeNull();
  });
});
