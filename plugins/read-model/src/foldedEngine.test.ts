import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { FoldedModelEngine } from "./FoldedModelEngine";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { evt, ingestProjection, keyOf, scopeOf } from "./foldedFixtures";
import { FoldGapError, FoldVersionMismatchError } from "./types";

const X = "u1:wf:ingest-d1";
const ID = "ingest-status";

function boot(
  onError: (e: unknown) => void = (e) => {
    throw e;
  }
) {
  const store = new InMemoryReadModelStore();
  const engine = new FoldedModelEngine(store, onError);
  return { store, engine };
}
const stored = async (store: InMemoryReadModelStore, id = X) =>
  (await store.getFolded(ID, [id]))[0];

describe("FoldedModelEngine — registration (D1, D5)", () => {
  it("requires a non-blank version", async () => {
    const { engine } = boot();
    const bad = { projection: { ...ingestProjection(), version: "  " } };
    await expect(engine.register(bad)).rejects.toThrow(/version/);
  });

  it("refuses a duplicate id", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(engine.register({ projection: ingestProjection() })).rejects.toThrow(
      /already registered/
    );
  });
});

describe("FoldedModelEngine — the contiguous fold (D3, D4)", () => {
  it("folds a batch and stores the key and scope", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf, scopeOf });
    const batch = [
      evt(X, 0, "STEP_COMPLETED", { step: "ocr" }),
      evt(X, 1, "STEP_COMPLETED", { step: "embed" }),
    ];
    expect(await engine.foldBatch(ID, X, undefined, batch)).toBe(true);
    expect(await stored(store)).toMatchObject({
      key: "d1",
      scope: "u1",
      sequence: 1,
      state: { status: "running", steps: 2, last: "embed" },
    });
  });

  it("folds only what is past the record's watermark", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    const first = [
      evt(X, 0, "STEP_COMPLETED", { step: "a" }),
      evt(X, 1, "STEP_COMPLETED", { step: "b" }),
    ];
    await engine.foldBatch(ID, X, undefined, first);
    const rec = await engine.mark(ID, X);
    expect(await engine.foldBatch(ID, X, rec, first)).toBe(false); // a re-delivery folds nothing
    expect(
      await engine.foldBatch(ID, X, rec, [...first, evt(X, 2, "STEP_COMPLETED", { step: "c" })])
    ).toBe(true);
    expect((await stored(store))?.state).toMatchObject({ steps: 3, last: "c" });
  });

  it("an unhandled batch advances the watermark with a null state", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await engine.foldBatch(ID, X, undefined, [
      evt(X, 0, "SOMETHING_ELSE"),
      evt(X, 1, "SOMETHING_ELSE"),
    ]);
    expect(await stored(store)).toMatchObject({ sequence: 1, state: null });
  });

  it("round-trips each state through JSON so incremental == batch for non-JSON values", async () => {
    const { store, engine } = boot();
    const p = ingestProjection();
    // a handler that leaves an undefined property: the persisted state must not differ by path
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = (s: object) => ({
      ...s,
      extra: undefined,
      n: 1,
    });
    await engine.register({ projection: p });
    await engine.foldBatch(ID, X, undefined, [
      evt(X, 0, "STEP_COMPLETED"),
      evt(X, 1, "STEP_COMPLETED"),
    ]);
    expect((await stored(store))?.state).toStrictEqual({ status: "queued", steps: 0, n: 1 });
  });

  it("a handler returning undefined is a loud error, not a stored null", async () => {
    const { store, engine } = boot();
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = () => undefined;
    await engine.register({ projection: p });
    await expect(engine.foldBatch(ID, X, undefined, [evt(X, 0, "STEP_COMPLETED")])).rejects.toThrow(
      /state must be a JSON value/
    );
    expect(await stored(store)).toBeUndefined();
  });

  it("refuses to fold over a hole: the first event must follow the watermark", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(
      engine.foldBatch(ID, X, undefined, [evt(X, 2, "STEP_COMPLETED", { step: "late" })])
    ).rejects.toBeInstanceOf(FoldGapError);
    expect(await stored(store)).toBeUndefined(); // nothing was written
  });

  it("folds across a hole only when the caller vouches for it (`accounted`)", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    // events 0..1 were observed as unhandled by this node; 2 is the first handled one
    await engine.foldBatch(ID, X, undefined, [evt(X, 2, "STEP_COMPLETED", { step: "c" })], 1);
    expect(await stored(store)).toMatchObject({ sequence: 2, state: { steps: 1 } });
  });
});

