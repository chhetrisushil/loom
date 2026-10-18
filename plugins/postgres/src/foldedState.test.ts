import { afterAll, describe, expect, it } from "vitest";
import { PostgresReadModelStore } from "./PostgresReadModelStore";
import { ensureFoldedTables, foldedNames, foldedStateDdl } from "./foldedState";
import type { PoolLike } from "./pool";
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

  it("refuses non-strings and a stateful toString (no validate/interpolate split)", () => {
    let n = 0;
    const evil = { toString: () => (n++ === 0 ? "x" : 'x" ON t(a); DROP TABLE victim; --') };
    expect(() => foldedNames({ tables: { state: evil as unknown as string } })).toThrow(TypeError);
    expect(() => foldedNames({ schema: 5 as unknown as string })).toThrow(TypeError);
  });

  it("refuses identical state/folds tables and the shared Loom table names", () => {
    expect(() => foldedNames({ tables: { state: "t", folds: "t" } })).toThrow(TypeError);
    expect(() => foldedNames({ tables: { state: "read_model_rows" } })).toThrow(TypeError);
    expect(() => foldedNames({ tables: { folds: "events" } })).toThrow(TypeError);
  });

  it("declares execution_id with the C collation", () => {
    expect(foldedStateDdl()).toContain('execution_id TEXT COLLATE "C" NOT NULL');
  });

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

class Probe extends PostgresReadModelStore {
  ensure(): Promise<void> {
    return this.ensureFolded();
  }
}

describe("manageSchema:false", () => {
  it("issues zero DDL on construction, ensureFolded and clear", async () => {
    const seen: string[] = [];
    const rec = async (sql: string) => {
      seen.push(sql);
      return { rows: [{ s: null, f: null }], rowCount: 0 };
    };
    const pool = {
      query: rec,
      connect: async () => ({ query: rec, release: () => undefined }),
      end: async () => undefined,
    } as unknown as PoolLike;
    const store = new Probe(pool, { schema: "docmind", manageSchema: false });
    await store.ensure();
    expect(seen).toEqual([]);
    await store.clear("m");
    expect(seen.filter((q) => /CREATE|ALTER|DROP/i.test(q))).toEqual([]);
  });
});

const url = process.env.LOOM_TEST_POSTGRES_URL;
describe.skipIf(!url)("folded-state ensure (postgres)", () => {
  const schema = `frm12a_${process.pid}`;
  const role = `frm12a_dml_${process.pid}`;
  const pool = url ? postgresPool({ connectionString: url, max: 1 }) : undefined;
  afterAll(async () => {
    await pool?.query("RESET ROLE").catch(() => undefined);
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool?.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    await pool?.end();
  });

  it("ensureFoldedTables is idempotent and creates both tables in the schema", async () => {
    if (!pool) return;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const names = foldedNames({ schema });
    await ensureFoldedTables(pool, names);
    await ensureFoldedTables(pool, names);
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
      [schema]
    );
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      "read_model_folds",
      "read_model_state",
    ]);
  });

  it("a DML-only role ensures against owner-created tables without DDL", async (ctx) => {
    if (!pool) return;
    try {
      await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
    } catch {
      ctx.skip();
      return;
    }
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await pool.query(foldedStateDdl({ schema }));
    await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`
    );
    await migrate(pool);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON read_model_rows, read_model_watermarks TO "${role}"`
    );
    await pool.query(`SET ROLE "${role}"`);
    try {
      const store = new Probe(pool, { schema, manageSchema: true });
      await expect(store.ensure()).resolves.toBeUndefined();
      await expect(store.clear("m")).resolves.toBeUndefined();
    } finally {
      await pool.query("RESET ROLE");
    }
  });

  it("clear() never creates the folded tables", async () => {
    if (!pool) return;
    await migrate(pool);
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
