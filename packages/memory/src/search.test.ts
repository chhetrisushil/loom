import { tainted } from "@loom/classify";
import { memory$ } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";
import { MemoryRuntime } from "./MemoryRuntime";
import { TieredMemory } from "./TieredMemory";
import { MAX_QUERY_TERMS, queryTerms, searchableText, tokenize } from "./searchText";
import type { MemoryEntry, MemoryStore } from "./types";

describe("searchableText", () => {
  it("projects string and number leaves of `content`, not its keys", () => {
    const text = searchableText({
      content: { latency: "spiked", rows: [{ note: "deadlock" }, 500], ok: false, none: null },
      timestamp: 1,
    });
    expect(text).toContain("spiked");
    expect(text).toContain("deadlock");
    expect(text).toContain("500");
    // Keys are schema. Indexing them makes "latency" match a record that merely HAS a
    // latency field and says nothing about latency.
    expect(text).not.toContain("latency");
    expect(text).not.toContain("rows");
  });

  it("survives content no shallower than JSON itself accepts", () => {
    // The invariant, not a depth: indexing must never fail on content the store's own
    // serializer accepts, because every durable backend writes `JSON.stringify(entry)`
    // and `searchableText(entry)` in the same call.
    //
    // CALIBRATED AT RUNTIME rather than pinned to a number. Both limits are the same call
    // stack, so where they sit depends on the host — a hard-coded depth passed here and
    // failed on CI, where JSON.stringify gives out sooner. Probe for the deepest structure
    // JSON accepts, then require the index to accept it too.
    const nest = (depth: number): unknown => {
      let value: unknown = "needle";
      for (let i = 0; i < depth; i++) value = { nested: value };
      return value;
    };
    const serializable = (depth: number): boolean => {
      try {
        JSON.stringify(nest(depth));
        return true;
      } catch {
        return false;
      }
    };
    // Binary-search JSON's actual ceiling. A coarse ladder is not enough: the test only
    // discriminates near that ceiling, where the recursive walk's larger frames give out
    // and JSON's do not, so landing well below it would pass against the old code too.
    let low = 1;
    let high = 1;
    while (serializable(high) && high < 1_000_000) high *= 2;
    low = Math.floor(high / 2);
    while (high - low > 64) {
      const mid = Math.floor((low + high) / 2);
      if (serializable(mid)) low = mid;
      else high = mid;
    }
    const deepest = low;
    expect(deepest).toBeGreaterThan(512); // above MAX_DEPTH, so the walk is exercised
    expect(serializable(deepest)).toBe(true); // the premise, on THIS host
    expect(() => searchableText({ content: nest(deepest), timestamp: 1 })).not.toThrow();
  });

  it("terminates on cyclic content instead of recursing forever", () => {
    // The in-memory store keeps the object by reference, so a cycle is accepted at
    // `append` and only detonates later, inside an unrelated `search`.
    const cyclic: Record<string, unknown> = { note: "replica lag" };
    cyclic.self = cyclic;
    const text = searchableText({ content: cyclic, timestamp: 1 });
    expect(text).toContain("replica lag");
  });

  it("indexes deep content as far as the cap, rather than refusing it", () => {
    // Degrade, do not reject: an index that throws makes legal content unstorable.
    let deep: unknown = "buried";
    for (let i = 0; i < 5_000; i++) deep = { nested: deep };
    const text = searchableText({ content: { top: "surface", deep }, timestamp: 1 });
    expect(text).toContain("surface"); // what is above the cap is still findable
    expect(text).not.toContain("buried"); // what is below it is not
  });

  it("excludes role and timestamp — metadata is not content", () => {
    expect(searchableText({ role: "assistant", content: "hello", timestamp: 1234 })).toBe("hello");
  });

  it("indexes a tainted value's content, not its origin label", () => {
    // An ingested corpus taints EVERY entry (ADR 0085), so an indexed origin makes
    // one term match the whole corpus — on an FTS backend that widens the match set,
    // not just the ranking. Provenance is metadata by the same rule that drops `role`.
    const text = searchableText({
      content: tainted("replica lag runbook", "mcp:wiki"),
      timestamp: 1,
    });
    expect(text).toBe("replica lag runbook");
    expect(text).not.toContain("mcp");
  });

  it("reaches a tainted value nested inside structured content", () => {
    const text = searchableText({
      content: { docId: "RB-204", text: tainted("pool saturated", "runbook:RB-204") },
      timestamp: 1,
    });
    expect(text).toContain("RB-204");
    expect(text).toContain("pool saturated");
    expect(text).not.toContain("runbook:");
  });
});

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and keeps non-Latin letters", () => {
    expect(tokenize("Replica-lag: 500ms!")).toEqual(["replica", "lag", "500ms"]);
    expect(tokenize("χ ψ")).toEqual(["χ", "ψ"]);
    expect(tokenize("  ?! ")).toEqual([]);
  });
});

