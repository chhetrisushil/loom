import { describe, expect, it } from "vitest";
import { FoldedModelEngine } from "./FoldedModelEngine";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { evt, ingestProjection, keyOf, scopeOf } from "./foldedFixtures";

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
});

describe("FoldedModelEngine — hardening", () => {
  it("D5: same version keeps rows, a new version rebuilds", async () => {
    const store = new InMemoryReadModelStore();
    const boot1 = (v: string) =>
      new FoldedModelEngine(store, (e) => {
        throw e;
      }).register({ projection: ingestProjection(v) });
    expect(await boot1("1")).toEqual({ rebuilt: false });
    await store.applyFolded({
      modelId: ID,
      executionId: X,
      upToSequence: 0,
      state: { steps: 1 },
      key: null,
      scope: null,
      foldVersion: "1",
    });
    expect(await boot1("1")).toEqual({ rebuilt: false });
    expect(await stored(store)).toBeDefined();
    expect(await boot1("2")).toEqual({ rebuilt: true });
    expect(await stored(store)).toBeUndefined();
  });

  it("a non-string version gets the version message", async () => {
    const { engine } = boot();
    const bad = { projection: { ...ingestProjection(), version: 3 as never } };
    await expect(engine.register(bad)).rejects.toThrow(/version is required/);
  });
});
