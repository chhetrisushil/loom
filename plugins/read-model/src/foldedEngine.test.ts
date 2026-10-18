import { describe, expect, it } from "vitest";
import { FoldedModelEngine } from "./FoldedModelEngine";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ingestProjection } from "./foldedFixtures";

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
