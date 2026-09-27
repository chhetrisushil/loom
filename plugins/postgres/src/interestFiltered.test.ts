import type { EventEnvelope } from "@loom/core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { NOTIFY_CHANNEL, migrate } from "./schema";

// ADR 0074 D4 — cross-node delivery must reach only the nodes that asked for it.
//
// Before bucketing, every store LISTENed one global channel and received every event in
// the database, discarding what it did not want: O(events x nodes), with the cost landing
// on the writer (measured 2.07-2.19x at four subscriber nodes). These pin that a store now
// subscribes only to the channels it has interest in.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;
const SCHEMA = "loom_interest_filter_test";
// NOTIFY channels are database-wide and the executionId is the delivery key, so ids must
// not collide with a sibling suite running concurrently against the same database
// (postgres-stores.test.ts uses "shared" for its own cross-node test).
const ID = (name: string): string => `if-${process.pid}-${name}`;

const evt = (executionId: string, sequence: number): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "STEP_COMPLETED",
  sequence,
  timestamp: 1000 + sequence,
  payload: { sequence },
});

suite("interest-filtered NOTIFY delivery", () => {
  const pools: Pool[] = [];
  const track = (p: Pool): Pool => {
    pools.push(p);
    return p;
  };
  const scoped = () => ({
    connectionString: PG_URL,
    options: `-c search_path=${SCHEMA}`,
    max: 6,
  });

  beforeAll(async () => {
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    } finally {
      await admin.end();
    }
    await migrate(new Pool(scoped()));
  }, 60_000);

  beforeEach(async () => {
    const admin = track(new Pool(scoped()));
    await admin.query("TRUNCATE events, fences");
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const admin = new Pool({ connectionString: PG_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it("delivers cross-node to a subscriber on the same bucket", async () => {
    const writer = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const reader = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const seen: number[] = [];
    await reader.subscribe(ID("shared"), (e) => seen.push(e.sequence));
    await writer.append(evt(ID("shared"), 0));
    await writer.append(evt(ID("shared"), 1));
    // Cross-process delivery is asynchronous.
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toEqual([0, 1]);
    await writer.close();
    await reader.close();
  });

  it("does NOT deliver events from buckets a node has no interest in", async () => {
    // With 64 buckets, two ids collide only by chance; pick a pair that provably differ.
    const buckets = 64;
    const writer = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: buckets });
    const reader = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: buckets });
    let deliveries = 0;
    await reader.subscribe(ID("wanted"), () => {
      deliveries++;
    });
    // Write to 40 OTHER executions. Pre-bucketing every one of these would have crossed the
    // wire to this node and been discarded client-side.
    for (let i = 0; i < 40; i++) await writer.append(evt(ID(`unwanted-${i}`), 0));
    await new Promise((r) => setTimeout(r, 500));
    expect(deliveries).toBe(0);
    // The node is still live for what it DID ask for.
    await writer.append(evt(ID("wanted"), 0));
    await new Promise((r) => setTimeout(r, 500));
    expect(deliveries).toBe(1);
    await writer.close();
    await reader.close();
  });

  it("LISTENs only on buckets with live interest, and UNLISTENs when it goes", async () => {
    const store = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const un = await store.subscribe(ID("a"), () => {});
    // The store's listener is its own dedicated connection; ask that session what it holds.
    // Reading the private client is the only way to assert against the real session rather
    // than a proxy for it.
    // biome-ignore lint/suspicious/noExplicitAny: private listener client — see above
    const listener = (store as any).listener as { query: Pool["query"] };
    const during = await listener.query("SELECT channel FROM pg_listening_channels() AS channel");
    expect(during.rows.length).toBe(1);
    expect(during.rows[0].channel.startsWith(`${NOTIFY_CHANNEL}_`)).toBe(true);
    un();
    // UNLISTEN is queued behind the same serial chain as LISTEN.
    await new Promise((r) => setTimeout(r, 200));
    const after = await listener.query("SELECT channel FROM pg_listening_channels() AS channel");
    expect(after.rows.length).toBe(0);
    await store.close();
  });

  it("notifyBuckets: 1 stays on the legacy channel name (rolling-upgrade escape hatch)", async () => {
    const store = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 1 });
    await store.subscribe(ID("x"), () => {});
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const listener = (store as any).listener as { query: Pool["query"] };
    const { rows } = await listener.query("SELECT channel FROM pg_listening_channels() AS channel");
    expect(rows.map((r: { channel: string }) => r.channel)).toEqual([NOTIFY_CHANNEL]);
    await store.close();
  });

  it("instance.notifyChannels() contains exactly the channel the store LISTENs on", async () => {
    // Ties the instance method to what the store ACTUALLY subscribes the OS socket to,
    // rather than re-deriving the same formula and testing it against itself — an external
    // LISTENer (tools/bench-throughput's fan-out scenarios) has only this method to go on,
    // so it must agree with the private `channelFor` on the wire.
    const buckets = 8;
    const store = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: buckets });
    const all = store.notifyChannels();
    expect(all).toHaveLength(buckets);
    await store.subscribe(ID("probe"), () => {});
    // biome-ignore lint/suspicious/noExplicitAny: private listener client — see above
    const listener = (store as any).listener as { query: Pool["query"] };
    const { rows } = await listener.query("SELECT channel FROM pg_listening_channels() AS channel");
    expect(rows).toHaveLength(1);
    expect(all).toContain(rows[0].channel);
    await store.close();
  });

  it("instance.notifyChannels() reflects THIS instance's notifyBuckets, not a caller's guess at the default", async () => {
    // The bug this instance method exists to close: a bench (or any external LISTENer)
    // that hard-codes "16" and passes it to a free function drifts silently the moment a
    // store is built with a different notifyBuckets. Two instances, two different bucket
    // counts, each instance's own method must answer for ITSELF.
    const eight = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const three = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 3 });
    expect(eight.notifyChannels()).toHaveLength(8);
    expect(three.notifyChannels()).toHaveLength(3);
    expect(eight.notifyChannels()).not.toEqual(three.notifyChannels());
    await eight.close();
    await three.close();
  });

  it("instance.notifyChannels() is the legacy channel a notifyBuckets: 1 store LISTENs on", async () => {
    const store = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 1 });
    await store.subscribe(ID("y"), () => {});
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const listener = (store as any).listener as { query: Pool["query"] };
    const { rows } = await listener.query("SELECT channel FROM pg_listening_channels() AS channel");
    expect(store.notifyChannels()).toEqual(rows.map((r: { channel: string }) => r.channel));
    await store.close();
  });

  it("appendBatch wakes every execution in the batch, on its own bucket", async () => {
    const writer = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const reader = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const seen: string[] = [];
    await reader.subscribe(ID("p"), (e) => seen.push(`p${e.sequence}`));
    await reader.subscribe(ID("q"), (e) => seen.push(`q${e.sequence}`));
    await writer.appendBatch([evt(ID("p"), 0), evt(ID("q"), 0), evt(ID("p"), 1)]);
    await new Promise((r) => setTimeout(r, 600));
    // EVERY envelope is delivered, not just each execution's tip — a batch must not
    // silently coalesce what per-event append would have delivered separately.
    expect([...seen].sort()).toEqual(["p0", "p1", "q0"]);
    await writer.close();
    await reader.close();
  });
});
