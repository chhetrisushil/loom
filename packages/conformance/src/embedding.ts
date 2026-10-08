import { describe, expect, it } from "vitest";

// ── Conformance kits for the embedding seam (R18, ADR 0124) ─────────────────────────────────
//
// `EmbeddingProvider` and `VectorIndex` are declared STRUCTURALLY here (as the other kits do) so
// this package does not depend on `@loom/memory`: TypeScript matches by shape, so a real
// implementation satisfies them without an import, and a third-party provider can run the kit with
// no dependency on loom beyond this package.

export interface EmbeddingProviderLike {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize?: number;
  embed(texts: readonly string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;
}

export interface VectorIndexLike {
  readonly modelId?: string;
  readonly dimensions: number;
  add(key: string, id: string, vector: readonly number[]): void | Promise<void>;
  remove(key: string, ids: readonly string[]): void | Promise<void>;
  clear(key: string): void | Promise<void>;
  search(
    key: string,
    query: readonly number[],
    limit: number,
    minScore: number
  ): { id: string; score: number }[] | Promise<{ id: string; score: number }[]>;
  size(key: string): number | Promise<number>;
}

const close = (a: readonly number[], b: readonly number[], eps = 1e-5): boolean =>
  a.length === b.length && a.every((x, i) => Math.abs(x - (b[i] as number)) <= eps);

/**
 * Pins the `EmbeddingProvider` contract: shape (one finite vector of `dimensions` per text, in
 * order), determinism (the same text embeds the same, whatever it is batched with), a stable
 * non-empty `modelId`, no failure on the awkward inputs a corpus really contains (empty string,
 * punctuation only, non-Latin, very long), and non-degeneracy (different texts are not all the
 * same vector). What it cannot pin is QUALITY - whether paraphrases land close - which is a
 * property of the model, evaluated against your own data.
 */
export function runEmbeddingProviderConformance(
  factory: () => EmbeddingProviderLike,
  label = "EmbeddingProvider"
): void {
  describe(`${label} conformance (EmbeddingProvider SPI)`, () => {
    it("declares a non-empty, stable modelId and a positive integer dimensions", () => {
      const p = factory();
      expect(typeof p.modelId).toBe("string");
      expect(p.modelId.length).toBeGreaterThan(0);
      expect(factory().modelId).toBe(p.modelId);
      expect(Number.isInteger(p.dimensions)).toBe(true);
      expect(p.dimensions).toBeGreaterThan(0);
    });

    it("returns one finite vector of `dimensions` per text, in order", async () => {
      const p = factory();
      const texts = ["alpha beta", "gamma", "delta epsilon zeta"];
      const out = await p.embed(texts);
      expect(out).toHaveLength(texts.length);
      for (const v of out) {
        expect(v).toHaveLength(p.dimensions);
        expect(v.every(Number.isFinite)).toBe(true);
      }
    });

    it("embeds nothing to nothing", async () => {
      expect(await factory().embed([])).toEqual([]);
    });

    it("is deterministic and independent of batch composition", async () => {
      const p = factory();
      const [a1, b1] = await p.embed(["the quick brown fox", "lazy dogs sleep"]);
      const [a2] = await p.embed(["the quick brown fox"]);
      const [b3, a3] = await p.embed(["lazy dogs sleep", "the quick brown fox"]);
      expect(close(a1 as number[], a2 as number[])).toBe(true);
      expect(close(a1 as number[], a3 as number[])).toBe(true);
      expect(close(b1 as number[], b3 as number[])).toBe(true);
    });

    it("is not degenerate: different texts do not all embed to the same vector", async () => {
      const p = factory();
      const out = await p.embed([
        "invoices and billing",
        "kubernetes pod scheduling",
        "sourdough starter hydration",
      ]);
      const same =
        close(out[0] as number[], out[1] as number[]) &&
        close(out[1] as number[], out[2] as number[]);
      expect(same).toBe(false);
    });

    it("survives awkward input without non-finite output", async () => {
      const p = factory();
      const out = await p.embed([
        "",
        "   ",
        "!!!???",
        "χρήση βάσης δεδομένων",
        "日本語のテキスト",
        "x ".repeat(5000),
      ]);
      expect(out).toHaveLength(6);
      for (const v of out) {
        expect(v).toHaveLength(p.dimensions);
        expect(v.every(Number.isFinite)).toBe(true);
      }
    });

    it("honours an already-aborted signal", async () => {
      const p = factory();
      const c = new AbortController();
      c.abort();
      // A provider may ignore a signal it cannot cancel, but it must never return garbage.
      const r = await p.embed(["x"], { signal: c.signal }).then(
        (v) => v,
        () => "rejected" as const
      );
      if (r !== "rejected") {
        expect(r).toHaveLength(1);
        expect((r[0] as number[]).every(Number.isFinite)).toBe(true);
      }
    });
  });
}

/**
 * Pins the `VectorIndex` contract: nearest-first ranking, a hard relevance floor, a limit, key
 * isolation (a hit NEVER comes from another key), remove/clear/size bookkeeping, re-adding an id
 * replaces its vector, and refusal of a wrong-dimension or non-finite vector.
 */
export function runVectorIndexConformance(
  factory: () => VectorIndexLike,
  label = "VectorIndex"
): void {
  const basis = (dims: number, i: number, scale = 1): number[] => {
    const v = new Array<number>(dims).fill(0);
    v[i % dims] = scale;
    return v;
  };

  describe(`${label} conformance (VectorIndex SPI)`, () => {
    it("ranks nearest first and breaks ties by insertion order", async () => {
      const ix = factory();
      const d = ix.dimensions;
      if (d < 3) return;
      await ix.add("k", "x", basis(d, 0));
      const near = basis(d, 0);
      near[1] = 0.1;
      await ix.add("k", "near", near);
      await ix.add("k", "y", basis(d, 1));
      await ix.add("k", "x2", basis(d, 0)); // ties with x
      const hits = await ix.search("k", basis(d, 0), 10, -1);
      expect(hits.map((h) => h.id).slice(0, 2)).toEqual(["x", "x2"]);
      expect(hits[2]?.id).toBe("near");
      expect(hits.at(-1)?.id).toBe("y");
      for (let i = 1; i < hits.length; i++) {
        expect((hits[i - 1] as { score: number }).score).toBeGreaterThanOrEqual(
          (hits[i] as { score: number }).score
        );
      }
    });

    it("applies the floor and the limit", async () => {
      const ix = factory();
      const d = ix.dimensions;
      if (d < 2) return;
      await ix.add("k", "a", basis(d, 0));
      await ix.add("k", "b", basis(d, 1));
      expect((await ix.search("k", basis(d, 0), 10, 0.5)).map((h) => h.id)).toEqual(["a"]);
      expect(await ix.search("k", basis(d, 0), 0, -1)).toEqual([]);
      expect(await ix.search("k", basis(d, 0), 1, -1)).toHaveLength(1);
    });

    it("never returns another key's ids", async () => {
      const ix = factory();
      const d = ix.dimensions;
      await ix.add("tenant-a", "secret", basis(d, 0));
      await ix.add("tenant-b", "mine", basis(d, 0));
      expect((await ix.search("tenant-b", basis(d, 0), 10, -1)).map((h) => h.id)).toEqual(["mine"]);
      expect(await ix.search("tenant-c", basis(d, 0), 10, -1)).toEqual([]);
    });

    it("remove and clear drop entries and size tracks them", async () => {
      const ix = factory();
      const d = ix.dimensions;
      await ix.add("k", "a", basis(d, 0));
      await ix.add("k", "b", basis(d, 0));
      expect(await ix.size("k")).toBe(2);
      await ix.remove("k", ["a", "never-added"]);
      expect(await ix.size("k")).toBe(1);
      expect((await ix.search("k", basis(d, 0), 10, -1)).map((h) => h.id)).toEqual(["b"]);
      await ix.clear("k");
      expect(await ix.size("k")).toBe(0);
      expect(await ix.search("k", basis(d, 0), 10, -1)).toEqual([]);
      await ix.remove("absent", ["a"]); // no throw
    });

    it("re-adding an id replaces its vector instead of duplicating it", async () => {
      const ix = factory();
      const d = ix.dimensions;
      if (d < 2) return;
      await ix.add("k", "a", basis(d, 0));
      await ix.add("k", "a", basis(d, 1));
      expect(await ix.size("k")).toBe(1);
      expect((await ix.search("k", basis(d, 1), 10, 0.9)).map((h) => h.id)).toEqual(["a"]);
      expect(await ix.search("k", basis(d, 0), 10, 0.9)).toEqual([]);
    });

    it("refuses a wrong-dimension or non-finite vector (at add and at search)", async () => {
      const ix = factory();
      const d = ix.dimensions;
      const rejects = async (f: () => unknown): Promise<boolean> => {
        try {
          await f();
          return false;
        } catch {
          return true;
        }
      };
      expect(await rejects(() => ix.add("k", "a", new Array(d + 1).fill(1)))).toBe(true);
      expect(
        await rejects(() =>
          ix.add(
            "k",
            "a",
            basis(d, 0).map(() => Number.NaN)
          )
        )
      ).toBe(true);
      await ix.add("k", "ok", basis(d, 0));
      expect(await rejects(() => ix.search("k", new Array(d + 1).fill(1), 5, -1))).toBe(true);
    });
  });
}
