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

describe("EmbeddingMemoryStore hardening (R18 fix round 1)", () => {
  const E = (id: string, content: string) => ({ id, role: "user", content, timestamp: 1 });

  it("an append racing the first search's hydration is still searchable (store that returns copies)", async () => {
    const raw = new InMemoryMemoryStore();
    await raw.append("k", E("a", "alpha bravo"));
    const inner = {
      read: async (k: string) => structuredClone(await raw.read(k)),
      append: async (k: string, e: Parameters<typeof raw.append>[1]) => {
        await new Promise((r) => setImmediate(r));
        return raw.append(k, e);
      },
      clear: (k: string) => raw.clear(k),
    };
    const s = new EmbeddingMemoryStore({
      store: inner,
      provider: new HashingEmbeddingProvider({ dimensions: 256 }),
      minScore: 0.2,
    });
    const pA = s.append("k", E("z", "zebra quokka"));
    const pS = s.search("k", "alpha");
    await Promise.all([pA, pS]);
    expect((await s.read("k")).map((e) => e.id)).toContain("z");
    expect((await s.search("k", "zebra quokka")).map((e) => e.id)).toEqual(["z"]);
  });

  it("a zero-vector entry is skipped and counted, not a failure of every search on its key", async () => {
    const base = new HashingEmbeddingProvider({ dimensions: 64 });
    const provider: EmbeddingProvider = {
      modelId: "zeroes-on-empty",
      dimensions: 64,
      async embed(texts) {
        const v = await base.embed(texts);
        return v.map((x, i) => ((texts[i] ?? "").trim() === "" ? new Array(64).fill(0) : x));
      },
    };
    const inner = new InMemoryMemoryStore();
    await inner.append("k", E("a", "alpha"));
    await inner.append("k", E("b", "   "));
    const s = new EmbeddingMemoryStore({ store: inner, provider, minScore: 0.2 });
    expect((await s.search("k", "alpha")).map((e) => e.id)).toEqual(["a"]);
    expect(s.skippedZeroVectors).toBe(1);
    await s.append("k", E("c", "  "));
    expect(s.skippedZeroVectors).toBe(2);
  });

  it("the query is bounded before it reaches the provider", async () => {
    let longest = 0;
    const base = new HashingEmbeddingProvider({ dimensions: 64 });
    const provider: EmbeddingProvider = {
      modelId: "spy",
      dimensions: 64,
      async embed(texts) {
        for (const t of texts) longest = Math.max(longest, t.length);
        return base.embed(texts);
      },
    };
    const inner = new InMemoryMemoryStore();
    await inner.append("k", E("a", "alpha"));
    const s = new EmbeddingMemoryStore({ store: inner, provider, minScore: 0.2 });
    await s.search("k", "alpha ".repeat(500_000));
    expect(longest).toBeLessThanOrEqual(8192);
    const small = new EmbeddingMemoryStore({
      store: inner,
      provider,
      minScore: 0.2,
      maxQueryChars: 100,
    });
    longest = 0;
    await small.search("k", "alpha ".repeat(1000));
    expect(longest).toBeLessThanOrEqual(100);
  });

  it("replace on a hydrated key is incremental: only new entries are embedded", async () => {
    const { p, calls } = counting(new HashingEmbeddingProvider({ dimensions: 1024 }));
    const s = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: p,
      minScore: 0.3,
    });
    for (let i = 0; i < 6; i++) await s.append("k", E(`d${i}`, `doc ${i} about topic${i}`));
    await s.search("k", "topic1"); // hydrate
    calls.length = 0;
    // eviction rewrites the list: drop the first two, add one
    const kept = (await s.read("k")).slice(2);
    await s.replace("k", [...kept, E("n", "brand new note about topic77")]);
    expect(calls.flat()).toEqual(["brand new note about topic77"]);
    expect((await s.search("k", "topic77")).map((e) => e.id)).toEqual(["n"]);
    expect(await s.search("k", "topic0")).toEqual([]); // the evicted entry is gone from the index too
    expect((await s.search("k", "topic3")).map((e) => e.id)).toContain("d3");
  });

  it("replace on a hydrated key re-embeds an entry whose text changed under the same id", async () => {
    const s = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: new HashingEmbeddingProvider({ dimensions: 1024 }),
      minScore: 0.3,
    });
    await s.append("k", E("a", "old zulu whiskey"));
    await s.append("k", E("b", "steady note"));
    await s.search("k", "zulu"); // hydrate
    await s.replace("k", [E("a", "new yankee xray"), E("b", "steady note")]);
    expect((await s.search("k", "yankee xray")).map((e) => e.id)).toEqual(["a"]);
    expect(await s.search("k", "zulu whiskey")).toEqual([]);
  });

  it("id-less entries are hashed once per entry object, not once per search", async () => {
    const s = new EmbeddingMemoryStore({
      store: new InMemoryMemoryStore(),
      provider: new HashingEmbeddingProvider({ dimensions: 128 }),
      minScore: 0.1,
    });
    for (let i = 0; i < 20; i++) await s.append("k", { content: `note ${i} gamma`, timestamp: i });
    expect((await s.search("k", "gamma", { limit: 3 })).length).toBe(3);
    expect((await s.search("k", "note 4 gamma", { limit: 1 })).length).toBe(1);
  });
});

