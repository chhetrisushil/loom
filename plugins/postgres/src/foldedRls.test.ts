import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresReadModelStore } from "./PostgresReadModelStore";
import { foldedStateDdl } from "./foldedState";
import type { PoolLike } from "./pool";

// ADR 0132 D10: caller-chosen placement + a scope column an RLS policy can key on (the DocMind
// shape). Gated on LOOM_TEST_POSTGRES_URL like the sibling suites (the value is never printed).
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SUFFIX = `${process.pid}_${randomBytes(3).toString("hex")}`;
const SCHEMA = `loom_rls_${SUFFIX}`;
const READER = `loom_rls_reader_${SUFFIX}`;
const NAMES = { schema: SCHEMA, tables: { state: "doc_status", folds: "doc_status_folds" } };

if (PG_URL === undefined) {
  describe.skip("folded state under row-level security (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  }, 60_000);

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${READER}`).catch(() => undefined);
    await admin.end();
  }, 60_000);

  describe("folded state under row-level security (ADR 0132 D10)", () => {
    it("a scoped reader sees only its scope; the owner writes and reads everything; the reader issues no DDL", async (ctx) => {
      // The app's migration: our DDL, then its role and policy. Skip (not fail) if this user may not.
      try {
        await admin.query(foldedStateDdl(NAMES));
        await admin.query(`CREATE ROLE ${READER} NOLOGIN`);
        await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${READER}`);
        await admin.query(
          `GRANT SELECT ON ${SCHEMA}.doc_status, ${SCHEMA}.doc_status_folds TO ${READER}`
        );
        await admin.query(`ALTER TABLE ${SCHEMA}.doc_status ENABLE ROW LEVEL SECURITY`);
        await admin.query(
          `CREATE POLICY scope_read ON ${SCHEMA}.doc_status FOR SELECT TO ${READER}
             USING (scope = current_setting('app.scope', true))`
        );
      } catch {
        return ctx.skip();
      }

      // Ingest side: the table owner (bypasses RLS). No lazy DDL: the app owns the schema.
      const writer = new PostgresReadModelStore(admin, { ...NAMES, manageSchema: false });
      await writer.beginFold("docs", "v1");
      const base = {
        modelId: "docs",
        upToSequence: 1,
        state: { status: "done" },
        key: "k",
        foldVersion: "v1",
      };
      await writer.applyFolded({ ...base, executionId: "u1:wf:a", scope: "u1" });
      await writer.applyFolded({ ...base, executionId: "u2:wf:b", scope: "u2" });
      const both = ["u1:wf:a", "u2:wf:b"];
      expect((await writer.getFolded("docs", both)).map((r) => r.executionId)).toEqual(both);

      // Request side: ONE connection, so the session role and setting cannot leak to or from another.
      const readerPool = new Pool({ connectionString: PG_URL, max: 1, idleTimeoutMillis: 0 });
      const issued: string[] = [];
      const spy: PoolLike = {
        query: ((...args: unknown[]) => {
          const q = args[0];
          issued.push(typeof q === "string" ? q : String((q as { text?: string }).text));
          return (readerPool.query as (...a: unknown[]) => unknown)(...args);
        }) as Pool["query"],
        connect: readerPool.connect.bind(readerPool) as Pool["connect"],
        end: readerPool.end.bind(readerPool) as Pool["end"],
      };
      try {
        try {
          await readerPool.query(`SET ROLE ${READER}`);
        } catch {
          return ctx.skip();
        }
        await readerPool.query("SELECT set_config('app.scope', 'u1', false)");
        const reader = new PostgresReadModelStore(spy, { ...NAMES, manageSchema: false });
        expect((await reader.getFolded("docs", both)).map((r) => r.executionId)).toEqual([
          "u1:wf:a",
        ]);
        expect((await reader.getFoldedByKey("docs", ["k"])).map((r) => r.executionId)).toEqual([
          "u1:wf:a",
        ]);
        expect(await reader.getFolded("docs", ["u2:wf:b"])).toEqual([]);
        expect(issued.length).toBeGreaterThan(0);
        expect(issued.filter((q) => /\b(CREATE|ALTER|DROP|BEGIN)\b/i.test(q))).toEqual([]);
      } finally {
        await readerPool.query("RESET ROLE").catch(() => undefined);
        await readerPool.query("RESET app.scope").catch(() => undefined);
        await readerPool.end();
      }

      // Placement: the caller's tables exist in the caller's schema; the default names were never created there.
      const placed = await admin.query(
        "SELECT to_regclass($1) AS chosen, to_regclass($2) AS dflt",
        [`"${SCHEMA}"."doc_status"`, `"${SCHEMA}"."read_model_state"`]
      );
      expect(placed.rows[0]?.chosen).not.toBeNull();
      expect(placed.rows[0]?.dflt).toBeNull();
    });
  });
}
