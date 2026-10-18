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