describe("FoldedModelEngine — hardening", () => {
  const step = (n: number) => evt(X, n, "STEP_COMPLETED", { step: `s${n}` });

  it("refuses a mid-batch hole before writing", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(
      engine.foldBatch(ID, X, undefined, [step(0), step(1), step(3)])
    ).rejects.toBeInstanceOf(FoldGapError);
    expect(await stored(store)).toBeUndefined();
  });

  it("refuses duplicate and unsorted batches", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(
      engine.foldBatch(ID, X, undefined, [step(0), step(1), step(1)])
    ).rejects.toBeInstanceOf(FoldGapError);
    await expect(engine.foldBatch(ID, X, undefined, [step(1), step(0)])).rejects.toBeInstanceOf(
      FoldGapError
    );
    expect(await stored(store)).toBeUndefined();
  });

  it("a mutating handler leaves the caller's base unchanged", async () => {
    const { engine } = boot();
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = (s: { steps: number }) => {
      s.steps++;
      return s;
    };
    await engine.register({ projection: p });
    const base = { sequence: 0, state: { status: "running", steps: 5 }, erased: false };
    await engine.foldBatch(ID, X, base, [step(1)]);
    expect(base.state).toStrictEqual({ status: "running", steps: 5 });
  });

  it("D5: same version keeps rows, a new version rebuilds, the old engine is refused", async () => {
    const store = new InMemoryReadModelStore();
    const old = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    expect(await old.register({ projection: ingestProjection("1") })).toEqual({ rebuilt: false });
    await old.foldBatch(ID, X, undefined, [step(0)]);
    const same = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    expect(await same.register({ projection: ingestProjection("1") })).toEqual({ rebuilt: false });
    expect(await stored(store)).toBeDefined();
    const next = new FoldedModelEngine(store, (e) => {
      throw e;
    });
    expect(await next.register({ projection: ingestProjection("2") })).toEqual({ rebuilt: true });
    expect(await stored(store)).toBeUndefined();
    await expect(old.foldBatch(ID, X, undefined, [step(0)])).rejects.toBeInstanceOf(
      FoldVersionMismatchError
    );
    expect(await stored(store)).toBeUndefined();
  });

  it("does not resolve handlers through the prototype", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await engine.foldBatch(ID, X, undefined, [
      evt(X, 0, "constructor"),
      evt(X, 1, "hasOwnProperty"),
    ]);
    expect(await stored(store)).toMatchObject({ sequence: 1, state: null });
  });

  it("NaN/Infinity (serialised to null) is rejected", async () => {
    const { store, engine } = boot();
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = () => Number.NaN;
    await engine.register({ projection: p });
    await expect(engine.foldBatch(ID, X, undefined, [step(0)])).rejects.toThrow(
      /state must be a JSON value/
    );
    expect(await stored(store)).toBeUndefined();
  });

  it("a non-string version gets the version message", async () => {
    const { engine } = boot();
    const bad = { projection: { ...ingestProjection(), version: 3 as never } };
    await expect(engine.register(bad)).rejects.toThrow(/version is required/);
  });

  it("a throwing handler mid-batch stores nothing", async () => {
    const { store, engine } = boot();
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).EXECUTION_FAILED = () => {
      throw new Error("boom");
    };
    await engine.register({ projection: p });
    await expect(
      engine.foldBatch(ID, X, undefined, [step(0), evt(X, 1, "EXECUTION_FAILED")])
    ).rejects.toThrow("boom");
    expect(await stored(store)).toBeUndefined();
  });

  it("a negative accounted does not vouch for a hole", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(engine.foldBatch(ID, X, undefined, [step(2)], 0)).rejects.toBeInstanceOf(
      FoldGapError
    );
  });

  it("an erased record folds nothing but its watermark advances", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await engine.foldBatch(ID, X, undefined, [step(0)]);
    const erased = { sequence: 0, state: null, erased: true };
    await engine.foldBatch(ID, X, erased, [step(1)]);
    expect(await stored(store)).toMatchObject({ sequence: 1, state: null });
  });
});

