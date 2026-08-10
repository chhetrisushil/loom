import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";

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
