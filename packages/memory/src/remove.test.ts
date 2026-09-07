import { memory$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";
import { MemoryRuntime } from "./MemoryRuntime";
import { TieredMemory } from "./TieredMemory";
import type { MemoryEntry, MemoryStore } from "./types";

/** A backend with no `remove` and no `replace` — the minimum SPI, exercising both fallbacks. */
class MinimalStore implements MemoryStore {
  readonly calls: string[] = [];
  protected readonly rows = new Map<string, MemoryEntry[]>();
  async append(key: string, entry: MemoryEntry): Promise<void> {
    this.calls.push("append");
    this.rows.set(key, [...(this.rows.get(key) ?? []), entry]);
  }
  async read(key: string): Promise<MemoryEntry[]> {
    this.calls.push("read");
    return [...(this.rows.get(key) ?? [])];
  }
  async clear(key: string): Promise<void> {
    this.calls.push("clear");
    this.rows.delete(key);
  }
}

/** The minimal store plus an atomic `replace`, to prove the rewrite prefers it. */
class ReplacingStore extends MinimalStore {
  async replace(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    this.calls.push("replace");
    this.rows.set(key, [...entries]);
    if (entries.length === 0) this.rows.delete(key);
  }
}

describe("MemoryRuntime.remove", () => {
  const runtime = (store: MemoryStore): MemoryRuntime =>
    new MemoryRuntime(store).register(memory$({ id: "m", name: "M" }));

  it("deletes named entries through the backend when it has one", async () => {
    const rt = runtime(new InMemoryMemoryStore());
    await rt.append("m", "s", { id: "a", content: "one" });
    await rt.append("m", "s", { id: "b", content: "two" });
    await rt.remove("m", "s", ["a"]);
    expect((await rt.read("m", "s")).map((e) => e.content)).toEqual(["two"]);
  });

  it("falls back to read-filter-rewrite on a backend without remove", async () => {
    // Unlike `search`, an absent verb here must NOT throw: the fallback is correct, only
    // linear. Refusing would deny a working capability rather than prevent a wrong answer.
    const store = new MinimalStore();
    const rt = runtime(store);
    await rt.append("m", "s", { id: "a", content: "one" });
    await rt.append("m", "s", { id: "b", content: "two" });
    store.calls.length = 0;
    await rt.remove("m", "s", ["a"]);
    expect((await rt.read("m", "s")).map((e) => e.content)).toEqual(["two"]);
    expect(store.calls).toContain("clear"); // the rewrite, not a no-op
  });

  it("prefers the atomic replace for the fallback rewrite", async () => {
    // Same durability argument as eviction: a crash between `clear` and the re-appends
    // would lose the scope this call was asked to prune part of.
    const store = new ReplacingStore();
    const rt = runtime(store);
    await rt.append("m", "s", { id: "a", content: "one" });
    await rt.append("m", "s", { id: "b", content: "two" });
    store.calls.length = 0;
    await rt.remove("m", "s", ["a"]);
    expect(store.calls).toContain("replace");
    expect((await rt.read("m", "s")).map((e) => e.content)).toEqual(["two"]);
  });

  it("does not touch the store at all for an empty id list", async () => {
    const store = new MinimalStore();
    const rt = runtime(store);
    await rt.append("m", "s", { id: "a", content: "one" });
    store.calls.length = 0;
    await rt.remove("m", "s", []);
    expect(store.calls).toEqual([]);
    expect((await rt.read("m", "s")).map((e) => e.content)).toEqual(["one"]);
  });

  it("never removes an entry that has no id, on either path", async () => {
    for (const store of [new InMemoryMemoryStore(), new MinimalStore()]) {
      const rt = runtime(store);
      await rt.append("m", "s", { content: "anonymous" });
      await rt.append("m", "s", { id: "a", content: "identified" });
      await rt.remove("m", "s", ["a", "undefined"]);
      expect((await rt.read("m", "s")).map((e) => e.content)).toEqual(["anonymous"]);
    }
  });

  it("leaves other scopes alone", async () => {
    const rt = runtime(new InMemoryMemoryStore());
    await rt.append("m", "s1", { id: "a", content: "keep" });
    await rt.append("m", "s2", { id: "a", content: "drop" });
    await rt.remove("m", "s2", ["a"]);
    expect((await rt.read("m", "s1")).map((e) => e.content)).toEqual(["keep"]);
    expect(await rt.read("m", "s2")).toEqual([]);
  });
});

describe("TieredMemory.forget", () => {
  it("removes by id within a tier and scope, and rejects an unknown tier", async () => {
    const memory = new TieredMemory({
      tiers: { semantic: {} },
      store: new InMemoryMemoryStore(),
    });
    await memory.remember("semantic", "corpus", { id: "d#0", content: "first" });
    await memory.remember("semantic", "corpus", { id: "d#1", content: "second" });
    await memory.forget("semantic", "corpus", ["d#0"]);
    expect((await memory.recall("semantic", "corpus")).map((e) => e.content)).toEqual(["second"]);
    await expect(memory.forget("nope", "corpus", ["d#0"])).rejects.toThrow(/Unknown memory tier/);
  });

  it("exposes a tier's policy so a caller can refuse to store in an evicting tier", () => {
    const memory = new TieredMemory({
      tiers: { working: { maxEntries: 10 }, semantic: {} },
      store: new InMemoryMemoryStore(),
    });
    expect(memory.tierPolicy("working")).toEqual({ maxEntries: 10 });
    expect(memory.tierPolicy("semantic")).toEqual({});
    expect(memory.tierPolicy("absent")).toBeUndefined();
  });
});
