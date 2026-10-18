import { describe, expect, it } from "vitest";
import { CountingStore, X, evt, node, step, stepsOf } from "./foldedFixtures";

describe("FoldedModelEngine — live-path state cache (D15)", () => {
  it("reads the row once for N sequential live events on a hot execution", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    for (let i = 0; i < 10; i++) engine.handle(step(X, i));
    await engine.drain();
    expect(store.reads).toBe(1); // the first event's base; the other nine come from the cache
    expect(await stepsOf(store)).toBe(10);
  });

  it("unhandled events between handled ones cost neither a read nor a gap", async () => {
    const store = new CountingStore();
    const errs: unknown[] = [];
    const engine = await node(store, {}, (e) => errs.push(e)); // no liveSource
    engine.handle(evt(X, 0, "NOISE"));
    engine.handle(step(X, 1));
    engine.handle(evt(X, 2, "NOISE"));
    engine.handle(step(X, 3));
    await engine.drain();
    expect(errs).toEqual([]);
    expect(store.reads).toBe(1); // only the first handled event read the store
    expect(await stepsOf(store)).toBe(2);
  });

  it("reads before every apply when the cache is disabled", async () => {
    for (const cache of [false, { maxEntries: 0 }] as const) {
      const store = new CountingStore();
      const engine = await node(store, { cache });
      for (let i = 0; i < 10; i++) engine.handle(step(X, i));
      await engine.drain();
      expect(store.reads).toBe(10);
      expect(engine.cacheSize()).toBe(0);
      expect(await stepsOf(store)).toBe(10);
    }
  });

  it("is bounded by maxEntries, and an eviction costs exactly one re-read", async () => {
    const store = new CountingStore();
    const engine = await node(store, { cache: { maxEntries: 2 } });
    const [A, B, C] = ["u1:wf:ingest-a", "u1:wf:ingest-b", "u1:wf:ingest-c"] as const;
    for (const id of [A, B, C]) {
      engine.handle(step(id, 0));
      await engine.drain(); // one at a time: A is deterministically the oldest entry
    }
    expect(store.reads).toBe(3);
    expect(engine.cacheSize()).toBe(2); // A was evicted when C was cached
    engine.handle(step(C, 1)); // hit
    await engine.drain();
    expect(store.reads).toBe(3);
    engine.handle(step(A, 1)); // evicted: one re-read, still correct
    await engine.drain();
    expect(store.reads).toBe(4);
    expect(await stepsOf(store, A)).toBe(2);
  });

  const otherNodeWrites = (store: CountingStore, upTo: number, steps: number) =>
    store.applyFolded({
      modelId: "ingest-status",
      executionId: X,
      upToSequence: upTo,
      state: { status: "running", steps },
      key: null,
      scope: null,
      foldVersion: "1",
    });

  it("a stale CAS drops the entry and re-reads once", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    expect(store.reads).toBe(1);
    await otherNodeWrites(store, 1, 2); // another node moves the row past this node's cached base
    store.reads = 0;
    engine.handle(step(X, 1)); // cached base says "next is 1": the CAS says stale
    await engine.drain();
    expect(store.reads).toBe(1); // dropped the entry, one re-read, event already covered
    expect(engine.cacheSize()).toBe(0);
    expect(await stepsOf(store)).toBe(2);
    store.reads = 1;
    engine.handle(step(X, 2)); // frontier adopted the store watermark: no gap, no cache
    await engine.drain();
    expect(store.reads).toBe(2);
    expect(await stepsOf(store)).toBe(3);
  });

  it("a cached base never decides a gap: the store is re-read first", async () => {
    const store = new CountingStore();
    const errs: unknown[] = [];
    const engine = await node(store, {}, (e) => errs.push(e));
    engine.handle(step(X, 0));
    await engine.drain();
    await otherNodeWrites(store, 5, 6);
    store.reads = 0;
    engine.handle(step(X, 6)); // contiguous with the STORE, not with the cached base (0)
    await engine.drain();
    expect(errs).toEqual([]);
    expect(store.reads).toBe(1);
    expect(await stepsOf(store)).toBe(7);
  });

  it("a catch-up/refresh write invalidates the entry; reads never touch the cache", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    expect(engine.cacheSize()).toBe(1);
    store.reads = 0;
    await engine.refresh("ingest-status", [X], [{ readFrom: async () => [step(X, 1)] }]);
    expect(engine.cacheSize()).toBe(0);
    store.reads = 0;
    await engine.getMany("ingest-status", [X]);
    expect(store.reads).toBe(1); // getMany reads the store, whatever the cache holds
    engine.handle(step(X, 2));
    await engine.drain();
    expect(store.reads).toBe(2);
    expect(await stepsOf(store)).toBe(3);
  });

  it("purge and reset drop the model's entries", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    await engine.purge("ingest-status", { executionId: X });
    expect(engine.cacheSize()).toBe(0);
    engine.handle(step("u1:wf:ingest-d2", 0));
    await engine.drain();
    expect(engine.cacheSize()).toBe(1);
    await engine.reset("ingest-status");
    expect(engine.cacheSize()).toBe(0);
  });
});