describe("FoldedModelEngine — the live tail (D4)", () => {
  it("folds a contiguous live tail and stores key + scope", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf, scopeOf });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "ocr" }));
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "embed" }));
    await engine.drain();
    expect(await stored(store)).toMatchObject({
      key: "d1",
      scope: "u1",
      sequence: 1,
      state: { status: "running", steps: 2, last: "embed" },
    });
  });

  it("ignores duplicates and lower sequences", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    expect((await stored(store))?.state).toMatchObject({ steps: 1 });
  });

  it("a gap with no liveSource is reported, never folded over", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    engine.handle(evt(X, 5, "STEP_COMPLETED", { step: "late" }));
    await engine.drain();
    expect(errs[0]).toBeInstanceOf(FoldGapError);
    expect(await stored(store)).toMatchObject({ sequence: 0 });
  });

  it("unhandled events in the sequence are NOT gaps: no liveSource, no error, no write per unhandled event", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "EXECUTION_STARTED")); // unhandled: bookkeeping only
    await engine.drain();
    expect(await stored(store)).toBeUndefined();
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "ocr" }));
    engine.handle(evt(X, 2, "NOISE"));
    engine.handle(evt(X, 3, "NOISE"));
    engine.handle(evt(X, 4, "STEP_COMPLETED", { step: "embed" }));
    await engine.drain();
    expect(errs).toEqual([]);
    expect(await stored(store)).toMatchObject({ sequence: 4, state: { steps: 2, last: "embed" } });
  });

  it("an unhandled event this node did not see in order stops vouching: the next handled event is a gap", async () => {
    const errs: unknown[] = [];
    const { engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "EXECUTION_STARTED"));
    engine.handle(evt(X, 2, "NOISE")); // 1 was never delivered
    engine.handle(evt(X, 3, "STEP_COMPLETED", { step: "x" }));
    await engine.drain();
    expect(errs[0]).toBeInstanceOf(FoldGapError);
  });

  it("a cold node (missed events 0..1) fills the gap from liveSource", async () => {
    const log = new InMemoryAsyncEventStore();
    for (let i = 0; i < 3; i++) await log.append(evt(X, i, "STEP_COMPLETED", { step: `s${i}` }));
    const store = new InMemoryReadModelStore();
    const engine = new FoldedModelEngine(
      store,
      (e) => {
        throw e;
      },
      { liveSource: log }
    );
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 2, "STEP_COMPLETED", { step: "s2" })); // missed 0..1
    await engine.drain();
    expect((await stored(store))?.state).toMatchObject({ steps: 3 });
  });

  it("a liveSource that cannot fill the hole reports FoldGapError", async () => {
    const errs: unknown[] = [];
    const store = new InMemoryReadModelStore();
    const engine = new FoldedModelEngine(store, (e) => errs.push(e), {
      liveSource: new InMemoryAsyncEventStore(), // empty: has nothing to give
    });
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 3, "STEP_COMPLETED", { step: "late" }));
    await engine.drain();
    expect(errs[0]).toBeInstanceOf(FoldGapError);
    expect(await stored(store)).toBeUndefined();
  });

  it("a handler returning undefined is reported on the live path", async () => {
    const errs: unknown[] = [];
    const { engine } = boot((e) => errs.push(e));
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = () => undefined;
    await engine.register({ projection: p });
    engine.handle(evt(X, 0, "STEP_COMPLETED"));
    await engine.drain();
    expect(String(errs[0])).toMatch(/state must be a JSON value/);
  });
});

