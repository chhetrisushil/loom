import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { CoalescingEventStore } from "./CoalescingEventStore";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { ShardedEventStore } from "./ShardedEventStore";
import { SubscriberRegistry, bucketOf } from "./SubscriberRegistry";
import type { EventStore } from "./types";

const evt = (executionId: string, sequence: number): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "STEP_COMPLETED",
  sequence,
  timestamp: 1000 + sequence,
  payload: { sequence },
});

// NOTE: the decorators are also run through the FULL EventStore conformance suite — the
// strongest statement available about a decorator, that it is indistinguishable from what
// it wraps. Those runs live in `packages/conformance/src/index.test.ts`, because
// conformance depends on event-runtime and the reverse would be a project cycle.

/** A store that records how it was called, to prove round-trips were actually saved. */
function countingStore(inner: EventStore, opts: { noBatch?: boolean } = {}) {
  const calls = { append: 0, appendBatch: 0, batchSizes: [] as number[] };
  const store: EventStore = {
    append: (e) => {
      calls.append++;
      return inner.append(e);
    },
    read: (id) => inner.read(id),
    readFrom: (id, from) => inner.readFrom(id, from),
    subscribe: (id, h) => inner.subscribe(id, h),
    close: () => inner.close(),
    ...(opts.noBatch === true
      ? {}
      : {
          appendBatch: (envelopes: readonly EventEnvelope[]) => {
            calls.appendBatch++;
            calls.batchSizes.push(envelopes.length);
            return inner.appendBatch!(envelopes);
          },
        }),
  };
  return { store, calls };
}

describe("CoalescingEventStore", () => {
  it("merges concurrent appends across executions into ONE round-trip", async () => {
    const counting = countingStore(new InMemoryAsyncEventStore());
    const store = new CoalescingEventStore(counting.store, { maxBatch: 16 });
    // Eight independent executions appending at once — the real shape: many journals, one
    // pending envelope each.
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.append(evt(`x${i}`, 0))));
    expect(counting.calls.appendBatch).toBe(1);
    expect(counting.calls.batchSizes).toEqual([8]);
    expect(counting.calls.append).toBe(0);
    for (let i = 0; i < 8; i++) {
      expect((await store.read(`x${i}`)).map((e) => e.sequence)).toEqual([0]);
    }
    await store.close();
  });

  it("never resolves an append before its batch is durable", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = new InMemoryAsyncEventStore();
    const slow: EventStore = {
      append: (e) => inner.append(e),
      appendBatch: async (envelopes) => {
        await gate;
        await inner.appendBatch!(envelopes);
      },
      read: (id) => inner.read(id),
      readFrom: (id, f) => inner.readFrom(id, f),
      subscribe: (id, h) => inner.subscribe(id, h),
      close: () => inner.close(),
    };
    const store = new CoalescingEventStore(slow);
    let resolved = false;
    const pending = store.append(evt("a", 0)).then(() => {
      resolved = true;
    });
    // Give the flush every chance to run. The promise must still be outstanding: this is
    // the property separating coalescing from the durability classes ADR 0065 rejected.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(await inner.read("a")).toEqual([]);
    release?.();
    await pending;
    expect(resolved).toBe(true);
    expect((await inner.read("a")).length).toBe(1);
    await store.close();
  });

  it("rejects EVERY writer in a failed batch — a partial write never reads as success", async () => {
    const inner = new InMemoryAsyncEventStore();
    const failing: EventStore = {
      append: (e) => inner.append(e),
      appendBatch: async () => {
        throw new Error("storage down");
      },
      read: (id) => inner.read(id),
      readFrom: (id, f) => inner.readFrom(id, f),
      subscribe: (id, h) => inner.subscribe(id, h),
      close: () => inner.close(),
    };
    const store = new CoalescingEventStore(failing);
    const results = await Promise.allSettled([
      store.append(evt("a", 0)),
      store.append(evt("b", 0)),
      store.append(evt("c", 0)),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    await store.close().catch(() => {});
  });

  it("keeps working over a backend WITHOUT appendBatch (no win, no harm)", async () => {
    const counting = countingStore(new InMemoryAsyncEventStore(), { noBatch: true });
    const store = new CoalescingEventStore(counting.store);
    await Promise.all([store.append(evt("a", 0)), store.append(evt("b", 0))]);
    // Fell back to per-envelope appends — the honest bargain: correctness preserved,
    // round-trips not saved.
    expect(counting.calls.appendBatch).toBe(0);
    expect(counting.calls.append).toBe(2);
    expect((await store.read("a")).length).toBe(1);
    await store.close();
  });

  it("caps batches at maxBatch", async () => {
    const counting = countingStore(new InMemoryAsyncEventStore());
    const store = new CoalescingEventStore(counting.store, { maxBatch: 4 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.append(evt(`x${i}`, 0))));
    expect(Math.max(...counting.calls.batchSizes)).toBeLessThanOrEqual(4);
    expect(counting.calls.batchSizes.reduce((a, b) => a + b, 0)).toBe(10);
    await store.close();
  });

  it("preserves per-execution order when one execution has several envelopes queued", async () => {
    const store = new CoalescingEventStore(new InMemoryAsyncEventStore(), { maxBatch: 16 });
    await Promise.all([
      store.append(evt("s", 0)),
      store.append(evt("s", 1)),
      store.append(evt("s", 2)),
    ]);
    expect((await store.read("s")).map((e) => e.sequence)).toEqual([0, 1, 2]);
    await store.close();
  });
});

