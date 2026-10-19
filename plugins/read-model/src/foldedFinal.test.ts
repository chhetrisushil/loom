import { projection$ } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { FoldedModelEngine, foldedStates } from "./FoldedModelEngine";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import { X, evt, ingestProjection, step } from "./foldedFixtures";
import {
  FoldGapError,
  type FoldedRecord,
  FoldedStateValueError,
  assertFoldedSelector,
} from "./types";

const ID = "ingest-status";

const shapeProjection = (build: (payload: unknown) => unknown) =>
  projection$<unknown>({
    id: "shape",
    name: "shape",
    version: "1",
    initialState: {},
    handlers: { STEP_COMPLETED: (_s, e) => build(e.payload) },
  });

describe("canonical state (I1, D14)", () => {
  it("re-keys objects into JSONB order (length, then bytes), recursively, identical live and batch", async () => {
    const mk = async () => {
      const store = new InMemoryReadModelStore();
      const engine = new FoldedModelEngine(store, (e) => {
        throw e;
      });
      await engine.register({
        projection: shapeProjection(() => ({
          bb: 1,
          a: { zz: 1, y: 2, aaa: [{ q: 1, p: 2 }] },
          c: 3,
        })),
      });
      return { store, engine };
    };
    const live = await mk();
    live.engine.handle(evt(X, 0, "STEP_COMPLETED"));
    await live.engine.drain();
    const batch = await mk();
    await batch.engine.foldBatch("shape", X, undefined, [evt(X, 0, "STEP_COMPLETED")]);
    const read = async (s: InMemoryReadModelStore) => (await s.getFolded("shape", [X]))[0]?.state;
    const a = (await read(live.store)) as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(["a", "c", "bb"]);
    expect(Object.keys(a.a as object)).toEqual(["y", "zz", "aaa"]);
    expect(JSON.stringify(await read(batch.store))).toBe(JSON.stringify(a));
  });

  it("refuses NUL and lone surrogates in values and keys, naming the path and never the value", async () => {
    for (const bad of ["a\u0000b-SECRET", "x\uD800-SECRET", "y\uDC00-SECRET"]) {
      for (const shape of [(v: string) => ({ deep: [{ v }] }), (v: string) => ({ [v]: 1 })]) {
        const errs: unknown[] = [];
        const store = new InMemoryReadModelStore();
        const engine = new FoldedModelEngine(store, (e) => errs.push(e));
        await engine.register({ projection: shapeProjection(() => shape(bad)) });
        engine.handle(evt(X, 0, "STEP_COMPLETED"));
        await engine.drain();
        expect(errs[0]).toBeInstanceOf(FoldedStateValueError);
        expect((errs[0] as Error).message).not.toContain("SECRET");
        expect((errs[0] as FoldedStateValueError).modelId).toBe("shape");
        expect(await store.getFolded("shape", [X])).toEqual([]);
      }
    }
  });

  it("accepts a valid surrogate pair", async () => {
    const store = new InMemoryReadModelStore();
    const engine = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    await engine.register({ projection: shapeProjection(() => ({ s: "😀" })) });
    expect(await engine.foldBatch("shape", X, undefined, [evt(X, 0, "STEP_COMPLETED")])).toBe(true);
  });
});

describe("a cached erased marker is only a hint (I2, D15)", () => {
  it("another node's rebuild after the marker was cached never yields a partial state", async () => {
    const store = new InMemoryReadModelStore();
    const errsA: unknown[] = [];
    const A = new FoldedModelEngine(store, (e) => errsA.push(e));
    const B = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    await A.register({ projection: ingestProjection() });
    await B.register({ projection: ingestProjection() });
    A.handle(step(X, 0));
    A.handle(step(X, 1));
    await A.drain();
    await store.purgeFolded(ID, { executionId: X }); // erased elsewhere (bypassing A's cache)
    A.handle(step(X, 2)); // CAS lands on the tombstone: A caches the erased marker at 2
    await A.drain();
    expect(A.cacheSize()).toBe(1);
    await B.reset(ID); // same-version rebuild on another node
    A.handle(step(X, 3));
    await A.drain();
    expect(errsA[0]).toBeInstanceOf(FoldGapError); // no liveSource: the hole is reported, not folded over
    const row = (await store.getFolded(ID, [X]))[0];
    expect(row === undefined || row.state === null).toBe(true);
  });

  it("a cached erased marker whose row is still erased advances the watermark as before", async () => {
    const store = new InMemoryReadModelStore();
    const A = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    await A.register({ projection: ingestProjection() });
    A.handle(step(X, 0));
    await A.drain();
    await store.purgeFolded(ID, { executionId: X });
    A.handle(step(X, 1));
    A.handle(step(X, 2));
    await A.drain();
    expect((await store.getFolded(ID, [X]))[0]).toMatchObject({
      sequence: 2,
      erased: true,
      state: null,
    });
  });
});

describe("catch-up skip seeds the live frontier (I3)", () => {
  it("an unhandled resume event after a skipped (current) execution is not a gap", async () => {
    const log = new InMemoryAsyncEventStore();
    await log.append(step(X, 0));
    await log.append(step(X, 1));
    const store = new InMemoryReadModelStore();
    const first = new ReadModelService(store);
    await first.registerFolded({ projection: ingestProjection() });
    await first.catchUp([log]);
    const errs: unknown[] = [];
    const restarted = new ReadModelService(store, { onError: (e) => errs.push(e) }); // no liveSource
    await restarted.registerFolded({ projection: ingestProjection() });
    await restarted.catchUp([log]); // execution is current: the skip branch
    restarted.handleEvent(evt(X, 2, "NOISE"));
    restarted.handleEvent(step(X, 3));
    await restarted.drain();
    expect(errs).toEqual([]);
    expect((await restarted.getMany(ID, [X])).get(X)?.state).toMatchObject({ steps: 3 });
  });
});

describe("foldedStates (I6)", () => {
  it("omits erased and null-state records, like getMany", () => {
    const rec = (executionId: string, over: Partial<FoldedRecord>): FoldedRecord => ({
      executionId,
      key: "k",
      scope: null,
      sequence: 3,
      state: { n: 1 },
      erased: false,
      ...over,
    });
    const out = foldedStates([
      rec("a", {}),
      rec("b", { erased: true, state: null }),
      rec("c", { state: null }),
    ]);
    expect(out).toEqual([{ executionId: "a", key: "k", sequence: 3, state: { n: 1 } }]);
  });
});

describe("selector and cache validation (Minors 1, 4)", () => {
  it("assertFoldedSelector refuses empty, blank, multi and non-string selectors", () => {
    for (const bad of [
      {},
      { key: "  " },
      { key: "a", scope: "b" },
      { executionId: 1 },
      { foo: "x" },
    ]) {
      expect(() => assertFoldedSelector(bad as never)).toThrow(TypeError);
    }
    expect(() => assertFoldedSelector({ scope: "u1" })).not.toThrow();
  });

  it("the in-memory store refuses a malformed selector", async () => {
    const store = new InMemoryReadModelStore();
    await expect(store.purgeFolded("m", {} as never)).rejects.toThrow(TypeError);
  });

  it("foldCache.maxEntries must be an integer >= 0", () => {
    const store = new InMemoryReadModelStore();
    for (const maxEntries of [-1, 1.5, Number.NaN]) {
      expect(() => new ReadModelService(store, { foldCache: { maxEntries } })).toThrow(RangeError);
    }
    expect(() => new ReadModelService(store, { foldCache: { maxEntries: 0 } })).not.toThrow();
    expect(() => new ReadModelService(store, { foldCache: false })).not.toThrow();
  });
});
