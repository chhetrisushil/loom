import { memory$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import { MemoryRuntime } from "./MemoryRuntime";

describe("MemoryRuntime", () => {
  it("appends and reads scoped entries", () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "chat", name: "Chat" }));
    rt.append("chat", "conv-1", { content: "hello" });
    rt.append("chat", "conv-1", { content: "world" });
    rt.append("chat", "conv-2", { content: "other" });

    expect(rt.read("chat", "conv-1").map((e) => e.content)).toEqual(["hello", "world"]);
    expect(rt.read("chat", "conv-2").map((e) => e.content)).toEqual(["other"]);
  });

  it("enforces maxEntries (keeps newest)", () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M", maxEntries: 2 }));
    rt.append("m", "s", { content: 1 });
    rt.append("m", "s", { content: 2 });
    rt.append("m", "s", { content: 3 });
    expect(rt.read("m", "s").map((e) => e.content)).toEqual([2, 3]);
  });

  it("enforces ttlMs (drops stale entries on read)", () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M", ttlMs: 1000 }));
    const now = Date.now();
    rt.append("m", "s", { content: "old", timestamp: now - 5000 });
    rt.append("m", "s", { content: "fresh", timestamp: now });
    expect(rt.read("m", "s").map((e) => e.content)).toEqual(["fresh"]);
  });

  it("clear() removes a scope", () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M" }));
    rt.append("m", "s", { content: "x" });
    rt.clear("m", "s");
    expect(rt.read("m", "s")).toEqual([]);
  });

  it("works without ttl/maxEntries (unbounded)", () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M" }));
    for (let i = 0; i < 5; i++) rt.append("m", "s", { content: i });
    expect(rt.read("m", "s")).toHaveLength(5);
  });
});