describe("FoldedModelEngine — live tail hardening", () => {
  it("a watermark ahead of the frontier is adopted: no spurious gap after a skipped duplicate", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "EXECUTION_STARTED")); // frontier 0
    await engine.drain();
    // catch-up (or another node) folds through 1
    await engine.foldBatch(ID, X, undefined, [evt(X, 1, "STEP_COMPLETED", { step: "a" })], 0);
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "a" })); // skipped: already stored
    engine.handle(evt(X, 2, "NOISE"));
    engine.handle(evt(X, 3, "STEP_COMPLETED", { step: "b" }));
    await engine.drain();
    expect(errs).toEqual([]);
    expect(await stored(store)).toMatchObject({ sequence: 3, state: { steps: 2 } });
  });

  it("a throwing onError is swallowed and later events still apply", async () => {
    let calls = 0;
    const { store, engine } = boot(() => {
      calls++;
      throw new Error("onError boom");
    });
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 5, "STEP_COMPLETED", { step: "late" })); // gap -> onError throws
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    expect(calls).toBe(1);
    expect(await stored(store)).toMatchObject({ sequence: 0 });
  });

  it("enqueue runs jobs in order and a rejected job does not stop the next; drain waits for late work", async () => {
    class Probe extends FoldedModelEngine {
      run<T>(id: string, job: () => Promise<T>) {
        return this.enqueue(ID, id, job);
      }
    }
    const engine = new Probe(new InMemoryReadModelStore(), () => {});
    const order: string[] = [];
    const a = engine.run(X, async () => {
      order.push("a");
      throw new Error("a failed");
    });
    const b = engine.run(X, async () => {
      order.push("b");
      // enqueued while drain() is already waiting
      void engine.run(X, async () => {
        order.push("late");
      });
    });
    await expect(a).rejects.toThrow("a failed");
    const drained = engine.drain();
    await drained;
    await b;
    expect(order).toEqual(["a", "b", "late"]);
  });
});

