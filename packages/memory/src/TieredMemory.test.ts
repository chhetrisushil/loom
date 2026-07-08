import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "./types";
import { DEFAULT_TIERS, TieredMemory } from "./TieredMemory";

// A monotonic clock so timestamps are deterministic across the test.
function clock() {
  let t = 1000;
  return () => t++;
}

describe("TieredMemory — tiers", () => {
  it("isolates entries by tier", async () => {
    const mem = new TieredMemory({ tiers: DEFAULT_TIERS, now: clock() });
    await mem.remember("working", "s1", { content: "scratch" });
    await mem.remember("semantic", "s1", { content: "fact" });

    expect((await mem.recall("working", "s1")).map((e) => e.content)).toEqual(["scratch"]);
    expect((await mem.recall("semantic", "s1")).map((e) => e.content)).toEqual(["fact"]);
  });

  it("scopes entries independently", async () => {
    const mem = new TieredMemory({ tiers: DEFAULT_TIERS, now: clock() });
    await mem.remember("semantic", "user-a", { content: "a" });
    await mem.remember("semantic", "user-b", { content: "b" });
    expect((await mem.recall("semantic", "user-a")).map((e) => e.content)).toEqual(["a"]);
  });

  it("throws for an unknown tier", async () => {
    const mem = new TieredMemory({ tiers: DEFAULT_TIERS });
    await expect(mem.recall("nope", "s1")).rejects.toThrow(/Unknown memory tier/);
  });

  it("recall honours limit (newest N)", async () => {
    const mem = new TieredMemory({ tiers: { semantic: {} }, now: clock() });
    for (let i = 0; i < 5; i++) await mem.remember("semantic", "s", { content: i });
    expect((await mem.recall("semantic", "s", { limit: 2 })).map((e) => e.content)).toEqual([3, 4]);
  });
});

describe("TieredMemory — summarization bounds a tier", () => {
  it("auto-folds the oldest entries into a summary when over summarizeAfter", async () => {
    const mem = new TieredMemory({ tiers: { working: { summarizeAfter: 4 } }, now: clock() });
    for (let i = 0; i < 6; i++) await mem.remember("working", "s", { content: i });

    const entries = await mem.recall("working", "s");
    // Over the threshold ⇒ oldest folded into one summary, newest kept.
    expect(entries.length).toBeLessThan(6);
    const summary = entries.find((e) => e.role === "summary");
    expect(summary).toBeDefined();
    expect((summary?.content as { summarized: number }).summarized).toBeGreaterThan(0);
    // The newest entry survives verbatim.
    expect(entries[entries.length - 1]?.content).toBe(5);
  });

  it("uses a custom summarizer when provided", async () => {
    const mem = new TieredMemory({
      tiers: { working: { summarizeAfter: 2 } },
      summarizer: (es) => `folded ${es.length}`,
      now: clock(),
    });
    for (let i = 0; i < 4; i++) await mem.remember("working", "s", { content: i });
    const summary = (await mem.recall("working", "s")).find((e) => e.role === "summary");
    expect(typeof summary?.content).toBe("string");
    expect(summary?.content).toMatch(/^folded /);
  });
});

describe("TieredMemory — promotion", () => {
  it("moves matching entries from one tier to another", async () => {
    const mem = new TieredMemory({ tiers: DEFAULT_TIERS, now: clock() });
    await mem.remember("working", "s", { role: "note", content: "keep-me" });
    await mem.remember("working", "s", { role: "chatter", content: "drop" });

    const moved = await mem.promote("working", "semantic", "s", {
      filter: (e) => e.role === "note",
      move: true,
    });

    expect(moved).toBe(1);
    expect((await mem.recall("semantic", "s")).map((e) => e.content)).toEqual(["keep-me"]);
    expect((await mem.recall("working", "s")).map((e) => e.content)).toEqual(["drop"]);
  });
});

describe("TieredMemory — logged recall is replay-deterministic (P9)", () => {
  it("serves the recorded recalled set on replay, ignoring later store changes", async () => {
    const mem = new TieredMemory({ tiers: { semantic: {} }, now: clock() });
    await mem.remember("semantic", "s", { content: "first" });

    // First run: a recording decide captures the recalled set.
    const recorded: Record<string, unknown> = {};
    const recordingDecide = async <T,>(id: string, fn: () => T | Promise<T>): Promise<T> => {
      const v = await fn();
      recorded[id] = v;
      return v;
    };
    const first = await mem.recall("semantic", "s", { decide: recordingDecide });
    expect(first.map((e: MemoryEntry) => e.content)).toEqual(["first"]);

    // The store changes after the fact...
    await mem.remember("semantic", "s", { content: "second" });

    // Replay: a decide that returns the recorded value never re-reads the store.
    const replayDecide = async <T,>(id: string, fn: () => T | Promise<T>): Promise<T> =>
      id in recorded ? (recorded[id] as T) : fn();
    const replayed = await mem.recall("semantic", "s", { decide: replayDecide });

    // Deterministic: same set as the original run, not the mutated store.
    expect(replayed).toEqual(first);
    // (Without logging, a fresh recall would now see both entries.)
    expect((await mem.recall("semantic", "s")).map((e) => e.content)).toEqual(["first", "second"]);
  });
});
