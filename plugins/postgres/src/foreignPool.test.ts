import type { EventEnvelope } from "@loom/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import { postgresStorage } from "./preset";

// The claim these tests exist to check: the stores speak only the PUBLIC pool surface, so
// a pool built by a different copy of `pg` (or by something that is not `pg`) is usable,
// not merely detectable. `PoolLike` makes that a compile-time property; this makes it an
// executable one, by driving a real store through a pool it cannot possibly share
// internals with — no database, no `pg` involvement on the pool side at all.

interface Call {
  sql: string;
  values?: unknown[];
}

/**
 * A pool that is emphatically NOT a `pg.Pool` — a plain object recording what the store
 * asks of it. Nothing here is reachable by `instanceof Pool`.
 */
function recordingPool(rowsFor: (sql: string) => unknown[] = () => []) {
  const calls: Call[] = [];
  const clientCalls: Call[] = [];
  let released = 0;
  const pool = {
    query: (sql: string, values?: unknown[]) => {
      calls.push({ sql, ...(values !== undefined && { values }) });
      const rows = rowsFor(sql);
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    connect: () =>
      Promise.resolve({
        query: (sql: string, values?: unknown[]) => {
          clientCalls.push({ sql, ...(values !== undefined && { values }) });
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release: () => {
          released += 1;
        },
      }),
    end: () => Promise.resolve(),
  };
  return {
    pool,
    calls,
    clientCalls,
    releases: () => released,
  };
}

const envelope: EventEnvelope = {
  id: "e1",
  workflowId: "w",
  executionId: "x1",
  eventType: "EXECUTION_STARTED",
  sequence: 0,
  timestamp: 1,
  payload: { hello: "world" },
};

describe("a pool from another copy of pg (or no pg at all)", () => {
  it("runs the migration through the borrowed pool's own client", async () => {
    // migrate() is the one path that checks a client OUT of the pool — advisory lock and
    // DDL must share one session — so it is where a foreign pool would break first if the
    // stores needed anything beyond connect/query/release.
    const { pool, clientCalls, releases } = recordingPool();
    const store = new PostgresEventStore(pool as never);
    await store.read("x1");

    const sql = clientCalls.map((c) => c.sql);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(sql.some((s) => s.includes("CREATE TABLE IF NOT EXISTS events"))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(releases()).toBe(1); // checked back in, exactly once
  });

  it("postgresStorage passes migrationLockTimeoutMs to the migration (L10, ADR 0108 D3)", async () => {
    const { pool, clientCalls } = recordingPool();
    const storage = postgresStorage({ url: pool as never, migrationLockTimeoutMs: 750 });
    await storage.eventStore.read("x1");
    const set = clientCalls.find((c) => c.sql.includes("loom.l10_lock_timeout"));
    expect(set?.values).toEqual(["750ms"]);
  });

  it("appends through it, fence check and NOTIFY intact", async () => {
    // One inserted row ⇒ rowCount 1 ⇒ no StaleFenceError. The store cannot tell the
    // difference between this pool and one it built itself, which is the entire point.
    const { pool, calls } = recordingPool((sql) =>
      sql.includes("INSERT INTO events") ? [{ pg_notify: null }] : []
    );
    const store = new PostgresEventStore(pool as never);
    await store.append(envelope);

    const insert = calls.find((c) => c.sql.includes("INSERT INTO events"));
    expect(insert).toBeDefined();
    expect(insert?.values?.[0]).toBe("e1");
    expect(insert?.values?.[2]).toBe("x1");
    expect(insert?.sql).toContain("pg_notify");
  });

  it("delivers to same-process subscribers, which never needed the listener session", async () => {
    // Local delivery is synchronous and independent of LISTEN/NOTIFY, so it works even
    // for a pool that exposes no `options` to open a listener with.
    const { pool } = recordingPool((sql) =>
      sql.includes("INSERT INTO events") ? [{ pg_notify: null }] : []
    );
    const store = new PostgresEventStore(pool as never);
    const seen: EventEnvelope[] = [];
    await store.subscribe("x1", (e) => seen.push(e));
    await store.append(envelope);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe("e1");
  });

  it("never ends a pool it did not open", async () => {
    // Ownership is unchanged by borrowing structurally: close() releases what the store
    // built, and a lent pool outlives it.
    let ended = false;
    const { pool } = recordingPool();
    const store = new PostgresSnapshotStore({
      ...pool,
      end: () => {
        ended = true;
        return Promise.resolve();
      },
    } as never);
    await store.close();
    expect(ended).toBe(false);
  });
});

// ── The same claim, against a real database ─────────────────────────────────
//
// The fakes above prove the stores never step outside the pool surface. They cannot prove
// the borrowed pool actually talks to Postgres correctly, because nothing above connects.
// This does, using a plain object that delegates to a real pool: `instanceof Pool` is
// false for it — exactly as it is for a pool from a second copy of `pg` — while every
// call reaches a live server. Same gating as the rest of the suite.

const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;

const SCHEMA = "loom_foreign_pool_test";

suite("a borrowed pool against a real database", () => {
  let real: Pool;
  /** Delegates to `real`, but is not a `Pool` — the store cannot tell, and must not care. */
  let borrowed: object;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    } finally {
      await admin.end();
    }
    real = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}` });
    borrowed = {
      query: (...args: unknown[]) => (real.query as (...a: unknown[]) => unknown)(...args),
      connect: () => real.connect(),
      end: () => real.end(),
      options: real.options,
    };
  });

  afterAll(async () => {
    await real.end().catch(() => {});
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("migrates, appends and reads back through it", async () => {
    expect(borrowed instanceof Pool).toBe(false); // the premise
    const store = new PostgresEventStore(borrowed as never);
    const e: EventEnvelope = {
      id: "fp-1",
      workflowId: "w",
      executionId: "fp-x1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { hello: "world" },
    };
    await store.append(e);

    const read = await store.read("fp-x1");
    expect(read).toHaveLength(1);
    expect(read[0]?.id).toBe("fp-1");
    expect(read[0]?.payload).toEqual({ hello: "world" });
  });

  it("round-trips a snapshot through it", async () => {
    const snapshots = new PostgresSnapshotStore(borrowed as never);
    await snapshots.save({
      id: "fp-s1",
      executionId: "fp-x1",
      workflowId: "w",
      sequence: 0,
      state: { status: "running" } as never,
      createdAt: 2,
    });
    const latest = await snapshots.loadLatest("fp-x1");
    expect(latest?.id).toBe("fp-s1");
  });

  it("opens its LISTEN session from a borrowed pool's options, and receives cross-node", async () => {
    // The second `instanceof Pool`, which lived in `ensureListener`. A pooled client
    // cannot hold LISTEN, so the store opens a dedicated Client — and the only place to
    // get connection parameters is the pool's `options`. That check was unreachable while
    // `toPool` refused foreign pools; accepting them without fixing it would have handed
    // the pool OBJECT to `new Client(…)`, which is the original bug verbatim.
    const reader = new PostgresEventStore(borrowed as never, { notifyBuckets: 8 });
    const writer = new PostgresEventStore(
      { connectionString: PG_URL, options: `-c search_path=${SCHEMA}` },
      { notifyBuckets: 8 }
    );
    const seen: number[] = [];
    await reader.subscribe("fp-notify", (e) => seen.push(e.sequence));
    await writer.append({
      id: "fp-n0",
      workflowId: "w",
      executionId: "fp-notify",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {},
    });
    // Cross-process delivery is asynchronous.
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toEqual([0]);
    await writer.close();
    await reader.close();
  });

  it("leaves the lent pool open after close()", async () => {
    const store = new PostgresEventStore(borrowed as never);
    await store.close();
    // Still usable: close() ended nothing, because the store never owned it.
    const { rows } = await real.query("SELECT 1 AS ok");
    expect(rows[0]).toEqual({ ok: 1 });
  });
});

// ── A notification fetch that fails must not take the process down ───────────
//
// `onNotify` fetches the row a NOTIFY points at, so it rejects on any database blip.
// It runs from pg's `notification` emitter callback with nothing awaiting it, so an
// escaping rejection is UNHANDLED — and Node terminates the process by default. Normal
// cross-node traffic during a hiccup would take the node down.

describe("cross-node notification delivery — a failing fetch", () => {
  it("swallows the failure instead of rejecting into nothing", async () => {
    const { pool } = recordingPool();
    const failing = {
      ...pool,
      query: (sql: string) =>
        sql.includes("SELECT * FROM events")
          ? Promise.reject(new Error("connection terminated"))
          : Promise.resolve({ rows: [], rowCount: 0 }),
    };
    const store = new PostgresEventStore(failing as never);
    await store.subscribe("x1", () => {});

    // Drive the private handler the emitter calls, with a payload naming a subscribed
    // execution so it reaches the row fetch.
    const onNotify = (store as unknown as { onNotify(raw: string): Promise<void> }).onNotify;
    await expect(
      onNotify.call(store, JSON.stringify(["other-sender", "x1", 0]))
    ).resolves.toBeUndefined();
  });
});
