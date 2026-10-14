import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLeaseStore } from "./PostgresLeaseStore";
import { migrate } from "./schema";

// ADR 0130 D11 / S7a — the leases table is small, hot and update-churned: HOT updates need
// fillfactor < 100 and the dead tuples need an aggressive per-table autovacuum. `CREATE TABLE IF
// NOT EXISTS` never changes a table an older version created, so the options have their own
// guarded, idempotent migration. Gated on LOOM_TEST_POSTGRES_URL like the rest.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const SCHEMA = `loom_lease_mig_${process.pid}`;

if (PG_URL === undefined) {
  describe.skip("PostgresLeaseStore schema (needs LOOM_TEST_POSTGRES_URL)", () => {});
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

  const options = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ reloptions: string[] | null }>(
      "SELECT reloptions FROM pg_class WHERE oid = 'leases'::regclass"
    );
    return rows[0]?.reloptions ?? [];
  };

  describe("PostgresLeaseStore schema (ADR 0130 D11)", () => {
    it("an OLD-shape leases table gains fillfactor + autovacuum options, keeps its rows, idempotently", async () => {
      await pool.query(`CREATE TABLE leases (
        execution_id TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL)`);
      await pool.query("INSERT INTO leases VALUES ('old', 'n', 5)");
      expect(await options()).toEqual([]);
      await migrate(pool);
      const first = await options();
      expect(first).toContain("fillfactor=70");
      expect(first.some((o) => o.startsWith("autovacuum_vacuum_scale_factor="))).toBe(true);
      await migrate(pool); // a second boot changes nothing
      expect(await options()).toEqual(first);
      const store = new PostgresLeaseStore(pool);
      try {
        expect((await store.get("old"))?.owner).toBe("n");
      } finally {
        await store.close();
      }
    });

    it("an operator-tuned table is left alone (the guard only fills a table with NO options)", async () => {
      await pool.query("ALTER TABLE leases SET (fillfactor = 50)");
      await migrate(pool);
      expect(await options()).toContain("fillfactor=50");
    });

    it("fails SOFT when the optional storage ALTER cannot get its lock: migrate succeeds with a warning, a later boot applies the options", async () => {
      const schema = `${SCHEMA}_soft`;
      const admin = new Pool({ connectionString: PG_URL });
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`CREATE TABLE ${schema}.leases (
        execution_id TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL)`);
      const opts = `-c search_path=${schema} -c loom.migration_lock_timeout=200ms`;
      const blocker = new Pool({ connectionString: PG_URL, options: opts, max: 1 });
      const boot1 = new Pool({ connectionString: PG_URL, options: opts, max: 4 });
      const boot2 = new Pool({ connectionString: PG_URL, options: opts, max: 4 });
      const holder = await blocker.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE leases IN SHARE MODE"); // conflicts with SHARE UPDATE EXCLUSIVE
        await expect(migrate(boot1)).resolves.toBeUndefined();
        const read = async () =>
          (
            await admin.query<{ reloptions: string[] | null }>(
              "SELECT reloptions FROM pg_class WHERE oid = to_regclass($1)",
              [`${schema}.leases`]
            )
          ).rows[0]?.reloptions ?? [];
        expect(await read()).toEqual([]);
        await holder.query("ROLLBACK");
        const store = new PostgresLeaseStore(boot1);
        try {
          expect(await store.acquire("x", "n", 60_000)).not.toBeNull();
        } finally {
          await store.close();
        }
        await migrate(boot2); // a later boot retries and applies them
        expect(await read()).toContain("fillfactor=70");
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await blocker.end();
        await boot1.end();
        await boot2.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it("the batch statements are ONE round trip each and use the index-backed ANY($ids) form", async () => {
      const seen: string[] = [];
      const counting = {
        query: (text: string, params?: unknown[]) => {
          if (/leases/.test(text) && !/CREATE|ALTER|DO \$/.test(text)) seen.push(text);
          return pool.query(text, params as never);
        },
        end: async () => {},
        connect: () => pool.connect(),
      } as never;
      const store = new PostgresLeaseStore(counting);
      try {
        const ids = Array.from({ length: 500 }, (_, i) => `e${i}`);
        seen.length = 0;
        expect((await store.acquireMany(ids, "n", 60_000)).length).toBe(500);
        expect(await store.renewMany(ids, "n", 60_000)).toHaveLength(500);
        await store.releaseMany(ids, "n");
        expect(seen).toHaveLength(3);
        expect(seen[1]).toMatch(/ANY\(\$2::text\[\]\)/);
      } finally {
        await store.close();
      }
    });
  });
}

if (PG_URL !== undefined) {
  describe("postgresStorage exposes a co-located lease store (ADR 0130 D11)", () => {
    it("returns leaseStore beside eventStore, on the SAME pool and database", async () => {
      const { postgresStorage } = await import("./preset");
      const { PostgresLeaseStore: Lease } = await import("./PostgresLeaseStore");
      const schema = `loom_lease_preset_${process.pid}`;
      const admin = new Pool({ connectionString: PG_URL });
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
      const shared = new Pool({
        connectionString: PG_URL,
        options: `-c search_path=${schema}`,
        max: 4,
      });
      const storage = postgresStorage({ url: shared as never });
      try {
        expect(storage.leaseStore).toBeInstanceOf(Lease);
        expect(await storage.leaseStore.acquire("x", "node-a", 60_000)).not.toBeNull();
        const { rows } = await shared.query("SELECT owner FROM leases WHERE execution_id = 'x'");
        expect(rows).toEqual([{ owner: "node-a" }]);
      } finally {
        await storage.leaseStore.close();
        await storage.eventStore.close?.();
        await shared.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });
  });
}
