import { Pool, type PoolConfig } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { postgresStorage } from "./preset";
import { migrate } from "./schema";

// Concurrent-bootstrap tests for the schema migration. Same gating as the rest of the
// Postgres suite: they run when LOOM_TEST_POSTGRES_URL is set and skip cleanly otherwise.
//
// What they pin: `CREATE TABLE IF NOT EXISTS` is NOT atomic in Postgres. Two sessions can
// both pass the catalog check and both attempt the create; the loser fails with
// SQLSTATE 23505 on pg_type_typname_nsp_index (or 42P07 on a racing CREATE INDEX). The
// rest of the suite never sees this because it migrates once in `beforeAll` — but the
// SHIPPED path does: every store constructor migrates, and `postgresStorage({ url })`
// builds a separate pool per store, so wiring Postgres against a fresh database fires
// several concurrent migrations by construction.
//
// These tests need to migrate from genuinely nothing, repeatedly, so they run in their
// OWN schema — dropping the shared `public` tables would race the sibling test file,
// which vitest runs concurrently against the same database. Advisory locks are
// database-wide and schema-independent, so the lock under test is still the real one.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;

const SCHEMA = "loom_migrate_concurrency_test";

const LOOM_TABLES = [
  "events",
  "snapshots",
  "refs",
  "lineage",
  "fences",
  "timers",
  "durable_state",
  "read_model_rows",
  "read_model_watermarks",
  "archive_segments",
];

/** Pool config pinned to the test schema, so unqualified DDL lands there. */
function scoped(): PoolConfig {
  return { connectionString: PG_URL, options: `-c search_path=${SCHEMA}` };
}

suite("schema migration under concurrent bootstrap", () => {
  const pools: Pool[] = [];
  const track = (pool: Pool): Pool => {
    pools.push(pool);
    return pool;
  };

  const admin = async <T>(fn: (p: Pool) => Promise<T>): Promise<T> => {
    const pool = new Pool({ connectionString: PG_URL });
    try {
      return await fn(pool);
    } finally {
      await pool.end();
    }
  };

  beforeAll(() => admin((p) => p.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)));

  // Reset to an empty schema before each test so every migration starts from nothing.
  beforeEach(() =>
    admin(async (p) => {
      await p.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await p.query(`CREATE SCHEMA ${SCHEMA}`);
    })
  );

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    pools.length = 0;
    await admin((p) => p.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`));
  });

  const tablesPresent = (): Promise<string[]> =>
    admin(async (p) => {
      const { rows } = await p.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = ANY($2)",
        [SCHEMA, LOOM_TABLES]
      );
      return rows.map((r) => r.tablename).sort();
    });

  const ALL_TABLES = [...LOOM_TABLES].sort();

  it("survives many separate pools migrating a fresh database at once", async () => {
    // Distinct pools defeat the per-Pool memo on purpose: this exercises the advisory
    // lock, which is the layer that has to hold across sessions and processes. Ten is
    // well above the six stores the library itself constructs.
    const concurrent = Array.from({ length: 10 }, () => migrate(track(new Pool(scoped()))));
    await expect(Promise.all(concurrent)).resolves.toBeDefined();
    expect(await tablesPresent()).toEqual(ALL_TABLES);
  });

  it("wires the shipped postgresStorage() preset against a fresh database", async () => {
    // The regression this fixes, through the documented entry point. The preset builds a
    // SEPARATE pool per store, so its three constructors migrate concurrently.
    const storage = postgresStorage({ url: scoped(), branching: true });
    // Each store defers its migration behind a lazily-awaited `ready`; one real call per
    // store forces all three to settle.
    await expect(
      Promise.all([
        storage.eventStore.read("nonexistent"),
        storage.snapshotStore.loadLatest("nonexistent"),
        storage.branchRegistry?.getRef("nonexistent") ?? Promise.resolve(null),
      ])
    ).resolves.toBeDefined();
    expect(await tablesPresent()).toEqual(ALL_TABLES);
    await storage.eventStore.close();
  });

  it("issues the DDL once per pool, and stays idempotent when repeated", async () => {
    const pool = track(new Pool(scoped()));
    // Concurrent calls on ONE pool collapse to a single in-flight migration (the memo),
    // and a later call after settling is a no-op that still resolves.
    await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    await migrate(pool);
    expect(await tablesPresent()).toEqual(ALL_TABLES);
  });

  it("does not cache a failure — a later attempt can still migrate", async () => {
    const dead = new Pool({ connectionString: "postgres://127.0.0.1:1/nope" });
    await expect(migrate(dead)).rejects.toThrow();
    await dead.end().catch(() => {});
    // A fresh pool to the real database still migrates: the rejected attempt was evicted
    // rather than memoized, so failure is not sticky.
    await expect(migrate(track(new Pool(scoped())))).resolves.toBeUndefined();
    expect(await tablesPresent()).toEqual(ALL_TABLES);
  });
});
