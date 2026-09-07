import { tainted } from "@loom/classify";
import { memory$ } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";
import { MemoryRuntime } from "./MemoryRuntime";
import { TieredMemory } from "./TieredMemory";
import { searchableText, tokenize } from "./searchText";
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
    // 5,000 deep is still JSON-serializable, so it satisfies the documented `content`
    // contract and every durable backend's own JSON.stringify — and it used to blow the
    // call stack here, failing the write for a value the store had already promised to take.
    let deep: unknown = "needle";
    for (let i = 0; i < 5_000; i++) deep = { nested: deep };
    expect(() => JSON.stringify(deep)).not.toThrow(); // the premise
    expect(() => searchableText({ content: deep, timestamp: 1 })).not.toThrow();
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
