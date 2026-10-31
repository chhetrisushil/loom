import assert from "node:assert";
import { runSnapshotStoreConformance } from "@loom/conformance";
import type { ExecutionState } from "@loom/core";
import { type Snapshot, zstdAvailable } from "@loom/snapshot-runtime";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import { ensureSnapshotZstd, migrate } from "./schema";

// ADR 0140 - the zstd snapshot codec on Postgres. Gated on LOOM_TEST_POSTGRES_URL, and skipped on a Node
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

suite("PostgresSnapshotStore codec: zstd (ADR 0140)", () => {
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

  it("provisions state_z BYTEA (EXTERNAL), drops state NOT NULL, adds the one-format CHECK; idempotent", async () => {
    const onWarn = vi.fn();
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd", onWarn });
    await store.save(snap("a", 1, bigState("a")));
    const cols = await columnInfo();
    expect(cols.state_z).toEqual({ notnull: false, storage: "e" });
    expect(cols.state?.notnull).toBe(false);
    const { rows } = await admin.query(
      `SELECT convalidated FROM pg_constraint WHERE conrelid = '${schema}.snapshots'::regclass AND conname = 'snapshots_one_format'`
    );
    expect(rows).toHaveLength(1);
    // a second boot on a fresh pool: probes the catalog, changes nothing, says nothing
    const again = new PostgresSnapshotStore(openPool(), { codec: "zstd", onWarn });
    await again.save(snap("b", 2, bigState("b")));
    expect(onWarn).not.toHaveBeenCalled();
    await store.close();
    await again.close();
  });

  it("stores a frame in state_z (state NULL), far smaller than the JSON", async () => {
    const store = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await store.save(snap("a", 1, bigState("a")));
    const row = await rawRow("a");
    expect(row.state).toBeNull();
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
    expect((await rawRow("a")).state).toBeNull();
    expect((await off.loadLatest("x"))?.state).toEqual({ v: "frame-again" });
    await z.close();
    await off.close();
  });

  it("a node that probed BEFORE another opted in fails loudly (CHECK) rather than leaving a stale frame", async () => {
    const early = new PostgresSnapshotStore(openPool()); // column absent when it probed
    await early.save(snap("seed", 99, { v: 0 }));
    const z = new PostgresSnapshotStore(openPool(), { codec: "zstd" });
    await z.save(snap("a", 1, { v: "frame" }));
    await expect(early.save(snap("a", 1, { v: "jsonb" }))).rejects.toMatchObject({ code: "23514" });
    expect((await z.loadLatestBefore("x", 1))?.state).toEqual({ v: "frame" });
    await early.close();
    await z.close();
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
    await expect(store.loadLatest("x")).rejects.toThrow(/does not decode/);
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
