import { memory$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import { MemoryRuntime } from "./MemoryRuntime";
import type { MemoryEntry, MemoryStore } from "./types";

// Stores that record the calls they receive, so "eviction rewrites through `replace`"
// is asserted rather than assumed. Without this, a runtime that silently kept using
// clear-then-append would pass every behavioural test in this package — the rewrite is
// invisible in the resulting entries, and only shows up as data loss on a crash.
class RecordingStore implements MemoryStore {
  readonly calls: string[] = [];
  protected readonly entries = new Map<string, MemoryEntry[]>();

  async append(key: string, entry: MemoryEntry): Promise<void> {
    this.calls.push("append");
    this.entries.set(key, [...(this.entries.get(key) ?? []), entry]);
  }

  async read(key: string): Promise<MemoryEntry[]> {
    return this.entries.get(key) ?? [];
  }

  async clear(key: string): Promise<void> {
    this.calls.push("clear");
    this.entries.delete(key);
  }
}

class ReplacingStore extends RecordingStore {
  async replace(key: string, entries: readonly MemoryEntry[]): Promise<void> {
    this.calls.push("replace");
    if (entries.length === 0) this.entries.delete(key);
    else this.entries.set(key, [...entries]);
  }
}

describe("MemoryRuntime eviction rewrite", () => {
  const capped = memory$({ id: "m", name: "m", maxEntries: 2 });

  it("rewrites an evicted list through the store's atomic `replace`", async () => {
    const store = new ReplacingStore();
    const runtime = new MemoryRuntime(store).register(capped);

    await runtime.append("m", "s", { content: 1 });
    await runtime.append("m", "s", { content: 2 });
    await runtime.append("m", "s", { content: 3 });

    // Three entry appends, then ONE atomic rewrite — never clear-then-re-append.
    expect(store.calls).toEqual(["append", "append", "append", "replace"]);
    expect(store.calls).not.toContain("clear");
    expect((await runtime.read("m", "s")).map((e) => e.content)).toEqual([2, 3]);
  });

  it("falls back to clear-then-append for a store without `replace`", async () => {
    const store = new RecordingStore();
    const runtime = new MemoryRuntime(store).register(capped);

    await runtime.append("m", "s", { content: 1 });
    await runtime.append("m", "s", { content: 2 });
    await runtime.append("m", "s", { content: 3 });

    expect(store.calls).toEqual(["append", "append", "append", "clear", "append", "append"]);
    expect((await runtime.read("m", "s")).map((e) => e.content)).toEqual([2, 3]);
  });

  it("drops a scope pruned to empty through `replace` too", async () => {
    const store = new ReplacingStore();
    const expiring = memory$({ id: "ttl", name: "ttl", ttlMs: 1 });
    const runtime = new MemoryRuntime(store).register(expiring);

    await runtime.append("ttl", "s", { content: "stale", timestamp: Date.now() - 10_000 });
    expect(await runtime.read("ttl", "s")).toEqual([]);
    expect(store.calls).toEqual(["append", "replace"]);
  });
});
