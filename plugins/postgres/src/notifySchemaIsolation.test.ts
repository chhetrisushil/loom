import type { EventEnvelope } from "@loom/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { migrate } from "./schema";

// NOTIFY channels are DATABASE-wide; a log is scoped to a SCHEMA (the pool's `search_path`).
// A listener used to act on any notification for an execution it subscribed to: it re-read
// `(executionId, sequence)` from its OWN schema and delivered that row. So an append to `x`/1
// in schema B re-delivered schema A's `x`/1 to A's subscriber — a duplicate (and the
// conformance case "subscribe delivers appended events" flaked whenever two runs shared a
// database). Every notification now names its schema and a listener drops a foreign one.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;
const SCHEMA_A = `loom_notify_iso_a_${process.pid}`;
const SCHEMA_B = `loom_notify_iso_b_${process.pid}`;

const evt = (
  executionId: string,
  sequence: number,
  eventType = "STEP_COMPLETED"
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload: { sequence },
});

async function until(cond: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10)); // a poll interval, not a fixed wait
  }
}

suite("NOTIFY delivery is scoped to the store's schema", () => {
  const pools: Pool[] = [];
  const pool = (schema: string, max = 4): Pool => {
    const p = new Pool({ connectionString: PG_URL, options: `-c search_path=${schema}`, max });
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (const s of [SCHEMA_A, SCHEMA_B]) {
        await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
        await admin.query(`CREATE SCHEMA ${s}`);
      }
    } finally {
      await admin.end();
    }
    await migrate(pool(SCHEMA_A));
    await migrate(pool(SCHEMA_B));
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (const s of [SCHEMA_A, SCHEMA_B]) {
        await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  it("an append of the same execution id in ANOTHER schema never re-delivers this schema's events", async () => {
    // `max: 1` serializes the subscriber's notification lookups in arrival order, which makes
    // the witness below a barrier: once its event is delivered, every earlier notification's
    // lookup has completed, so a duplicate would already be in `seen`.
    const subscriber = new PostgresEventStore(pool(SCHEMA_A, 1));
    const foreign = new PostgresEventStore(pool(SCHEMA_B));
    const witness = new PostgresEventStore(pool(SCHEMA_A));
    const seen: number[] = [];
    const unsub = await subscriber.subscribe("x", (e) => seen.push(e.sequence));

    await subscriber.append(evt("x", 0, "EXECUTION_STARTED"));
    await subscriber.append(evt("x", 1));
    await subscriber.append(evt("x", 2));
    expect(seen).toEqual([0, 1, 2]); // local delivery is synchronous

    // Schema B writes the same slots through every notifying path: append, appendBatch,
    // and appendIfUnchanged.
    await foreign.append(evt("x", 0, "EXECUTION_STARTED"));
    await foreign.appendBatch([evt("x", 1)]);
    const tip = await foreign.appendIfUnchanged("x", null);
    if (tip.appended) throw new Error("unreachable");
    const landed = await foreign.appendIfUnchanged("x", evt("x", 2), {
      head: tip.head as number,
      fence: tip.fence,
      anchor: tip.anchor as string,
    });
    expect(landed.appended).toBe(true);

    // The witness: a genuine cross-node append in schema A, committed after all of the above.
    await witness.append(evt("x", 3));
    await until(() => seen.includes(3), "the witness event");

    expect(seen).toEqual([0, 1, 2, 3]);
    unsub();
    await Promise.all([subscriber.close(), foreign.close(), witness.close()]);
  });

  it("a same-schema append from another store is still delivered cross-node", async () => {
    const reader = new PostgresEventStore(pool(SCHEMA_A));
    const writer = new PostgresEventStore(pool(SCHEMA_A));
    const seen: number[] = [];
    const unsub = await reader.subscribe("same", (e) => seen.push(e.sequence));
    await writer.append(evt("same", 0, "EXECUTION_STARTED"));
    await writer.appendBatch([evt("same", 1)]);
    await until(() => seen.length >= 2, "both cross-node events");
    expect(seen).toEqual([0, 1]);
    unsub();
    await Promise.all([reader.close(), writer.close()]);
  });
});