describe("MemoryRuntime.search", () => {
  const facts = memory$({ id: "facts", name: "facts" });

  it("refuses loudly on a store that cannot search, rather than degrading to `read`", async () => {
    // The whole point of the verb: a fallback to the tail of the scope would look like
    // retrieval, return plausible entries, and be undetectable downstream.
    const blind: MemoryStore = {
      async append() {},
      async read(): Promise<MemoryEntry[]> {
        return [];
      },
      async clear() {},
    };
    const runtime = new MemoryRuntime(blind).register(facts);
    await expect(runtime.search("facts", "s", "anything")).rejects.toThrow(
      /does not implement search/
    );
  });

  it("finds entries by relevance within one (memoryId, scope)", async () => {
    const runtime = new MemoryRuntime(new InMemoryMemoryStore()).register(facts);
    await runtime.append("facts", "s", { content: "the orders table has a bloated index" });
    await runtime.append("facts", "s", { content: "the vacuum job runs nightly" });
    await runtime.append("facts", "other", { content: "bloated index elsewhere" });

    const hits = await runtime.search("facts", "s", "index bloat");
    expect(hits.map((e) => e.content)).toEqual(["the orders table has a bloated index"]);
  });

  it("drops expired hits, because an expired entry reaching a prompt is what ttlMs prevents", async () => {
    // Eviction is lazy: a scope written and then left alone keeps its expired entries
    // until the next read/append. `read` prunes them on the way out, and `search` has to
    // as well — otherwise the one path that skips the list is the one that leaks stale
    // context into a prompt.
    const expiring = memory$({ id: "recent", name: "recent", ttlMs: 60_000 });
    const store = new InMemoryMemoryStore();
    const runtime = new MemoryRuntime(store).register(expiring);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      await runtime.append("recent", "s", { content: "stale alert" });
      vi.setSystemTime(1_000_000 + 120_000); // no write since, so nothing has pruned it

      expect(await runtime.search("recent", "s", "alert")).toEqual([]);
      // …and it is still THERE: a search sees an arbitrary subset of the scope, so it
      // must never write its view back the way `read` does — that would delete every
      // entry the query did not match.
      expect(await store.read("recent::s")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TieredMemory.recallRelevant", () => {
  const tiered = (): TieredMemory => new TieredMemory({ tiers: { semantic: {} } });

  it("records the retrieved set, and a replay is served that set unchanged", async () => {
    const mem = tiered();
    await mem.remember("semantic", "s", { content: "checkpoint tuning notes" });

    const log = new Map<string, unknown>();
    const record = async <T>(id: string, decider: () => T | Promise<T>): Promise<T> => {
      const value = await decider();
      log.set(id, value);
      return value;
    };
    const replay = async <T>(id: string): Promise<T> => log.get(id) as T;

    const first = await mem.recallRelevant("semantic", "s", "checkpoint", { decide: record });
    expect(first.map((e) => e.content)).toEqual(["checkpoint tuning notes"]);

    // The corpus moves on — a semantic tier never evicts, so this is the normal case,
    // and re-running the query live would now rank a different set into the prompt.
    await mem.remember("semantic", "s", { content: "checkpoint spike during backup" });

    const replayed = await mem.recallRelevant("semantic", "s", "checkpoint", { decide: replay });
    expect(replayed.map((e) => e.content)).toEqual(["checkpoint tuning notes"]);
    // Live, both match.
    expect(
      (await mem.recallRelevant("semantic", "s", "checkpoint", { decide: record })).length
    ).toBe(2);
  });

  it("rejects an unknown tier", async () => {
    await expect(
      tiered().recallRelevant("nope", "s", "q", { decide: async (_, f) => f() })
    ).rejects.toThrow(/Unknown memory tier/);
  });

  it("honours limit", async () => {
    const mem = tiered();
    for (let i = 0; i < 5; i++) await mem.remember("semantic", "s", { content: `alert ${i}` });
    const hits = await mem.recallRelevant("semantic", "s", "alert", {
      limit: 2,
      decide: async (_, f) => f(),
    });
    expect(hits).toHaveLength(2);
  });
});

// ── The query is an input, and an input has a bound (audit 2026-09-10) ────────
//
// Terms are OR-ed, so a repeated term cannot change WHICH entries match — only how long a
// store takes to say so. Before `queryTerms`, one word repeated 20,000 times built a
// 20,000-clause FTS5 MATCH and took SQLite 32.7 seconds: a denial of service bought from a
// text box. Distinct terms cost linearly, so the cap bounds the other half.

describe("queryTerms", () => {
  it("deduplicates, keeping the order the asker led with", () => {
    expect(queryTerms("latency spend latency rollout spend")).toEqual([
      "latency",
      "spend",
      "rollout",
    ]);
  });

  it("caps the number of distinct terms", () => {
    const query = Array.from({ length: MAX_QUERY_TERMS + 50 }, (_, i) => `term${i}`).join(" ");
    const terms = queryTerms(query);
    expect(terms).toHaveLength(MAX_QUERY_TERMS);
    // Kept from the front: the terms a question leads with are the ones it is about.
    expect(terms[0]).toBe("term0");
    expect(terms).not.toContain(`term${MAX_QUERY_TERMS + 10}`);
  });

  it("collapses a repeated term to one, however many times it appears", () => {
    expect(queryTerms(Array.from({ length: 20_000 }, () => "latency").join(" "))).toEqual([
      "latency",
    ]);
  });

  it("is empty for a query with no terms", () => {
    expect(queryTerms("   ---   ")).toEqual([]);
  });
});

describe("search is bounded by the same terms", () => {
  it("does not match on a term past the cap", async () => {
    // The behavioural half: a store that ignored the cap would return `beyond` too.
    const store = new InMemoryMemoryStore();
    await store.append("k", { content: { text: "term0 only" }, timestamp: 1 });
    await store.append("k", {
      content: { text: `term${MAX_QUERY_TERMS + 10} only` },
      timestamp: 2,
    });

    const query = Array.from({ length: MAX_QUERY_TERMS + 50 }, (_, i) => `term${i}`).join(" ");
    const hits = await store.search("k", query, { limit: 10 });

    expect(hits).toHaveLength(1);
    expect(JSON.stringify(hits[0]?.content)).toContain("term0");
  });

  it("answers a query repeating one term exactly as it answers the term", async () => {
    const store = new InMemoryMemoryStore();
    await store.append("k", { content: { text: "latency spiked" }, timestamp: 1 });
    await store.append("k", { content: { text: "spend rose" }, timestamp: 2 });

    const once = await store.search("k", "latency", { limit: 10 });
    const many = await store.search("k", Array.from({ length: 5_000 }, () => "latency").join(" "), {
      limit: 10,
    });

    expect(many).toEqual(once);
  });
});