describe("ShardedEventStore", () => {
  const makeShards = (n: number) => Array.from({ length: n }, () => new InMemoryAsyncEventStore());

  it("routes an execution to exactly one shard, always the same one", async () => {
    const shards = makeShards(4);
    const store = new ShardedEventStore(shards);
    await store.append(evt("alpha", 0));
    await store.append(evt("alpha", 1));
    // Exactly one shard holds alpha's events; the rest are empty.
    const counts = await Promise.all(shards.map(async (s) => (await s.read("alpha")).length));
    expect(counts.filter((c) => c > 0)).toEqual([2]);
    await store.close();
  });

  it("spreads many executions across shards", async () => {
    const shards = makeShards(4);
    const store = new ShardedEventStore(shards);
    for (let i = 0; i < 200; i++) await store.append(evt(`e${i}`, 0));
    const perShard = await Promise.all(shards.map(async (s) => (await s.listExecutions!()).length));
    // Every shard used, and none holds everything — the point of hashing.
    expect(perShard.every((n) => n > 0)).toBe(true);
    expect(Math.max(...perShard)).toBeLessThan(200);
    expect(perShard.reduce((a, b) => a + b, 0)).toBe(200);
    await store.close();
  });

  it("splits an appendBatch by shard", async () => {
    const shards = makeShards(3);
    const store = new ShardedEventStore(shards);
    const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
    await store.appendBatch(ids.map((id) => evt(id, 0)));
    for (const id of ids) expect((await store.read(id)).length).toBe(1);
    await store.close();
  });

  it("forks across shards via the per-event fallback", async () => {
    const shards = makeShards(4);
    const store = new ShardedEventStore(shards);
    for (let i = 0; i < 5; i++) await store.append(evt("parent", i));
    // Try child ids until one lands on a different shard than the parent — the case with
    // no server-side copy path.
    const parentSlot = bucketOf("parent", 4);
    const child = Array.from({ length: 50 }, (_, i) => `child-${i}`).find(
      (id) => bucketOf(id, 4) !== parentSlot
    );
    expect(child).toBeDefined();
    await store.copyPrefix("parent", child as string, 3, { forkedFrom: "parent" });
    const copied = await store.read(child as string);
    expect(copied.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(copied[0]?.executionId).toBe(child);
    expect(copied[0]?.metadata).toMatchObject({ forkedFrom: "parent" });
    await store.close();
  });

  it("enumerates lexicographically and completely across shards", async () => {
    const shards = makeShards(4);
    const store = new ShardedEventStore(shards);
    const ids = Array.from({ length: 57 }, (_, i) => `exec-${String(i).padStart(3, "0")}`);
    for (const id of ids) await store.append(evt(id, 0));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await store.listExecutionsPage!({ ...(cursor && { cursor }), limit: 10 });
      seen.push(...page.executionIds);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...ids].sort()); // all, exactly once, lexicographic
    await store.close();
  });

  it("hides an optional capability unless EVERY shard has it", async () => {
    const bare = {
      append: async () => {},
      read: async () => [],
      readFrom: async () => [],
      subscribe: async () => () => {},
      close: async () => {},
    } satisfies EventStore;
    const store = new ShardedEventStore([new InMemoryAsyncEventStore(), bare]);
    // A capability present on only some shards would work or not depending on where an
    // execution hashed — worse than not advertising it.
    expect(store.listExecutions).toBeUndefined();
    expect(store.acquireFence).toBeUndefined();
    await store.close();
  });

  it("refuses to be constructed with no shards", () => {
    expect(() => new ShardedEventStore([])).toThrow(/at least one shard/);
  });
});

describe("SubscriberRegistry", () => {
  it("fans out only to the matching execution's handlers", () => {
    const reg = new SubscriberRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.add("x", a);
    reg.add("y", b);
    reg.emit(evt("x", 0));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("reports interest, and drops an execution when its last handler leaves", () => {
    const reg = new SubscriberRegistry();
    const un1 = reg.add("x", () => {});
    const un2 = reg.add("x", () => {});
    expect(reg.interest()).toEqual(["x"]);
    un1();
    expect(reg.has("x")).toBe(true); // one handler remains
    un2();
    expect(reg.has("x")).toBe(false);
    expect(reg.interest()).toEqual([]);
  });

  it("signals first/last interest so a transport can subscribe upstream in step", () => {
    const events: string[] = [];
    const reg = new SubscriberRegistry({
      onInterestChange: (id, kind) => events.push(`${kind}:${id}`),
    });
    const un1 = reg.add("x", () => {});
    const un2 = reg.add("x", () => {}); // not "first" again
    un1();
    un2();
    reg.add("x", () => {}); // "first" again after a full teardown
    expect(events).toEqual(["first:x", "last:x", "first:x"]);
  });

  it("unsubscribe is idempotent and cannot tear down a later subscription", () => {
    const reg = new SubscriberRegistry();
    const handler = () => {};
    const un = reg.add("x", handler);
    un();
    un(); // must not fire "last" twice or remove what comes next
    const seen = vi.fn();
    reg.add("x", seen);
    un();
    reg.emit(evt("x", 0));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("tolerates a handler unsubscribing during delivery", () => {
    const reg = new SubscriberRegistry();
    const order: string[] = [];
    const unA = reg.add("x", () => {
      order.push("a");
      unA();
    });
    reg.add("x", () => order.push("b"));
    reg.emit(evt("x", 0));
    expect(order).toEqual(["a", "b"]); // iteration over a copy — "b" still ran
  });

  it("bucketOf is stable, in range, and spreads", () => {
    expect(bucketOf("abc", 8)).toBe(bucketOf("abc", 8));
    expect(bucketOf("anything", 1)).toBe(0);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const b = bucketOf(`exec-${i}`, 8);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(8);
      seen.add(b);
    }
    expect(seen.size).toBe(8);
  });
});
