import { runEmbeddingProviderConformance, runVectorIndexConformance } from "@loom/conformance";
import { runMemoryStoreConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";
import { TieredMemory } from "./TieredMemory";
import {
  EMBEDDING_PROVIDER_SPI_VERSION,
  EmbeddingError,
  EmbeddingMemoryStore,
  EmbeddingModelMismatchError,
  type EmbeddingProvider,
  HashingEmbeddingProvider,
  InMemoryVectorIndex,
  MemoryIndexTooLargeError,
  cosine,
} from "./embedding";

runEmbeddingProviderConformance(
  () => new HashingEmbeddingProvider({ dimensions: 128 }),
  "HashingEmbeddingProvider"
);
runVectorIndexConformance(() => new InMemoryVectorIndex({ dimensions: 8 }), "InMemoryVectorIndex");
// The semantic store is still a MemoryStore: the same kit every backend passes, floor included.
runMemoryStoreConformance(
  () =>
    new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: new HashingEmbeddingProvider({ dimensions: 512 }),
      minScore: 0.2,
    }),
  "EmbeddingMemoryStore(hashing)"
);

const entry = (content: string, id?: string, timestamp = 1) => ({
  content,
  timestamp,
  ...(id !== undefined && { id }),
});

/** Counts calls so tests can pin WHEN the model is consulted. */
function counting(inner: EmbeddingProvider) {
  const calls: string[][] = [];
  const p: EmbeddingProvider = {
    modelId: inner.modelId,
    dimensions: inner.dimensions,
    maxBatchSize: 4,
    async embed(texts, opts) {
      calls.push([...texts]);
      return inner.embed(texts, opts);
    },
  };
  return { p, calls };
}

