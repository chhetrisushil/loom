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

/** Wait on a condition, never a fixed sleep: cross-node delivery is asynchronous. */
const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const LOOKUP = "SELECT * FROM events WHERE execution_id = $1 AND sequence = $2";

/** A pool whose `query` is routed through `hook` (return undefined to fall through to the real pool). */
const wrapPool = (
  real: Pool,
  hook: (text: string, params: unknown[] | undefined) => Promise<unknown> | undefined
): Pool =>
  ({
    options: real.options,
    connect: real.connect.bind(real),
    end: real.end.bind(real),
    query: (async (text: string, params?: unknown[]) =>
      (await hook(text, params)) ??
      real.query(text, params as unknown[])) as unknown as Pool["query"],
  }) as unknown as Pool;

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
    // Cross-process delivery is asynchronous: wait for both, then check the ORDER.
    await until(() => seen.length >= 2);
    expect(seen).toEqual([0, 1]);
    await writer.close();
    await reader.close();
  });

  it("does NOT deliver events from buckets a node has no interest in", async () => {
    // With 64 buckets, two ids collide only by chance; pick a pair that provably differ.
    const buckets = 64;
    const writer = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: buckets });
    let lookups = 0;
    const lookedUp: unknown[] = [];
    const counting = wrapPool(track(new Pool(scoped())), (text, params) => {
      if (typeof text === "string" && text.startsWith(LOOKUP)) {
        lookups++;
        lookedUp.push(params?.[0]);
      }
      return undefined;
    });
    const reader = new PostgresEventStore(counting, { notifyBuckets: buckets });
    let deliveries = 0;
    await reader.subscribe(ID("wanted"), () => {
      deliveries++;
    });
    // Write to 40 OTHER executions. Pre-bucketing every one of these would have crossed the
    // wire to this node and been discarded client-side.
    for (let i = 0; i < 40; i++) await writer.append(evt(ID(`unwanted-${i}`), 0));
    // The node is still live for what it DID ask for. The wanted append commits after every
    // unwanted one and NOTIFYs arrive on the listener in commit order, so once it is delivered
    // anything the unwanted appends could have caused has already happened.
    await writer.append(evt(ID("wanted"), 0));
    await until(() => deliveries >= 1);
    expect(deliveries).toBe(1);
    // The evidence that interest filtering holds: the ONLY cross-node lookup is the wanted event's.
    // A node that fetched (then discarded) the 40 uninterested events would show 41 here.
    expect(lookups).toBe(1);
    expect(lookedUp).toEqual([ID("wanted")]);
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
    // UNLISTEN is queued behind the same serial chain as LISTEN: wait for the session to drop it.
    await until(
      async () =>
        (await listener.query("SELECT channel FROM pg_listening_channels() AS channel")).rows
          .length === 0
    );
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
    await until(() => seen.length >= 3);
    // EVERY envelope is delivered, not just each execution's tip — a batch must not
    // silently coalesce what per-event append would have delivered separately.
    expect([...seen].sort()).toEqual(["p0", "p1", "q0"]);
    // ...and each execution's events in commit order.
    expect(seen.filter((x) => x.startsWith("p"))).toEqual(["p0", "p1"]);
    await writer.close();
    await reader.close();
  });

  it("delivers an execution's events in commit order even when their lookups complete out of order", async () => {
    // Each NOTIFY becomes an event through its own pooled SELECT, and those complete in any order
    // under load: the cross-node subscriber used to receive [1, 0]. Force that interleaving: the
    // reader's lookup of sequence 0 is held until its lookup of sequence 1 has COMPLETED.
    const real = track(new Pool(scoped()));
    const LOOKUP = "SELECT * FROM events WHERE execution_id = $1 AND sequence = $2";
    let releaseZero!: () => void;
    const oneDone = new Promise<void>((r) => {
      releaseZero = r;
    });
    let held = 0;
    const gated = {
      options: real.options,
      connect: real.connect.bind(real),
      end: real.end.bind(real),
      query: (async (text: string, params?: unknown[]) => {
        if (typeof text === "string" && text.startsWith(LOOKUP) && params?.[0] === ID("ordered")) {
          if (params[1] === 0) {
            held++;
            await oneDone;
            return real.query(text, params);
          }
          if (params[1] === 1) {
            const r = await real.query(text, params);
            releaseZero();
            return r;
          }
        }
        return real.query(text, params as unknown[]);
      }) as unknown as Pool["query"],
    };
    const writer = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const reader = new PostgresEventStore(gated as unknown as Pool, { notifyBuckets: 8 });
    const seen: number[] = [];
    await reader.subscribe(ID("ordered"), (e) => seen.push(e.sequence));
    await writer.append(evt(ID("ordered"), 0));
    await writer.append(evt(ID("ordered"), 1));
    await until(() => seen.length >= 2);
    expect(held).toBe(1); // the interleaving really was forced
    expect(seen).toEqual([0, 1]);
    await writer.close();
    await reader.close();
  });

  it("a local append is emitted synchronously and may overtake an in-flight cross-node event; remote events stay ordered among themselves", async () => {
    // Pins the documented EventStore.subscribe contract: only events from OTHER nodes are ordered
    // relative to each other. Hold the reader's lookup of the remote seq 0 until its LOCAL seq 1
    // append has been emitted, so the overtake is deterministic rather than a race.
    let releaseZero!: () => void;
    const gate = new Promise<void>((r) => {
      releaseZero = r;
    });
    const real = track(new Pool(scoped()));
    const gated = wrapPool(real, async (text, params) => {
      if (typeof text === "string" && text.startsWith(LOOKUP) && params?.[1] === 0) {
        await gate;
      }
      return undefined;
    });
    const writer = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const reader = new PostgresEventStore(gated, { notifyBuckets: 8 });
    const seen: number[] = [];
    await reader.subscribe(ID("overtake"), (e) => seen.push(e.sequence));
    await writer.append(evt(ID("overtake"), 0)); // remote to the reader; its lookup is held
    await reader.append(evt(ID("overtake"), 1)); // local to the reader: emitted synchronously
    expect(seen).toEqual([1]); // the local append overtook the in-flight remote event
    releaseZero();
    await until(() => seen.length >= 2);
    expect([...seen].sort()).toEqual([0, 1]); // nothing lost, nothing duplicated
    await writer.append(evt(ID("overtake"), 2));
    await writer.append(evt(ID("overtake"), 3));
    await until(() => seen.length >= 4);
    // remote events (0, 2, 3) are in commit order among themselves
    expect(seen.filter((n) => n !== 1)).toEqual([0, 2, 3]);
    await writer.close();
    await reader.close();
  });

  it("a lookup that never returns is dropped after the timeout (warned once) and later events still arrive", async () => {
    const real = track(new Pool(scoped()));
    const warnings: string[] = [];
    const hung = wrapPool(real, (text, params) => {
      if (typeof text === "string" && text.startsWith(LOOKUP) && params?.[1] === 0) {
        return new Promise(() => {}); // half-open socket: never settles
      }
      return undefined;
    });
    const writer = new PostgresEventStore(track(new Pool(scoped())), { notifyBuckets: 8 });
    const reader = new PostgresEventStore(hung, {
      notifyBuckets: 8,
      deliveryLookupTimeoutMs: 50,
      onWarn: (m) => warnings.push(m),
    });
    const seen: number[] = [];
    await reader.subscribe(ID("hung"), (e) => seen.push(e.sequence));
    await writer.append(evt(ID("hung"), 0));
    await writer.append(evt(ID("hung"), 1));
    await writer.append(evt(ID("hung"), 2));
    await until(() => seen.length >= 2);
    expect(seen).toEqual([1, 2]); // seq 0 dropped, the chain proceeded in order
    const ours = warnings.filter((w) => w.includes(ID("hung")));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain("#0");
    // The queue entry is freed once the tail settles.
    // biome-ignore lint/suspicious/noExplicitAny: private map — asserts the leak is closed
    await until(() => (reader as any).deliveryTail.size === 0);
    await writer.close();
    await reader.close();
  });
});
