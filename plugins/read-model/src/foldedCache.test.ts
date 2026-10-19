import { projection$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import { FoldedModelEngine } from "./FoldedModelEngine";
import { CountingStore, X, evt, ingestProjection, node, step, stepsOf } from "./foldedFixtures";
import { FoldVersionMismatchError } from "./types";
import type { FoldedApply, FoldedApplyResult, FoldedSelector } from "./types";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Lets a test park `purgeFolded` (after it wrote) and `applyFolded` (before it writes). */
class GatedStore extends CountingStore {
  purgeGate: ReturnType<typeof deferred> | undefined;
  applyGate: ReturnType<typeof deferred> | undefined;
  purgeReached = deferred();
  applyReached = deferred();
  override async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    const n = await super.purgeFolded(modelId, selector);
    this.purgeReached.resolve();
    await this.purgeGate?.promise;
    return n;
  }
  override async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    if (this.applyGate !== undefined) {
      this.applyReached.resolve();
      await this.applyGate.promise;
    }
    return super.applyFolded(a);
  }
}

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
    store.reads = 0;
    engine.handle(step(X, 2)); // frontier adopted the store watermark: no gap, no cache
    await engine.drain();
    expect(store.reads).toBe(1);
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

  it("an apply in flight across a purge does not re-cache pre-purge state", async () => {
    const store = new GatedStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    expect(engine.cacheSize()).toBe(1);
    store.purgeGate = deferred();
    store.applyGate = deferred();
    const purged = engine.purge("ingest-status", { executionId: X });
    await store.purgeReached.promise; // the tombstone is written; purge has not resolved yet
    engine.handle(step(X, 1)); // takes X@0 from the cache and parks on its CAS
    await store.applyReached.promise;
    store.purgeGate.resolve();
    expect(await purged).toBe(1);
    store.applyGate.resolve(); // the apply lands on the erased row after purge finished
    await engine.drain();
    expect(engine.cacheSize()).toBe(0);
    expect((await store.getFolded("ingest-status", [X]))[0]).toMatchObject({
      state: null,
      erased: true,
      sequence: 1,
    });
  });

  it("registering another model leaves this model's entries alone; re-registering is refused", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    await engine.register({ projection: { ...ingestProjection(), id: "other" } });
    expect(engine.cacheSize()).toBe(1);
    await expect(engine.register({ projection: ingestProjection() })).rejects.toThrow(/already/);
    expect(engine.cacheSize()).toBe(1);
  });

  it("a version mismatch drops the model's cache entries", async () => {
    const store = new CountingStore();
    const errs: unknown[] = [];
    const a = await node(store, {}, (e) => errs.push(e));
    a.handle(step(X, 0));
    a.handle(step("u1:wf:ingest-d2", 0));
    await a.drain();
    expect(a.cacheSize()).toBe(2);
    const b = new FoldedModelEngine(store, () => {});
    await b.register({ projection: ingestProjection("2") }); // rebuilds the model under a new version
    a.handle(step(X, 1));
    await a.drain();
    expect(errs[0]).toBeInstanceOf(FoldVersionMismatchError);
    expect(a.cacheSize()).toBe(0); // the other execution's entry went too
  });

  it("a purge on another node: the next CAS reports applied-erased and the node stops folding", async () => {
    const store = new CountingStore();
    let calls = 0;
    const counting = () =>
      projection$<{ n: number }>({
        id: "ingest-status",
        name: "c",
        version: "1",
        initialState: { n: 0 },
        handlers: {
          STEP_COMPLETED: (s) => {
            calls++;
            return { n: s.n + 1 };
          },
        },
      });
    const a = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    await a.register({ projection: counting() });
    const b = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    await b.register({ projection: counting() });
    a.handle(step(X, 0));
    await a.drain();
    expect(calls).toBe(1);
    expect(await b.purge("ingest-status", { executionId: X })).toBe(1);
    a.handle(step(X, 1)); // cached base X@0: folds once, the CAS says the row is a tombstone
    await a.drain();
    expect(calls).toBe(2);
    expect(a.cacheSize()).toBe(1); // the erased marker, not folded state
    store.reads = 0;
    a.handle(step(X, 2));
    a.handle(step(X, 3));
    await a.drain();
    expect(calls).toBe(2); // the handler never runs over an erased execution
    expect(store.reads).toBe(2); // the erased marker is a hint: one store read per event (I2)
    expect((await store.getFolded("ingest-status", [X]))[0]).toMatchObject({
      state: null,
      erased: true,
      sequence: 3,
    });
  });
});

describe("FoldedModelEngine — the cache never weakens correctness (D15, 6c)", () => {
  it("after a purge the next live event reads the store, advances the tombstone and keeps no state", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    expect(await engine.purge("ingest-status", { executionId: X })).toBe(1);
    expect(engine.cacheSize()).toBe(0);
    store.reads = 0;
    engine.handle(step(X, 1));
    await engine.drain();
    expect(store.reads).toBe(1); // no cached base: one store read
    expect((await engine.getMany("ingest-status", [X])).size).toBe(0);
    expect((await store.getFolded("ingest-status", [X]))[0]).toMatchObject({
      state: null,
      erased: true,
      sequence: 1,
    });
  });

  it("getMany never serves a node's cached base: it sees another node's progress for one store read", async () => {
    const store = new CountingStore();
    const a = await node(store);
    const b = await node(store);
    a.handle(step(X, 0));
    await a.drain();
    expect(a.cacheSize()).toBe(1);
    for (const i of [1, 2]) b.handle(step(X, i));
    await b.drain();
    store.reads = 0;
    const got = await a.getMany("ingest-status", [X]);
    expect(store.reads).toBe(1);
    expect(got.get(X)).toMatchObject({ sequence: 2, state: { steps: 3 } });
  });

  it("a direct foldBatch deletes the entry, so the next live event re-reads the store", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    expect(engine.cacheSize()).toBe(1);
    await engine.foldBatch("ingest-status", X, await engine.mark("ingest-status", X), [step(X, 1)]);
    expect(engine.cacheSize()).toBe(0);
    store.reads = 0;
    engine.handle(step(X, 2));
    await engine.drain();
    expect(store.reads).toBe(1);
    expect(await stepsOf(store)).toBe(3);
  });
});
