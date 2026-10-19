import { describe, expect, it } from "vitest";
import type { TaskContext } from "vitest";

// ── Folded-state half of the ReadModelStore SPI (ADR 0132, SPI 1.2.0) ────────
// Structural, like runReadModelStoreConformance: no plugin dependency. Every case skips
// when the backend omits the (all-or-none) optional methods.

export interface FoldedRecordLike {
  executionId: string;
  key: string | null;
  scope: string | null;
  sequence: number;
  state: unknown | null;
  erased: boolean;
}
export interface FoldedApplyLike {
  modelId: string;
  executionId: string;
  upToSequence: number;
  state: unknown | null;
  key: string | null;
  scope: string | null;
  foldVersion: string;
}
type Selector = { executionId: string } | { key: string } | { scope: string };

export interface FoldedStateStoreLike {
  beginFold?(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }>;
  applyFolded?(
    a: FoldedApplyLike
  ): Promise<"applied" | "applied-erased" | "stale" | "version-mismatch">;
  getFolded?(modelId: string, executionIds: readonly string[]): Promise<FoldedRecordLike[]>;
  getFoldedByKey?(modelId: string, keys: readonly string[]): Promise<FoldedRecordLike[]>;
  purgeFolded?(modelId: string, selector: Selector): Promise<number>;
  clear(modelId: string): Promise<void>;
}
type Full = Required<FoldedStateStoreLike>;

