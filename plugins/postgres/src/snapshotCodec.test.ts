import assert from "node:assert";
import { runSnapshotStoreConformance } from "@loom/conformance";
import type { ExecutionState } from "@loom/core";
import { SNAPSHOT_FRAME_SENTINEL, type Snapshot, zstdAvailable } from "@loom/snapshot-runtime";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import { ensureSnapshotZstd, migrate } from "./schema";

// ADR 0141 - the zstd snapshot codec on Postgres. Gated on LOOM_TEST_POSTGRES_URL, and skipped on a Node
// without zlib.zstd (needs >= 22.15).
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL && zstdAvailable() ? describe : describe.skip;

function snap(id: string, sequence: number, state: unknown): Snapshot {
  return {
    id,
    executionId: "x",
    workflowId: "wf",
    sequence,
    state: state as ExecutionState,
    createdAt: sequence,
  };
}

const words = "the customer ticket refund order invoice payment failed retry approval".split(" ");
const bigState = (tag: string): unknown => ({
  tag,
  steps: Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => [
      `s${i}`,
      {
        text: Array.from({ length: 30 }, (_, j) => words[(i + j * 3) % words.length]).join(" "),
        i,
      },
    ])
  ),
});

suite("PostgresSnapshotStore codec: zstd (ADR 0141)", () => {
  const schema = `loom_zstd_${process.pid}`;
  const opened: Pool[] = [];
  const openPool = (): Pool => {
    const p = new Pool({ connectionString: PG_URL, options: `-c search_path=${schema}`, max: 4 });
    opened.push(p);
    return p;
  };
  let admin: Pool;

  const columnInfo = async (): Promise<Record<string, { notnull: boolean; storage: string }>> => {
    const { rows } = await admin.query(
      `SELECT attname::text AS name, attnotnull AS notnull, attstorage::text AS storage
       FROM pg_attribute WHERE attrelid = '${schema}.snapshots'::regclass AND attnum > 0 AND NOT attisdropped`
    );
    return Object.fromEntries(
      rows.map((r) => [r.name, { notnull: r.notnull, storage: r.storage }])
    );
  };
  const rawRow = async (id: string) => {
    const row = (await admin.query(`SELECT * FROM ${schema}.snapshots WHERE id = $1`, [id]))
      .rows[0];
    return { ...row, n: row?.state_z ? row.state_z.length : undefined };
  };

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

  it("codec off: the schema is untouched (no state_z, state NOT NULL) and rows are JSONB", async () => {
    const store = new PostgresSnapshotStore(openPool());
    await store.save(snap("a", 1, { v: 1 }));
    const cols = await columnInfo();
    expect(cols.state_z).toBeUndefined();
    expect(cols.state?.notnull).toBe(true);
    const raw = await rawRow("a");
    expect(raw.state).toEqual({ v: 1 });
    expect(raw.state_z).toBeUndefined();
    expect((await store.loadLatest("x"))?.state).toEqual({ v: 1 });
    expect(store.snapshotCodec).toBe("none");
    await store.close();
  });

  it("provisions state_z BYTEA (EXTERNAL) and the sentinel CHECK; state STAYS NOT NULL; idempotent", async () => {
    const onWarn = vi.fn();
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd", onWarn });
    await store.save(snap("a", 1, bigState("a")));
    const cols = await columnInfo();
    expect(cols.state_z).toEqual({ notnull: false, storage: "e" });
    expect(cols.state?.notnull).toBe(true);
    const { rows } = await admin.query(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = '${schema}.snapshots'::regclass AND conname = 'snapshots_frame_sentinel'`
    );
    expect(rows).toHaveLength(1);
    // a second boot on a fresh pool: probes the catalog, changes nothing, says nothing
    const again = new PostgresSnapshotStore(openPool(), { codec: "zstd", onWarn });
    await again.save(snap("b", 2, bigState("b")));
    expect(onWarn).not.toHaveBeenCalled();
    await store.close();
    await again.close();
  });

  it("stores a frame in state_z (state = the fixed sentinel, NOT NULL), far smaller than the JSON", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await store.save(snap("a", 1, bigState("a")));
    const row = await rawRow("a");
    expect(row.state).toEqual(SNAPSHOT_FRAME_SENTINEL);
    expect(Buffer.isBuffer(row.state_z)).toBe(true);
    expect(row.state_z[0]).toBe(0x02);
    expect(Number(row.n)).toBeLessThan(JSON.stringify(bigState("a")).length / 5);
    await store.close();
  });

  it("round-trips adversarial states that JSONB cannot hold, byte-identically as JSON", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    const cases: Record<string, unknown> = {
      proto: JSON.parse('{"__proto__":{"polluted":true},"a":1}'),
      surrogates: { hi: "a\ud800b", lo: "c\udc00d", nul: "x\u0000y" },
      keyOrder: { z: 1, a: 2, 10: "ten", 2: "two" },
    };
    let seq = 1;
    for (const [name, state] of Object.entries(cases)) {
      await store.save(snap(name, seq, state));
      const back = (await store.loadAt("x", seq))?.state;
      assert.deepStrictEqual(back, state);
      expect(JSON.stringify(back)).toBe(JSON.stringify(state));
      seq++;
    }
    await store.close();
  });

  it("reads a MIXED table: JSONB rows and frame rows, through every read path, with the codec on OR off", async () => {
    const pool = openPool();
    const old = new PostgresSnapshotStore(pool); // a pre-codec deployment
    await old.save(snap("a", 1, bigState("old-1")));
    await old.save(snap("b", 5, bigState("old-5")));
    const next = new PostgresSnapshotStore(pool, { codec: "zstd" });
    await next.save(snap("c", 9, bigState("new-9")));
    for (const store of [next, old]) {
      expect((await store.loadAt("x", 1))?.state).toEqual(bigState("old-1"));
      expect((await store.loadLatestBefore("x", 8))?.state).toEqual(bigState("old-5"));
      expect((await store.loadLatest("x"))?.state).toEqual(bigState("new-9"));
    }
    await old.close();
    await next.close();
  });

  it("a JSONB re-save (by id) over a frame row clears the frame (no stale state_z)", async () => {
    const pool = openPool();
    const z = new PostgresSnapshotStore(pool, { codec: "zstd" });
    await z.save(snap("a", 1, { v: "frame" }));
    const off = new PostgresSnapshotStore(openPool()); // probes AFTER the column exists
    await off.save(snap("a", 1, { v: "jsonb" }));
    const row = await rawRow("a");
    expect(row.state_z).toBeNull();
    expect(row.state).toEqual({ v: "jsonb" });
    expect((await z.loadLatest("x"))?.state).toEqual({ v: "jsonb" });
    // and the other direction
    await z.save(snap("a", 1, { v: "frame-again" }));
    expect((await rawRow("a")).state).toEqual(SNAPSHOT_FRAME_SENTINEL);
    expect((await off.loadLatest("x"))?.state).toEqual({ v: "frame-again" });
    await z.close();
    await off.close();
  });

  it("a node that probed BEFORE another opted in re-probes on the CHECK violation and retries (no stale frame)", async () => {
    const early = new PostgresSnapshotStore(openPool()); // column absent when it probed
    await early.save(snap("seed", 99, { v: 0 }));
    const z = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await z.save(snap("a", 1, { v: "frame" }));
    // early still believes there is no state_z: its UPDATE leaves the frame, the CHECK (23514) fires,
    // it re-probes, finds the column, and retries with `state_z = NULL`.
    await early.save(snap("a", 1, { v: "jsonb" }));
    const row = await rawRow("a");
    expect(row.state_z).toBeNull();
    expect(row.state).toEqual({ v: "jsonb" });
    expect((await z.loadLatestBefore("x", 1))?.state).toEqual({ v: "jsonb" });
    await early.close();
    await z.close();
  });

  it("a JSONB save that violates the CHECK for any OTHER reason still throws (no blind retry)", async () => {
    const z = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await z.save(snap("a", 1, { v: "frame" }));
    // hasFrameColumn is already true, so a 23514 is not a stale probe: it must surface.
    const err = Object.assign(new Error("check"), { code: "23514" });
    const pool = openPool();
    const store = new PostgresSnapshotStore(pool);
    await store.save(snap("seed", 99, { v: 0 }));
    vi.spyOn(pool, "query").mockRejectedValueOnce(err);
    await expect(store.save(snap("b", 2, { v: 2 }))).rejects.toBe(err);
    vi.restoreAllMocks();
    await z.close();
    await store.close();
  });

  it("hasFrameColumn comes from the catalog even when this store's own provisioning failed (a peer's frame is cleared on re-save)", async () => {
    await migrate(openPool());
    // A peer added the column but this store cannot finish provisioning (the CHECK is missing and the
    // ALTER cannot get its lock): writeFrames stays false, yet the column EXISTS.
    await admin.query(`ALTER TABLE ${schema}.snapshots ADD COLUMN state_z BYTEA`);
    await admin.query(
      `INSERT INTO ${schema}.snapshots (id, execution_id, workflow_id, sequence, state, state_z, created_at)
       VALUES ('a', 'x', 'wf', 1, '{"v":"peer"}'::jsonb, '\\x02aa'::bytea, 1)`
    );
    const holder = await openPool().connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE snapshots IN ACCESS SHARE MODE");
    const onWarn = vi.fn();
    const failed = new PostgresSnapshotStore(openPool(), {
      codec: "zstd",
      onWarn,
      migrationLockTimeoutMs: 100,
    });
    try {
      await failed.save(snap("a", 1, { v: "jsonb" })); // JSONB fallback over the peer's frame row
      expect(onWarn).toHaveBeenCalled(); // provisioning did fail
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const row = await rawRow("a");
    expect(row.state_z).toBeNull();
    expect(row.state).toEqual({ v: "jsonb" });
    await failed.close();
  });

  it("a frame row without its frame (sentinel, state_z NULL) is corruption: the reader throws, never seeds a state", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await store.save(snap("a", 1, { v: "frame" }));
    await admin.query(`UPDATE ${schema}.snapshots SET state_z = NULL`);
    await expect(store.loadLatest("x")).rejects.toThrow(/marked as a codec frame/);
    await store.close();
  });

  it("an OLD node's read of a frame row sees a non-null, non-state value (the sentinel), never NULL", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await store.save(snap("a", 1, bigState("a")));
    // What a node that predates the codec reads: `SELECT *`, handing `state` up as the state. Its seal
    // guard / content sweep / identity check each fail loudly on this value (packages/workflow-runtime
    // snapshotFrameSentinel.test.ts, plugins/content gc.test.ts).
    const { rows } = await admin.query(`SELECT state FROM ${schema}.snapshots WHERE id = 'a'`);
    expect(rows[0].state).toEqual(SNAPSHOT_FRAME_SENTINEL);
    await store.close();
  });

  it("raw SQL: state is NOT NULL on every row and equals the sentinel on frame rows; a real state with a frame is refused by the CHECK", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await store.save(snap("a", 1, { v: 1 }));
    const { rows } = await admin.query(
      `SELECT state IS NULL AS isnull, state = $1::jsonb AS issentinel FROM ${schema}.snapshots WHERE id = 'a'`,
      [JSON.stringify(SNAPSHOT_FRAME_SENTINEL)]
    );
    expect(rows[0]).toEqual({ isnull: false, issentinel: true });
    await expect(
      admin.query(`UPDATE ${schema}.snapshots SET state = '{"v":1}'::jsonb WHERE id = 'a'`)
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin.query(`UPDATE ${schema}.snapshots SET state = NULL WHERE id = 'a'`)
    ).rejects.toMatchObject({ code: "23502" });
    await store.close();
  });

  it("deleteExecution and pruneSnapshots work over frame rows", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    for (let i = 1; i <= 5; i++) await store.save(snap(`s${i}`, i, { i }));
    expect(await store.pruneSnapshots("x", { after: 1, before: 5 }, [3])).toBe(2);
    expect((await store.loadAt("x", 3))?.state).toEqual({ i: 3 });
    await store.deleteExecution("x");
    expect(await store.loadLatest("x")).toBeNull();
    await store.close();
  });

  it("a corrupted frame fails loudly", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await store.save(snap("a", 1, bigState("a")));
    await admin.query(`UPDATE ${schema}.snapshots SET state_z = '\\x02deadbeef'::bytea`);
    await expect(store.loadLatest("x")).rejects.toThrow(/does not decode|malformed/);
    await store.close();
  });

  it("FAILS SOFT: a held lock on snapshots means one warning and JSONB writes, then the next boot provisions", async () => {
    // First create the table, then hold a conflicting lock so the 200 ms-bounded ALTER cannot get its own.
    await migrate(openPool());
    const holder = await openPool().connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE snapshots IN ACCESS SHARE MODE"); // conflicts with ACCESS EXCLUSIVE only
    const onWarn = vi.fn();
    const blocked = new PostgresSnapshotStore(openPool(), {
      codec: "zstd",
      onWarn,
      migrationLockTimeoutMs: 100,
    });
    try {
      await blocked.save(snap("a", 1, { v: "fell back to jsonb" }));
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(String(onWarn.mock.calls[0]?.[0])).toMatch(/55P03|lock timeout/i);
      expect((await columnInfo()).state_z).toBeUndefined();
      expect((await rawRow("a")).state).toEqual({ v: "fell back to jsonb" });
      expect((await blocked.loadLatest("x"))?.state).toEqual({ v: "fell back to jsonb" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    // the failure was not cached: a later boot (fresh pool) provisions it
    const next = new PostgresSnapshotStore(openPool(), { codec: "zstd", onWarn });
    await next.save(snap("b", 2, { v: "frame" }));
    expect((await rawRow("b")).state_z).not.toBeNull();
    expect((await next.loadAt("x", 1))?.state).toEqual({ v: "fell back to jsonb" });
    await blocked.close();
    await next.close();
  });

  it("migrate(pool, { snapshotCodec: 'zstd' }) provisions ahead of time", async () => {
    const pool = openPool();
    await migrate(pool, { snapshotCodec: "zstd" });
    expect((await columnInfo()).state_z).toBeDefined();
    expect(await ensureSnapshotZstd(pool)).toBe(true);
  });

  it("the provisioning ALTER does not wait on a reader longer than its own short timeout", async () => {
    await migrate(openPool());
    const holder = await openPool().connect();
    await holder.query("BEGIN");
    await holder.query("SELECT count(*) FROM snapshots"); // ACCESS SHARE held to the end of the tx
    try {
      const t0 = Date.now();
      const ok = await ensureSnapshotZstd(openPool(), { lockTimeoutMs: 60_000, onWarn: () => {} });
      expect(ok).toBe(false);
      // a hang would wait the 60 s lockTimeoutMs
      expect(Date.now() - t0).toBeLessThan(10_000); // timing-bound: the wait is min(lockTimeoutMs, 200 ms); a hang would be 60 s
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});

// The SnapshotStore kit against Postgres, BOTH formats (it never ran on Postgres before). Each case gets
// its own schema: the kit reuses the fixed execution id "x".
const kit = PG_URL ? describe : describe.skip;
kit("PostgresSnapshotStore conformance", () => {
  const SCHEMA_COUNT = 40;
  const name = (i: number): string => `loom_snapkit_${process.pid}_${i}`;
  const pools: Pool[] = [];
  let nextDefault = 0;
  let nextZstd = 0;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (let i = 0; i < SCHEMA_COUNT; i++) {
        await admin.query(`DROP SCHEMA IF EXISTS ${name(i)} CASCADE`);
        await admin.query(`CREATE SCHEMA ${name(i)}`);
      }
    } finally {
      await admin.end();
    }
    for (let i = 0; i < SCHEMA_COUNT; i++) {
      pools.push(
        new Pool({ connectionString: PG_URL, options: `-c search_path=${name(i)}`, max: 2 })
      );
    }
  }, 60_000);
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (let i = 0; i < SCHEMA_COUNT; i++) {
        await admin.query(`DROP SCHEMA IF EXISTS ${name(i)} CASCADE`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  // Default format first: the lower half of the schemas, so the two runs never share one.
  runSnapshotStoreConformance(
    () => new PostgresSnapshotStore(pools[nextDefault++ % (SCHEMA_COUNT / 2)] as Pool),
    "PostgresSnapshotStore (JSONB)"
  );
  if (zstdAvailable()) {
    runSnapshotStoreConformance(
      () =>
        new PostgresSnapshotStore(
          pools[SCHEMA_COUNT / 2 + (nextZstd++ % (SCHEMA_COUNT / 2))] as Pool,
          { codec: "zstd" }
        ),
      "PostgresSnapshotStore (zstd)"
    );
  }
});