describe("embedding seam (R18)", () => {
  it("declares its SPI version", () => {
    expect(EMBEDDING_PROVIDER_SPI_VERSION).toBe("1.0.0");
  });

  it("the hashing embedder is deterministic and ranks lexical neighbours above strangers", async () => {
    const e = new HashingEmbeddingProvider();
    const [q, near, far] = await e.embed([
      "postgres replication lag",
      "replication lag on the postgres primary",
      "chocolate cake recipe",
    ]);
    expect(cosine(q as number[], near as number[])).toBeGreaterThan(0.5);
    expect(cosine(q as number[], far as number[])).toBeLessThan(0.2);
    expect(new HashingEmbeddingProvider({ dimensions: 64 }).modelId).not.toBe(e.modelId);
    expect(() => new HashingEmbeddingProvider({ dimensions: 2 })).toThrow(EmbeddingError);
  });

  it("search is semantic ranking over the wrapped store, bounded by the floor", async () => {
    const store = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: new HashingEmbeddingProvider({ dimensions: 512 }),
      minScore: 0.25,
    });
    await store.append("k", entry("postgres replication lag spiked at noon", "a"));
    await store.append("k", entry("the cafeteria menu has soup", "b"));
    await store.append("k", entry("replication slots on the postgres primary", "c"));
    const hits = await store.search("k", "postgres replication");
    expect(hits.map((h) => h.id).sort()).toEqual(["a", "c"]);
    expect(await store.search("k", "quantum chromodynamics")).toEqual([]);
    expect(await store.search("k", "postgres replication", { limit: 1 })).toHaveLength(1);
    expect(await store.search("other-key", "postgres replication")).toEqual([]);
  });

  it("embeds lazily on first search, in batches, and incrementally after that", async () => {
    const { p, calls } = counting(new HashingEmbeddingProvider({ dimensions: 128 }));
    const inner = new InMemoryMemoryStore();
    for (let i = 0; i < 10; i++)
      await inner.append("k", entry(`doc number ${i} about topic${i}`, `d${i}`));
    const store = new EmbeddingMemoryStore({ store: inner, provider: p, minScore: 0.1 });
    expect(calls).toHaveLength(0); // construction and plain reads never touch the model
    await store.read("k");
    expect(calls).toHaveLength(0);
    await store.search("k", "topic3");
    expect(calls.map((c) => c.length)).toEqual([4, 4, 2, 1]); // 10 docs in batches of 4, then the query
    await store.append("k", entry("fresh note about topic99", "n"));
    expect(calls.at(-1)).toEqual(["fresh note about topic99"]);
    expect((await store.search("k", "topic99")).map((h) => h.id)).toContain("n");
  });

  it("never returns an entry the store no longer holds, and remove/clear/replace update recall", async () => {
    const inner = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({
      store: inner,
      provider: new HashingEmbeddingProvider({ dimensions: 512 }),
      minScore: 0.2,
    });
    await store.append("k", entry("alpha bravo charlie", "1"));
    await store.append("k", entry("alpha bravo delta", "2"));
    expect((await store.search("k", "alpha bravo")).map((h) => h.id).sort()).toEqual(["1", "2"]);
    // deleted behind the index's back (a different writer): still never returned
    await inner.remove("k", ["1"]);
    expect((await store.search("k", "alpha bravo")).map((h) => h.id)).toEqual(["2"]);
    await store.remove("k", ["2"]);
    expect(await store.search("k", "alpha bravo")).toEqual([]);
    await store.replace("k", [entry("echo foxtrot", "3")]);
    expect(await store.search("k", "alpha bravo")).toEqual([]);
    expect((await store.search("k", "echo foxtrot")).map((h) => h.id)).toEqual(["3"]);
    await store.clear("k");
    expect(await store.search("k", "echo foxtrot")).toEqual([]);
  });

  it("entries without an id are indexed by content and round-trip unchanged", async () => {
    const store = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: new HashingEmbeddingProvider({ dimensions: 512 }),
      minScore: 0.2,
    });
    const e = entry("no identity here but searchable");
    await store.append("k", e);
    const [hit] = await store.search("k", "searchable identity");
    expect(hit).toEqual(e);
    expect(hit).not.toHaveProperty("id");
  });

  it("a failed embedding on an indexed key refuses the append rather than diverging", async () => {
    let down = false;
    const flaky: EmbeddingProvider = {
      ...new HashingEmbeddingProvider({ dimensions: 64 }),
      modelId: "flaky/1",
      dimensions: 64,
      async embed(texts) {
        if (down) throw new Error("model down");
        return new HashingEmbeddingProvider({ dimensions: 64 }).embed(texts);
      },
    };
    const inner = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({ store: inner, provider: flaky, minScore: 0.1 });
    await store.append("k", entry("one", "1"));
    await store.search("k", "one"); // hydrate
    down = true;
    await expect(store.append("k", entry("two", "2"))).rejects.toThrow(/model down/);
    expect((await inner.read("k")).map((e) => e.id)).toEqual(["1"]); // nothing half-written
  });

  it("refuses a model/dimension mismatch and a too-large scope, and requires a sane floor", async () => {
    const provider = new HashingEmbeddingProvider({ dimensions: 64 });
    expect(
      () =>
        new EmbeddingMemoryStore({
          store: new InMemoryMemoryStore(),
          provider,
          minScore: 0.1,
          index: new InMemoryVectorIndex({ dimensions: 32 }),
        })
    ).toThrow(EmbeddingModelMismatchError);
    expect(
      () =>
        new EmbeddingMemoryStore({
          store: new InMemoryMemoryStore(),
          provider,
          minScore: 0.1,
          index: new InMemoryVectorIndex({ dimensions: 64, modelId: "some-other-model" }),
        })
    ).toThrow(EmbeddingModelMismatchError);
    expect(
      () => new EmbeddingMemoryStore({ store: new InMemoryMemoryStore(), provider, minScore: 2 })
    ).toThrow(/minScore/);

    const inner = new InMemoryMemoryStore();
    for (let i = 0; i < 5; i++) await inner.append("k", entry(`doc ${i}`, `d${i}`));
    const small = new EmbeddingMemoryStore({
      store: inner,
      provider,
      minScore: 0.1,
      maxEntriesPerKey: 3,
    });
    await expect(small.search("k", "doc")).rejects.toThrow(MemoryIndexTooLargeError);
  });

  it("a provider returning the wrong number or shape of vectors is refused", async () => {
    const bad: EmbeddingProvider = {
      modelId: "bad/1",
      dimensions: 4,
      embed: async (texts) => texts.slice(1).map(() => [1, 0, 0, 0]),
    };
    const store = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: bad,
      minScore: 0,
    });
    await store.append("k", entry("x y z", "1"));
    await expect(store.search("k", "x")).rejects.toThrow(/returned 0 vectors for 1 texts/);
    const short: EmbeddingProvider = {
      modelId: "s/1",
      dimensions: 4,
      embed: async (t) => t.map(() => [1, 0]),
    };
    const s2 = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: short,
      minScore: 0,
    });
    await s2.append("k", entry("x y z", "1"));
    await expect(s2.search("k", "x")).rejects.toThrow(/expected 4 dimensions/);
  });

  it("works under TieredMemory.recallRelevant, which records what came back (replay safety)", async () => {
    const { p, calls } = counting(new HashingEmbeddingProvider({ dimensions: 512 }));
    const semantic = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: p,
      minScore: 0.2,
    });
    const mem = new TieredMemory({ tiers: { semantic: {} }, store: semantic });
    await mem.remember("semantic", "s", { content: "postgres replication lag runbook", id: "r1" });
    await mem.remember("semantic", "s", { content: "office snacks policy", id: "r2" });
    const recorded = new Map<string, unknown>();
    const decide = async <T>(id: string, fn: () => T | Promise<T>): Promise<T> => {
      if (recorded.has(id)) return recorded.get(id) as T;
      const v = await fn();
      recorded.set(id, v);
      return v;
    };
    const first = await mem.recallRelevant("semantic", "s", "postgres lag", {
      decide,
      decisionKey: "q",
    });
    expect(first.map((e) => e.id)).toEqual(["r1"]);
    const before = calls.length;
    // a replay serves the recorded retrieval: the model is not consulted again
    const again = await mem.recallRelevant("semantic", "s", "postgres lag", {
      decide,
      decisionKey: "q",
    });
    expect(again).toEqual(first);
    expect(calls.length).toBe(before);
  });
});