export function runFoldedStateConformance(
  factory: () => FoldedStateStoreLike,
  label = "ReadModelStore"
): void {
  const ap = (over: Partial<FoldedApplyLike> = {}): FoldedApplyLike => ({
    modelId: "m",
    executionId: "x-1",
    upToSequence: 1,
    state: { n: 1 },
    key: null,
    scope: null,
    foldVersion: "v1",
    ...over,
  });
  const open = async (ctx: TaskContext): Promise<Full> => {
    const s = factory();
    if (
      s.beginFold === undefined ||
      s.applyFolded === undefined ||
      s.getFolded === undefined ||
      s.getFoldedByKey === undefined ||
      s.purgeFolded === undefined
    ) {
      return ctx.skip() as never;
    }
    await s.beginFold("m", "v1");
    return s as Full;
  };

  describe(`${label} conformance (folded state, ADR 0132)`, () => {
    it("beginFold: first/same version rebuild nothing; a new version drops only that model's states", async (ctx) => {
      const s = await open(ctx);
      expect(await s.beginFold("m", "v1")).toEqual({ rebuilt: false });
      await s.applyFolded(ap());
      expect(await s.beginFold("m", "v1")).toEqual({ rebuilt: false });
      expect(await s.getFolded("m", ["x-1"])).toHaveLength(1);
      await s.beginFold("other", "v1");
      await s.applyFolded(ap({ modelId: "other" }));
      expect(await s.beginFold("m", "v2")).toEqual({ rebuilt: true });
      expect(await s.getFolded("m", ["x-1"])).toEqual([]);
      expect(await s.getFolded("other", ["x-1"])).toHaveLength(1);
    });

    it("round-trips nested JSON state with key and scope; absent executions are omitted", async (ctx) => {
      const s = await open(ctx);
      const state = { status: "running", nested: { a: [1, null, "z"] } };
      expect(await s.applyFolded(ap({ key: "d1", scope: "u1", state }))).toBe("applied");
      expect(await s.getFolded("m", ["x-1", "missing"])).toEqual([
        { executionId: "x-1", key: "d1", scope: "u1", sequence: 1, state, erased: false },
      ]);
    });

    it("the watermark is monotonic: lower and equal sequences are stale and change nothing", async (ctx) => {
      const s = await open(ctx);
      expect(await s.applyFolded(ap({ upToSequence: 5, state: { n: 5 } }))).toBe("applied");
      expect(await s.applyFolded(ap({ upToSequence: 3, state: { n: 3 } }))).toBe("stale");
      expect(await s.applyFolded(ap({ upToSequence: 5, state: { n: 99 } }))).toBe("stale");
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ sequence: 5, state: { n: 5 } });
      expect(await s.applyFolded(ap({ upToSequence: 6, state: { n: 6 } }))).toBe("applied");
    });

    it("a watermark-only write (state null) round-trips as not-erased", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap({ upToSequence: 4, state: null }));
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({
        sequence: 4,
        state: null,
        erased: false,
      });
    });

    it("a later write that omits key/scope keeps the ones already stored", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap({ key: "d1", scope: "u1" }));
      await s.applyFolded(ap({ upToSequence: 2, key: null, scope: null }));
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({
        key: "d1",
        scope: "u1",
        sequence: 2,
      });
    });

    it("refuses a writer whose fold version is not the header's, before and after a rebuild", async (ctx) => {
      const s = await open(ctx);
      expect(await s.applyFolded(ap({ foldVersion: "v0" }))).toBe("version-mismatch");
      expect(await s.getFolded("m", ["x-1"])).toEqual([]);
      await s.beginFold("m", "v2");
      expect(await s.applyFolded(ap({ foldVersion: "v1" }))).toBe("version-mismatch");
      expect(await s.applyFolded(ap({ foldVersion: "v2" }))).toBe("applied");
    });

    it("getFoldedByKey returns every execution sharing a key, ordered, isolated per model", async (ctx) => {
      const s = await open(ctx);
      await s.beginFold("other", "v1");
      await s.applyFolded(ap({ executionId: "x-2", key: "d1" }));
      await s.applyFolded(ap({ executionId: "x-1", key: "d1" }));
      await s.applyFolded(ap({ executionId: "x-3", key: "d2" }));
      await s.applyFolded(ap({ executionId: "x-4" })); // no key
      await s.applyFolded(ap({ modelId: "other", executionId: "x-9", key: "d1" }));
      const got = await s.getFoldedByKey("m", ["d1", "nope"]);
      expect(got.map((r) => r.executionId)).toEqual(["x-1", "x-2"]);
    });

    it("getFoldedByKey orders executionIds by code point, not UTF-16 code unit", async (ctx) => {
      const s = await open(ctx);
      // U+1F600 is the surrogate pair D83D DE00, so UTF-16 order puts it BEFORE U+E000.
      const ids = ["x-\u{1F600}", "x-\uE000", "x-\uFFFF", "x-a"];
      for (const executionId of ids) await s.applyFolded(ap({ executionId, key: "d1" }));
      const got = await s.getFoldedByKey("m", ["d1"]);
      expect(got.map((r) => r.executionId)).toEqual(["x-a", "x-\uE000", "x-\uFFFF", "x-\u{1F600}"]);
    });

    it("purgeFolded tombstones: state gone, sequence kept, later writes advance but never resurrect", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap({ key: "d1", scope: "u1", upToSequence: 3 }));
      expect(await s.purgeFolded("m", { executionId: "x-1" })).toBe(1);
      expect(await s.purgeFolded("m", { executionId: "x-1" })).toBe(0); // retry finds nothing new
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({
        state: null,
        erased: true,
        sequence: 3,
      });
      expect(await s.applyFolded(ap({ upToSequence: 2, state: { n: 2 } }))).toBe("stale");
      expect(await s.applyFolded(ap({ upToSequence: 3, state: { n: 3 } }))).toBe("stale");
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ erased: true, sequence: 3 });
      expect(await s.applyFolded(ap({ upToSequence: 7, state: { n: 7 } }))).toBe("applied-erased");
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({
        state: null,
        erased: true,
        sequence: 7,
      });
    });

    it("purgeFolded by key and by scope touches only matches, in that model only", async (ctx) => {
      const s = await open(ctx);
      await s.beginFold("other", "v1");
      await s.applyFolded(ap({ executionId: "x-1", key: "d1", scope: "u1" }));
      await s.applyFolded(ap({ executionId: "x-2", key: "d2", scope: "u1" }));
      await s.applyFolded(ap({ executionId: "x-3", key: "d3", scope: "u2" }));
      await s.applyFolded(ap({ modelId: "other", executionId: "x-1", key: "d1", scope: "u1" }));
      expect(await s.purgeFolded("m", { key: "d1" })).toBe(1);
      expect(await s.purgeFolded("m", { scope: "u1" })).toBe(1); // x-2 only; x-1 already erased
      const left = await s.getFolded("m", ["x-1", "x-2", "x-3"]);
      expect(left.filter((r) => !r.erased).map((r) => r.executionId)).toEqual(["x-3"]);
      expect((await s.getFolded("other", ["x-1"]))[0]?.erased).toBe(false);
    });

    it("a state written in JSONB key order (length, then bytes) reads back with the same key order", async (ctx) => {
      const s = await open(ctx);
      const state = { a: 1, c: { y: 1, zz: 2, aaa: 3 }, bb: [{ p: 1, q: 2 }] };
      await s.applyFolded(ap({ state }));
      const got = (await s.getFolded("m", ["x-1"]))[0]?.state as typeof state;
      expect(JSON.stringify(got)).toBe(JSON.stringify(state));
    });

    it("purgeFolded refuses an empty, blank, multi-field or non-string selector and tombstones nothing", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap({ key: "d1", scope: "u1" }));
      for (const bad of [{}, { key: " " }, { key: "d1", scope: "u1" }, { executionId: 7 }]) {
        await expect(s.purgeFolded("m", bad as never)).rejects.toThrow(TypeError);
      }
      expect((await s.getFolded("m", ["x-1"]))[0]?.erased).toBe(false);
    });

    it("clear drops states AND the header: writers are refused until beginFold runs again", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap());
      await s.beginFold("other", "v1");
      await s.applyFolded(ap({ modelId: "other" }));
      await s.clear("m");
      expect(await s.getFolded("m", ["x-1"])).toEqual([]);
      expect(await s.getFolded("other", ["x-1"])).toHaveLength(1);
      expect(await s.applyFolded(ap({ modelId: "other", upToSequence: 2 }))).toBe("applied");
      expect(await s.applyFolded(ap())).toBe("version-mismatch");
      await s.beginFold("m", "v1");
      expect(await s.applyFolded(ap())).toBe("applied");
    });

    it("batch reads: empty is empty; more than 1000 keys is refused", async (ctx) => {
      const s = await open(ctx);
      expect(await s.getFolded("m", [])).toEqual([]);
      const many = Array.from({ length: 1001 }, (_, i) => `x-${i}`);
      await expect(s.getFolded("m", many.slice(0, 1000))).resolves.toEqual([]);
      await expect(s.getFoldedByKey("m", many.slice(0, 1000))).resolves.toEqual([]);
      await expect(s.getFolded("m", many)).rejects.toThrow();
      await expect(s.getFoldedByKey("m", many)).rejects.toThrow();
    });

    it("concurrent applies converge on the highest sequence regardless of arrival order", async (ctx) => {
      const s = await open(ctx);
      const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
      const shuffled = [
        ...seqs.filter((n) => n % 2 === 0).reverse(),
        ...seqs.filter((n) => n % 2 === 1),
      ];
      await Promise.all(shuffled.map((n) => s.applyFolded(ap({ upToSequence: n, state: { n } }))));
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({
        sequence: 20,
        state: { n: 20 },
      });
    });
  });
}
