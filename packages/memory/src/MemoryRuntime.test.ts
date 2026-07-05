import { memory$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import { MemoryRuntime } from "./MemoryRuntime";

describe("MemoryRuntime", () => {
  it("appends and reads scoped entries", async () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "chat", name: "Chat" }));
    await rt.append("chat", "conv-1", { content: "hello" });
    await rt.append("chat", "conv-1", { content: "world" });
    await rt.append("chat", "conv-2", { content: "other" });

    expect((await rt.read("chat", "conv-1")).map((e) => e.content)).toEqual(["hello", "world"]);
    expect((await rt.read("chat", "conv-2")).map((e) => e.content)).toEqual(["other"]);
  });

  it("enforces maxEntries (keeps newest)", async () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M", maxEntries: 2 }));
    await rt.append("m", "s", { content: 1 });
    await rt.append("m", "s", { content: 2 });
    await rt.append("m", "s", { content: 3 });
    expect((await rt.read("m", "s")).map((e) => e.content)).toEqual([2, 3]);
  });

  it("enforces ttlMs (drops stale entries on read)", async () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M", ttlMs: 1000 }));
    const now = Date.now();
    await rt.append("m", "s", { content: "old", timestamp: now - 5000 });
    await rt.append("m", "s", { content: "fresh", timestamp: now });
    expect((await rt.read("m", "s")).map((e) => e.content)).toEqual(["fresh"]);
  });

  it("clear() removes a scope", async () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M" }));
    await rt.append("m", "s", { content: "x" });
    await rt.clear("m", "s");
    expect(await rt.read("m", "s")).toEqual([]);
  });

  it("works without ttl/maxEntries (unbounded)", async () => {
    const rt = new MemoryRuntime();
    rt.register(memory$({ id: "m", name: "M" }));
    for (let i = 0; i < 5; i++) await rt.append("m", "s", { content: i });
    expect(await rt.read("m", "s")).toHaveLength(5);
  });
});
