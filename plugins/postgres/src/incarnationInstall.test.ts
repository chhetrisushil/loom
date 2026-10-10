import type { EventEnvelope } from "@loom/core";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import type { PoolLike } from "./pool";
import { migrate } from "./schema";

// ADR 0129 install/lookup availability (review round 1): each case is a probe against REAL
// Postgres, in a schema of its own. Gated on LOOM_TEST_POSTGRES_URL like the rest.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const TAG = `${process.pid}`;
const schemas: string[] = [];
const roles: string[] = [];

const evt = (executionId: string, sequence: number, timestamp = 1_000): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "EXECUTION_STARTED",
  sequence,
  timestamp,
  payload: {},
});

const OLD_EVENTS = (schema: string, collate = "") => `CREATE TABLE ${schema}.events (
  id TEXT NOT NULL PRIMARY KEY, workflow_id TEXT NOT NULL,
  execution_id TEXT ${collate} NOT NULL, event_type TEXT NOT NULL,
  sequence BIGINT NOT NULL, timestamp BIGINT NOT NULL, payload JSONB NOT NULL,
  metadata JSONB, UNIQUE (execution_id, sequence))`;

if (PG_URL === undefined) {
  describe.skip("incarnation install (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  const url = PG_URL;
  const admin = async (sql: string): Promise<void> => {
    const a = new Pool({ connectionString: url });
    try {
      await a.query(sql);
    } finally {
      await a.end();
    }
  };
  const mkSchema = async (name: string, oldEvents = ""): Promise<string> => {
    const s = `loom_inc_${name}_${TAG}`;
    schemas.push(s);
    await admin(`DROP SCHEMA IF EXISTS ${s} CASCADE; CREATE SCHEMA ${s}`);
    if (oldEvents !== "") await admin(oldEvents.replaceAll("$S", s));
    return s;
  };
  const poolFor = (schema: string, user?: string): Pool => {
    const u = new URL(url);
    if (user !== undefined) u.username = user;
    return new Pool({
      connectionString: u.toString(),
      options: `-c search_path=${schema}`,
      max: 4,
    });
  };
  const hasColumn = async (pool: Pool): Promise<boolean> =>
    ((
      await pool.query(
        "SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('events') AND attname = 'incarnation' AND NOT attisdropped"
      )
    ).rowCount ?? 0) > 0;

  afterAll(async () => {
    for (const s of schemas) await admin(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    for (const r of roles) await admin(`DROP ROLE IF EXISTS ${r}`);
  });

  describe("PostgresEventStore incarnation install (ADR 0129, review fixes)", () => {
    it("P2-1: a dependent view blocks the L10 collation conversion on EVERY boot, but the incarnation still installs, quietly, and stale writes are refused", async () => {
      // Probe A: old-shape events (default collation, so L10 tries to convert) + a view on the
      // column (so the conversion fails with dependent_objects_still_exist on every boot).
      const s = await mkSchema(
        "a",
        `${OLD_EVENTS("$S")}; CREATE VIEW $S.ev AS SELECT execution_id FROM $S.events`
      );
      const warns: string[] = [];
      let pool = poolFor(s);
      try {
        for (let boot = 0; boot < 3; boot++) {
          pool = poolFor(s); // a fresh pool per boot: the migration memo is per pool
          await migrate(pool, { onWarn: (m) => warns.push(m) });
        }
        expect(await hasColumn(pool)).toBe(true);
        expect(warns).toEqual([]); // the install happened: nothing to be loud about
        const store = new PostgresEventStore(pool);
        await store.append(evt("e", 0));
        await store.append(evt("e", 1));
        const seen = (await store.appendIfUnchanged!("e", null)) as { anchor: string };
        expect(seen.anchor).not.toContain(":");
        await store.deleteExecution!("e");
        await store.append(evt("e", 0));
        await store.append(evt("e", 1));
        expect(
          await store.appendIfUnchanged!("e", evt("e", 2), {
            head: 1,
            fence: 0,
            anchor: seen.anchor,
          })
        ).toMatchObject({ appended: false, reason: "moved" });
        expect(await store.incarnationAnchors()).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it("P2-1: when the install really cannot happen (events locked), boot warns ONCE with the cause, keeps working on the legacy anchor and reports incarnationAnchors() false", async () => {
      const s = await mkSchema("lock", OLD_EVENTS("$S"));
      const holder = new Pool({ connectionString: url, max: 1 });
      const hc = await holder.connect();
      const pool = poolFor(s);
      try {
        await hc.query("BEGIN");
        await hc.query(`LOCK TABLE ${s}.events IN SHARE MODE`); // blocks ALTER, not CREATE INDEX
        const warns: string[] = [];
        const store = new PostgresEventStore(pool, {
          migrationLockTimeoutMs: 200,
          onWarn: (m) => warns.push(m),
        });
        expect(await store.incarnationAnchors()).toBe(false);
        expect(warns).toHaveLength(1);
        expect(warns[0]).toMatch(/did NOT install/);
        expect(warns[0]).toMatch(/locked/);
        await hc.query("ROLLBACK");
        await store.close();
      } finally {
        hc.release();
        await holder.end();
        await pool.end();
      }
    });

    it("P3-5: a node that saw no column re-probes (rate-limited by an injectable clock) and picks the column up when another node installs it; true is cached for good", async () => {
      const s = await mkSchema("late", OLD_EVENTS("$S"));
      const holder = new Pool({ connectionString: url, max: 1 });
      const hc = await holder.connect();
      const poolA = poolFor(s);
      const poolB = poolFor(s);
      let now = 1_000_000;
      let probes = 0;
      const counting: PoolLike = {
        connect: poolA.connect.bind(poolA),
        end: poolA.end.bind(poolA),
        query: ((...a: unknown[]) => {
          if (typeof a[0] === "string" && a[0].includes("attname = 'incarnation'")) probes++;
          return (poolA.query as (...x: unknown[]) => unknown)(...a);
        }) as Pool["query"],
      };
      try {
        await hc.query("BEGIN");
        await hc.query(`LOCK TABLE ${s}.events IN SHARE MODE`);
        const storeA = new PostgresEventStore(counting, {
          migrationLockTimeoutMs: 200,
          onWarn: () => {},
          clock: () => now,
          incarnationRecheckMs: 10_000,
        });
        expect(await storeA.incarnationAnchors()).toBe(false);
        await hc.query("ROLLBACK");
        await migrate(poolB); // node B installs later
        expect(await hasColumn(poolB)).toBe(true);
        expect(await storeA.incarnationAnchors()).toBe(false); // within the window: no re-probe
        expect(probes).toBe(1);
        now += 10_000; // the window passes
        expect(await storeA.incarnationAnchors()).toBe(true);
        expect(probes).toBe(2);
        expect(await storeA.incarnationAnchors()).toBe(true);
        expect(probes).toBe(2); // true is cached
        await storeA.append(evt("n", 0));
        const r = (await storeA.appendIfUnchanged!("n", null)) as { anchor: string };
        expect(r.anchor).not.toContain(":");
      } finally {
        hc.release();
        await holder.end();
        await poolA.end();
        await poolB.end();
      }
    });

    it("P2-2: one transient failure of the column probe fails THAT call only; the next call succeeds (a rejection is never cached)", async () => {
      const s = await mkSchema("flaky");
      const real = poolFor(s);
      let failNext = false;
      const flaky: PoolLike = {
        connect: real.connect.bind(real),
        end: real.end.bind(real),
        query: ((...a: unknown[]) => {
          if (failNext && typeof a[0] === "string" && a[0].includes("attname = 'incarnation'")) {
            failNext = false;
            return Promise.reject(new Error("connection reset"));
          }
          return (real.query as (...x: unknown[]) => unknown)(...a);
        }) as Pool["query"],
      };
      try {
        const store = new PostgresEventStore(flaky);
        await store.append(evt("f", 0));
        failNext = true;
        await expect(store.appendIfUnchanged!("f", null)).rejects.toThrow(/connection reset/);
        expect(await store.appendIfUnchanged!("f", null)).toMatchObject({
          appended: false,
          reason: "observed",
        });
        expect(await store.incarnationAnchors()).toBe(true);
      } finally {
        await real.end();
      }
    });

    it("P3-4: the trigger function draws from ITS schema's sequence whatever the inserting session's search_path is", async () => {
      const s1 = await mkSchema("sp1");
      const s2 = await mkSchema("sp2");
      const p1 = poolFor(s1);
      const p2 = poolFor(s2);
      try {
        await migrate(p1);
        await migrate(p2);
        const c = await new Pool({ connectionString: url, max: 1 }).connect();
        try {
          const ins = (schema: string, id: string): Promise<unknown> =>
            c.query(
              `INSERT INTO ${schema}.events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload)
               VALUES ($1, 'wf', $1, 'EXECUTION_STARTED', 0, 1, '{}'::jsonb)`,
              [id]
            );
          await c.query("SET search_path = ''"); // pg_restore --data-only / schema-qualified ETL
          await ins(s1, "empty-path");
          await c.query(`SET search_path = ${s2}, ${s1}`); // ANOTHER loom schema first
          await ins(s1, "other-first");
          await ins(s1, "other-first-2");
          const inc = await c.query(
            `SELECT execution_id, incarnation FROM ${s1}.events ORDER BY incarnation`
          );
          expect(inc.rows.map((r) => r.execution_id)).toEqual([
            "empty-path",
            "other-first",
            "other-first-2",
          ]);
          const seq1 = await c.query(
            `SELECT last_value, is_called FROM ${s1}.events_incarnation_seq`
          );
          const seq2 = await c.query(`SELECT is_called FROM ${s2}.events_incarnation_seq`);
          expect(Number(seq1.rows[0].last_value)).toBe(3);
          expect(seq2.rows[0].is_called).toBe(false); // the other schema's counter was never drawn
        } finally {
          c.release();
        }
      } finally {
        await p1.end();
        await p2.end();
      }
    });

    describe("P2-3: re-owned tables (an application role)", () => {
      const setup = async (name: string): Promise<{ s: string; app: Pool }> => {
        const s = await mkSchema(name);
        const role = `loom_app_${name}_${TAG}`;
        const boot = poolFor(s);
        await migrate(boot); // the migrator (superuser) installs everything
        await boot.end();
        await admin(`CREATE ROLE ${role} LOGIN`);
        roles.push(role);
        await admin(`
          DO $$ DECLARE r record; BEGIN
            FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = '${s}' LOOP
              EXECUTE format('ALTER TABLE ${s}.%I OWNER TO ${role}', r.tablename);
            END LOOP;
          END $$;
          ALTER SCHEMA ${s} OWNER TO ${role};
          GRANT USAGE ON SCHEMA ${s} TO ${role}`);
        return { s, app: poolFor(s, role) };
      };

      it("boots (and `ready` resolves) when the function is owned by someone else", async () => {
        const { app } = await setup("own");
        try {
          const warns: string[] = [];
          const store = new PostgresEventStore(app, { onWarn: (m) => warns.push(m) });
          await store.append(evt("o", 0));
          expect(await store.incarnationAnchors()).toBe(true);
          expect(warns).toEqual([]);
        } finally {
          await app.end();
        }
      });

      it("fails SOFT (a warning, boot continues) when an out-of-date function would need replacing", async () => {
        const { s, app } = await setup("stale");
        try {
          await admin(
            `COMMENT ON FUNCTION ${s}.events_assign_incarnation() IS 'loom-incarnation-v0'`
          );
          const warns: string[] = [];
          const store = new PostgresEventStore(app, { onWarn: (m) => warns.push(m) });
          await store.append(evt("o", 0)); // `ready` resolved; the old function still assigns
          expect(warns).toHaveLength(1);
          expect(warns[0]).toMatch(/42501|permission|owner/i);
        } finally {
          await app.end();
        }
      });
    });
  });
}
