import type { ExecutionState } from "@loom/core";
import { Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import type { PoolLike } from "./pool";
import { migrate } from "./schema";

// ADR 0136 — snapshots.state uses lz4 TOAST compression where the server supports it, and falls
// back to the default (with ONE warning) where it does not. Gated on LOOM_TEST_POSTGRES_URL.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;

/** A state big and repetitive enough to be TOASTed and compressed (> 2 kB, well under 1 MB). */
function bigState(tag: string): ExecutionState {
  const steps: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) {
    steps[`step-${i}`] = {
      status: "COMPLETED",
      note: `${tag} repeated payload text `.repeat(4),
      i,
    };
  }
  return { status: "RUNNING", steps } as unknown as ExecutionState;
}

suite("snapshots.state lz4 compression (ADR 0136)", () => {
  const schema = `loom_lz4_${process.pid}`;
  const opened: Pool[] = [];
  const openPool = (): Pool => {
    const p = new Pool({ connectionString: PG_URL, options: `-c search_path=${schema}`, max: 3 });
    opened.push(p);
    return p;
  };
  let admin: Pool;

  const compressionOf = async (pool: PoolLike): Promise<string> => {
    const { rows } = await pool.query<{ c: string }>(
      "SELECT attcompression::text AS c FROM pg_attribute WHERE attrelid = 'snapshots'::regclass AND attname = 'state'"
    );
    return rows[0]?.c ?? "?";
  };

  /** A pool whose connections answer `intercept` for matching statements (a stand-in for another server). */
  const stubbed = (
    real: Pool,
    intercept: (sql: string) => Promise<{ rows: unknown[] } | undefined>
  ): PoolLike => ({
    query: real.query.bind(real) as PoolLike["query"],
    end: real.end.bind(real),
    connect: (async () => {
      const client = await real.connect();
      const q = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
        const sql = typeof a[0] === "string" ? a[0] : "";
        return (await intercept(sql)) ?? q(...a);
      };
      return client as PoolClient;
    }) as PoolLike["connect"],
  });

  beforeEach(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  });
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((p) => p.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("sets lz4 when asked, idempotently, with no warning", async () => {
    const onWarn = vi.fn();
    await migrate(openPool(), { onWarn, snapshotCompression: "lz4" });
    expect(await compressionOf(openPool())).toBe("l");
    await migrate(openPool(), { onWarn, snapshotCompression: "lz4" }); // a second boot (fresh pool, so not memoized)
    expect(await compressionOf(openPool())).toBe("l");
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("leaves the column alone and stays silent unless asked (opt-in)", async () => {
    const onWarn = vi.fn();
    await migrate(openPool(), { onWarn });
    expect(await compressionOf(openPool())).toBe("");
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("the event store option reaches the migration", async () => {
    const events = new PostgresEventStore(openPool(), { snapshotCompression: "lz4" });
    try {
      await events.append({
        id: "e1",
        workflowId: "w",
        executionId: "x",
        eventType: "TEST_EVENT",
        sequence: 0,
        timestamp: 1,
        payload: {},
      } as never);
      expect(await compressionOf(openPool())).toBe("l");
    } finally {
      await events.close();
    }
  });

  it("falls back with one warning on a server older than 14", async () => {
    const onWarn = vi.fn();
    const pool = stubbed(openPool(), async (sql) =>
      sql === "SHOW server_version_num" ? { rows: [{ server_version_num: "130012" }] } : undefined
    );
    await migrate(pool, { onWarn, snapshotCompression: "lz4" });
    expect(await compressionOf(openPool())).toBe("");
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]?.[0])).toContain("older than 14");
  });

  it("falls back with one warning when the server is built without lz4 (feature_not_supported)", async () => {
    const onWarn = vi.fn();
    const pool = stubbed(openPool(), async (sql) => {
      if (!sql.includes("SET COMPRESSION")) return undefined;
      throw Object.assign(new Error("this build does not support compression with LZ4"), {
        code: "0A000",
      });
    });
    await migrate(pool, { onWarn, snapshotCompression: "lz4" });
    expect(await compressionOf(openPool())).toBe("");
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(String(onWarn.mock.calls[0]?.[0])).toContain("0A000");
    // the migration still completed: the store works
    const store = new PostgresSnapshotStore(openPool());
    await store.save({
      id: "s",
      executionId: "e",
      workflowId: "w",
      sequence: 1,
      state: bigState("a"),
      createdAt: 1,
    });
    expect((await store.loadLatest("e"))?.sequence).toBe(1);
  });

  it("default never reverts a column that already uses lz4", async () => {
    await migrate(openPool(), { snapshotCompression: "lz4" });
    expect(await compressionOf(openPool())).toBe("l");
    await migrate(openPool()); // a later boot with the default, on a fresh (unmemoized) pool
    expect(await compressionOf(openPool())).toBe("l");
  });

  it("a REAL lock_not_available from the server falls back softly, and the next boot applies lz4", async () => {
    await migrate(openPool()); // tables exist, column on the default
    const holder = await openPool().connect();
    try {
      // The holder has the lock once this resolves (awaited, not slept on): any ALTER must wait.
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE snapshots IN ACCESS SHARE MODE");
      const onWarn = vi.fn();
      // The server itself raises 55P03 after the step's own short wait (min(lockTimeoutMs, 200 ms)).
      // ONE connection, so the store below reuses the very session the failed ALTER ran on.
      const single = new Pool({
        connectionString: PG_URL,
        options: `-c search_path=${schema}`,
        max: 1,
      });
      opened.push(single);
      await migrate(single, { onWarn, snapshotCompression: "lz4", lockTimeoutMs: 100 });
      expect(await compressionOf(openPool())).toBe("");
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(String(onWarn.mock.calls[0]?.[0])).toContain("55P03");
      // the failed step left no aborted transaction behind: that same session still serves snapshots
      const store = new PostgresSnapshotStore(single);
      await store.save({
        id: "s",
        executionId: "e",
        workflowId: "w",
        sequence: 1,
        state: bigState("locked"),
        createdAt: 1,
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const onWarn2 = vi.fn();
    await migrate(openPool(), { onWarn: onWarn2, snapshotCompression: "lz4" });
    expect(await compressionOf(openPool())).toBe("l");
    expect(onWarn2).not.toHaveBeenCalled();
  });

  it("an unexpected error is not swallowed", async () => {
    const pool = stubbed(openPool(), async (sql) => {
      if (!sql.includes("SET COMPRESSION")) return undefined;
      throw Object.assign(new Error("boom"), { code: "XX000" });
    });
    await expect(migrate(pool, { snapshotCompression: "lz4" })).rejects.toThrow("boom");
  });

  it("values written before and after the switch read back identically", async () => {
    await migrate(openPool());
    // Raw INSERT: a PostgresSnapshotStore would run the default migration in its constructor.
    const stateA = bigState("before");
    await openPool().query(
      "INSERT INTO snapshots (id, execution_id, workflow_id, sequence, state, created_at) VALUES ('a', 'e', 'w', 1, $1::jsonb, 1)",
      [JSON.stringify(stateA)]
    );
    await migrate(openPool(), { snapshotCompression: "lz4" }); // the switch
    const after = new PostgresSnapshotStore(openPool());
    const stateB = bigState("after");
    await after.save({
      id: "b",
      executionId: "e",
      workflowId: "w",
      sequence: 2,
      state: stateB,
      createdAt: 2,
    });
    const { rows } = await openPool().query<{ id: string; m: string | null }>(
      "SELECT id, pg_column_compression(state)::text AS m FROM snapshots ORDER BY id"
    );
    expect(rows).toEqual([
      { id: "a", m: "pglz" },
      { id: "b", m: "lz4" },
    ]);
    expect((await after.loadLatest("e"))?.state).toEqual(stateB);
    expect((await after.loadAt("e", 1))?.state).toEqual(stateA);
  });
});
