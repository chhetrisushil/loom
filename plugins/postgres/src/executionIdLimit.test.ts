import type { EventEnvelope } from "@loom/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecutionIdTooLongError, MAX_EXECUTION_ID_BYTES, PostgresEventStore } from "./index";

// pg_notify's payload is capped at 8000 bytes and the append folds the NOTIFY into its insert, so
// an unbounded executionId made the APPEND itself fail ("payload string too long"). The store
// now refuses an over-limit id with a typed error before any write.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;
const SCHEMA = "loom_exec_id_limit_test";

const evt = (executionId: string, sequence: number): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "STEP_COMPLETED",
  sequence,
  timestamp: 1000 + sequence,
  payload: { sequence },
});

const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

suite("executionId length cap", () => {
  const pools: Pool[] = [];
  const stores: PostgresEventStore[] = [];
  const scoped = (): Pool => {
    const p = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}`, max: 6 });
    pools.push(p);
    return p;
  };
  const store = (): PostgresEventStore => {
    const s = new PostgresEventStore(scoped());
    stores.push(s);
    return s;
  };

  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    } finally {
      await admin.end();
    }
    const { migrate } = await import("./schema");
    await migrate(scoped());
  }, 60_000);

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close().catch(() => {})));
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  const overId = (tag: string): string => tag.padEnd(MAX_EXECUTION_ID_BYTES + 1, "o");
  const rowsFor = async (id: string): Promise<number> => {
    const p = scoped();
    const r = await p.query("SELECT count(*)::int AS n FROM events WHERE execution_id = $1", [id]);
    return r.rows[0].n;
  };

  const fenceRowsFor = async (id: string): Promise<number> => {
    const p = scoped();
    const r = await p.query("SELECT count(*)::int AS n FROM fences WHERE execution_id = $1", [id]);
    return r.rows[0].n;
  };

  it("append refuses an over-limit id with a typed error and writes nothing", async () => {
    const s = store();
    const over = overId("a-");
    await expect(s.append(evt(over, 0))).rejects.toBeInstanceOf(ExecutionIdTooLongError);
    expect(await rowsFor(over)).toBe(0);
  });

  it("appendBatch refuses a batch holding an over-limit id; no row of the batch lands", async () => {
    const s = store();
    const over = overId("b-");
    const ok = "batch-ok-id";
    await expect(s.appendBatch([evt(ok, 0), evt(over, 0)])).rejects.toBeInstanceOf(
      ExecutionIdTooLongError
    );
    expect(await rowsFor(over)).toBe(0);
    expect(await rowsFor(ok)).toBe(0);
  });

  it("appendIfUnchanged refuses an over-limit id and writes nothing", async () => {
    const s = store();
    const over = overId("c-");
    // Observe a real execution to get an expectation shape that WOULD match if the id were valid.
    const ok = "c-observed";
    await s.append(evt(ok, 0));
    const obs = await s.appendIfUnchanged(ok, null);
    if (obs.appended || obs.reason !== "observed") throw new Error("expected an observation");
    const expectShape = {
      head: obs.head as number,
      fence: obs.fence as number,
      anchor: obs.anchor as string,
    };
    await expect(s.appendIfUnchanged(over, evt(over, 1), expectShape)).rejects.toBeInstanceOf(
      ExecutionIdTooLongError
    );
    expect(await rowsFor(over)).toBe(0);
    expect(await fenceRowsFor(over)).toBe(0);
  });

  it("copyPrefix (a fork) to an over-limit id is refused and writes nothing", async () => {
    const s = store();
    const parent = "fork-parent";
    await s.append(evt(parent, 0));
    const over = overId("d-");
    await expect(s.copyPrefix(parent, over, 0, { forked: true })).rejects.toBeInstanceOf(
      ExecutionIdTooLongError
    );
    expect(await rowsFor(over)).toBe(0);
  });

  it("acquireFence and acquireFenceIf refuse an over-limit id and leave no fences row", async () => {
    const s = store();
    const over = overId("e-");
    await expect(s.acquireFence(over)).rejects.toBeInstanceOf(ExecutionIdTooLongError);
    await expect(s.acquireFenceIf(over, { fence: 0, parkSeq: 0 })).rejects.toBeInstanceOf(
      ExecutionIdTooLongError
    );
    expect(await fenceRowsFor(over)).toBe(0);
  });

  it("an id past the NOTIFY payload limit gets the typed error, not a Postgres one", async () => {
    const s = store();
    await expect(s.append(evt("h".repeat(8100), 0))).rejects.toBeInstanceOf(
      ExecutionIdTooLongError
    );
  });

  it("counts UTF-8 BYTES, not characters", async () => {
    const s = store();
    const multi = "é".repeat(MAX_EXECUTION_ID_BYTES / 2 + 1); // 1025 bytes, 513 chars
    await expect(s.append(evt(multi, 0))).rejects.toBeInstanceOf(ExecutionIdTooLongError);
  });

  it("an at-limit id appends on every path and reaches a cross-store subscriber", async () => {
    const a = store();
    const b = store();
    // Worst case for the JSON-escaped tag: a limit-sized id of characters that escape to 6 bytes (U+0001 becomes backslash-u0001).
    const atLimit = "\u0001".repeat(MAX_EXECUTION_ID_BYTES);
    const seen: number[] = [];
    await b.subscribe(atLimit, (e) => seen.push(e.sequence));
    await a.append(evt(atLimit, 0));
    await a.appendBatch([evt(atLimit, 1)]);
    const obs = await a.appendIfUnchanged(atLimit, null);
    if (obs.appended || obs.reason !== "observed") throw new Error("expected an observation");
    const r = await a.appendIfUnchanged(atLimit, evt(atLimit, 2), {
      head: obs.head as number,
      fence: obs.fence as number,
      anchor: obs.anchor as string,
    });
    expect(r).toEqual({ appended: true });
    await until(() => seen.length >= 3);
    expect(seen).toEqual([0, 1, 2]);
    expect(await rowsFor(atLimit)).toBe(3);
  }, 30_000);
});