describe("hydration under a sustained writer (R18 fix round 2)", () => {
  const E = (id: string, content: string) => ({ id, role: "user", content, timestamp: 1 });

  it("a retry embeds only entries it has not seen: the corpus is not embedded twice", async () => {
    const base = new HashingEmbeddingProvider({ dimensions: 128 });
    let texts = 0;
    const provider: EmbeddingProvider = {
      modelId: base.modelId,
      dimensions: 128,
      maxBatchSize: 64,
      async embed(t) {
        texts += t.length;
        return base.embed(t);
      },
    };
    const raw = new InMemoryMemoryStore();
    for (let i = 0; i < 20; i++) await raw.append("k", E(`d${i}`, `doc ${i} alpha`));
    const inner = {
      // slow reads that return a snapshot taken at call time
      read: async (k: string) => {
        const snapshot = structuredClone(await raw.read(k));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        return snapshot;
      },
      append: async (k: string, e: Parameters<typeof raw.append>[1]) => {
        await new Promise((r) => setImmediate(r));
        return raw.append(k, e);
      },
      clear: (k: string) => raw.clear(k),
    };
    const s = new EmbeddingMemoryStore({ store: inner, provider, minScore: 0.2 });
    // three writes that begin while the first snapshot is being read: that attempt is stale and is redone
    const writes = [1, 2, 3].map((n) => s.append("k", E(`w${n}`, `racing ${n} beta`)));
    await Promise.all([s.search("k", "alpha"), ...writes]);
    expect((await s.search("k", "racing 2 beta")).map((e) => e.id)).toContain("w2");
    // 20 first pass + 3 racing entries on the retry + the queries; a retry that re-embedded the corpus costs 20 more
    expect(texts).toBeLessThanOrEqual(20 + 3 + 2);
  });

  it("a retry re-embeds an entry whose text changed under the same id", async () => {
    const provider = new HashingEmbeddingProvider({ dimensions: 128 });
    let reads = 0;
    const inner = {
      // the first snapshot holds d0's OLD text; every later snapshot holds it rewritten
      read: async (_k: string) => {
        reads += 1;
        const snapshot =
          reads === 1
            ? [E("d0", "old zulu whiskey")]
            : [E("d0", "new yankee xray"), E("w1", "racing tango")];
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        return snapshot;
      },
      append: async () => {
        await new Promise((r) => setImmediate(r));
      },
      clear: async () => {},
    };
    const s = new EmbeddingMemoryStore({ store: inner, provider, minScore: 0.2 });
    // a write racing the first read forces a retry, which sees d0 with new text (the append yields
    // once before it counts as a write, so it starts and ends inside the slow read)
    const pA = s.append("k", E("w1", "racing tango"));
    const pS = s.search("k", "zulu");
    await Promise.all([pA, pS]);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect((await s.search("k", "yankee xray")).map((e) => e.id)).toContain("d0");
    expect(await s.search("k", "zulu whiskey")).toEqual([]);
  });

  it("a write that starts AND finishes inside the hydration read is still searchable", async () => {
    const raw = new InMemoryMemoryStore();
    await raw.append("k", E("a", "alpha bravo"));
    const inner = {
      // a slow read that hands back a snapshot taken BEFORE the append; the append (fast) both
      // starts and completes while the read is still pending, so by the time the hydration looks no
      // write is in flight - only one that has come and gone
      read: async (k: string) => {
        const snapshot = structuredClone(await raw.read(k));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        return snapshot;
      },
      append: async (k: string, e: Parameters<typeof raw.append>[1]) => {
        await new Promise((r) => setImmediate(r)); // lands after the snapshot, before the read returns
        return raw.append(k, e);
      },
      clear: (k: string) => raw.clear(k),
    };
    const store = new EmbeddingMemoryStore({
      store: inner,
      provider: new HashingEmbeddingProvider({ dimensions: 256 }),
      minScore: 0.2,
    });
    const pA = store.append("k", E("z", "zebra quokka")); // yields once before it counts as a write
    const pS = store.search("k", "alpha");
    await Promise.all([pA, pS]);
    expect((await store.read("k")).map((e) => e.id)).toContain("z");
    expect((await store.search("k", "zebra quokka")).map((e) => e.id)).toEqual(["z"]);
  });
});