describe("FoldedModelEngine — reads, refresh, purge (D7, D8, D12)", () => {
  const Y = "u1:wf:ingest-d1.2";

  it("getMany omits absent, never-matched and erased executions; carries the sequence", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf, scopeOf });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    await engine.foldBatch(ID, "u1:wf:ingest-d3", undefined, [evt("u1:wf:ingest-d3", 0, "NOISE")]);
    const got = await engine.getMany(ID, [X, "u1:wf:ingest-d3", "u1:wf:ingest-nope"]);
    expect([...got.keys()]).toEqual([X]);
    expect(got.get(X)).toMatchObject({ sequence: 0, key: "d1", state: { steps: 1 } });
    await engine.purge(ID, { executionId: X });
    expect((await engine.getMany(ID, [X])).size).toBe(0);
  });

  it("getManyByKey groups generations under one key, ordered by executionId", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf });
    for (const id of [Y, X]) engine.handle(evt(id, 0, "EXECUTION_COMPLETED"));
    await engine.drain();
    const got = await engine.getManyByKey(ID, ["d1", "zzz"]);
    expect(got.get("d1")?.map((s) => s.executionId)).toEqual([X, Y]);
    expect(got.has("zzz")).toBe(false);
  });

  it("refresh reads the log tail: read-your-writes without the live feed", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await log.append(evt(X, 1, "EXECUTION_COMPLETED"));
    expect((await engine.getMany(ID, [X])).size).toBe(0); // live feed never delivered
    const got = await engine.getMany(ID, [X], { refreshFrom: [log] });
    expect(got.get(X)?.state).toMatchObject({ status: "done", steps: 1 });
    expect(await engine.refresh(ID, [X], [log])).toBe(0); // current: nothing to fold
  });

  it("refresh persists the watermark over an unhandled tail and the live tail then continues without a gap", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await log.append(evt(X, 1, "NOISE"));
    expect(await engine.refresh(ID, [X], [log])).toBe(1);
    expect((await stored(store))?.sequence).toBe(1);
    engine.handle(evt(X, 2, "STEP_COMPLETED", { step: "b" }));
    await engine.drain();
    expect(errs).toEqual([]);
    expect((await stored(store))?.sequence).toBe(2);
  });

  it("purge refuses an empty or multi-field selector", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(engine.purge(ID, {} as never)).rejects.toThrow(/exactly one/);
    await expect(engine.purge(ID, { key: "a", scope: "b" } as never)).rejects.toThrow(
      /exactly one/
    );
  });

  it("getManyByKey with refreshFrom refreshes only executions already known for the key (documented limit)", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "EXECUTION_COMPLETED")); // in the log, never folded: no row, so nothing to look up by key
    const byKey = await engine.getManyByKey(ID, ["d1"], { refreshFrom: [log] });
    expect(byKey.size).toBe(0);
    expect(await engine.refresh(ID, [X], [log], { concurrency: 2 })).toBe(1); // by id it is found
    expect((await engine.getManyByKey(ID, ["d1"])).get("d1")).toHaveLength(1);
  });

  it("refresh refuses a non-positive concurrency", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(engine.refresh(ID, [X], [], { concurrency: 0 })).rejects.toThrow(RangeError);
  });

  it("reset drops the states and the live frontier: a live event after it is a gap, not a fold over the lost prefix", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    await engine.reset(ID);
    expect(await store.getFolded(ID, [X])).toEqual([]);
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "b" })); // the old frontier (0) described states that are gone
    await engine.drain();
    expect(errs[0]).toBeInstanceOf(FoldGapError);
    expect(await store.getFolded(ID, [X])).toEqual([]);
  });

  it("purge normalizes the selector (an undefined sibling field is not a match) and refuses blanks", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf });
    engine.handle(evt(X, 0, "EXECUTION_COMPLETED"));
    await engine.drain();
    await expect(engine.purge(ID, { executionId: undefined, key: "  " } as never)).rejects.toThrow(
      /exactly one/
    );
    expect(await engine.purge(ID, { executionId: undefined, key: "d1" } as never)).toBe(1);
    expect((await store.getFolded(ID, [X]))[0]?.erased).toBe(true);
  });

  it("refresh validates executionIds", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(engine.refresh(ID, [""], [])).rejects.toThrow(TypeError);
    await expect(
      engine.refresh(
        ID,
        Array.from({ length: 1001 }, (_, i) => `e${i}`),
        []
      )
    ).rejects.toThrow(RangeError);
  });

  it("refresh never moves the frontier backwards: a live feed ahead of the source raises no gap", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    engine.handle(evt(X, 1, "NOISE"));
    engine.handle(evt(X, 2, "NOISE"));
    await engine.drain();
    await engine.refresh(ID, [X], [log]); // source only reaches 0; the frontier is at 2
    engine.handle(evt(X, 3, "STEP_COMPLETED", { step: "b" }));
    await engine.drain();
    expect(errs).toEqual([]);
    expect((await stored(store))?.sequence).toBe(3);
  });

  it("a live event enqueued while a refresh job is held is serialized behind it, no double fold", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const log = {
      readFrom: async (id: string, from: number) => {
        await held;
        return [
          evt(id, 0, "STEP_COMPLETED", { step: "a" }),
          evt(id, 1, "STEP_COMPLETED", { step: "b" }),
        ].filter((e) => e.sequence >= from);
      },
    };
    const refreshing = engine.refresh(ID, [X], [log]);
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "b" }));
    release();
    await refreshing;
    await engine.drain();
    expect(errs).toEqual([]);
    expect(await stored(store)).toMatchObject({ sequence: 1, state: { steps: 2 } });
  });

  it("reset racing a handle() cannot fold over the cleared prefix", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "b" })); // in flight when reset starts
    const resetting = engine.reset(ID);
    engine.handle(evt(X, 2, "STEP_COMPLETED", { step: "c" })); // arrives during the reset
    await resetting;
    await engine.drain();
    const rec = await stored(store);
    // Never a state built on a base that no longer exists: either nothing, or the full prefix.
    expect(rec === undefined || (rec.state as { steps: number }).steps === rec.sequence + 1).toBe(
      true
    );
    expect(errs.every((e) => e instanceof FoldGapError)).toBe(true);
  });

  it("purge racing a queued apply leaves the row erased with null state", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "b" })); // queued; reads the record before the purge
    await engine.purge(ID, { executionId: X });
    engine.handle(evt(X, 2, "STEP_COMPLETED", { step: "c" }));
    await engine.drain();
    expect(await stored(store)).toMatchObject({ erased: true, state: null });
  });
});
