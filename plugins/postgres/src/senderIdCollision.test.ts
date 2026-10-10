import type { EventEnvelope } from "@loom/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Replicas in separate containers commonly all run as pid 1 and build stores in the same
// order. The sender tag used to be `pid-counter`, so every replica's first store was "1-1" and
// each treated the other's appends as its own, silently dropping cross-node subscribe.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;
const SCHEMA = "loom_sender_id_collision_test";
const EXEC = `sid-${process.pid}-x`;

const evt = (sequence: number): EventEnvelope => ({
  id: `${EXEC}-${sequence}`,
  workflowId: "wf",
  executionId: EXEC,
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

suite("sender id across processes", () => {
  const pools: Pool[] = [];
  const scoped = (): Pool => {
    const p = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA}`, max: 6 });
    pools.push(p);
    return p;
  };
  // A fresh module graph = a separate "process" (own counter), with the pid forced equal.
  const storeInFreshProcess = async () => {
    vi.resetModules();
    const m = await import("./PostgresEventStore");
    return new m.PostgresEventStore(scoped());
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
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it("delivers across two stores whose processes share a pid, and never echoes to self", async () => {
    const realPid = process.pid;
    Object.defineProperty(process, "pid", { value: 1, configurable: true });
    const stores: { close(): Promise<void> }[] = [];
    try {
      const a = await storeInFreshProcess();
      stores.push(a);
      const b = await storeInFreshProcess();
      stores.push(b);
      const seenByB: number[] = [];
      const seenByA: number[] = [];
      await b.subscribe(EXEC, (e) => seenByB.push(e.sequence));
      await a.subscribe(EXEC, (e) => seenByA.push(e.sequence));
      await a.append(evt(0));
      await a.append(evt(1));
      await until(() => seenByB.length >= 2);
      expect(seenByB).toEqual([0, 1]);
      // No self-echo, proven with a barrier rather than a wait: B appends seq 2, which reaches A
      // through the same listener AFTER any echo of A's own commits (NOTIFYs arrive in commit
      // order), so once A has seen 2 an echo would already be in seenByA.
      await b.append(evt(2));
      await until(() => seenByA.includes(2));
      expect(seenByA).toEqual([0, 1, 2]);
    } finally {
      await Promise.all(stores.map((s) => s.close().catch(() => {})));
      Object.defineProperty(process, "pid", { value: realPid, configurable: true });
    }
  }, 30_000);
});
