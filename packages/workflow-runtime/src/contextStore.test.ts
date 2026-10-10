import { describe, expect, it, vi } from "vitest";
import { createContextStore } from "./contextStore";

describe("createContextStore", () => {
  it("is an AsyncLocalStorage on Node: the store survives an await", async () => {
    const s = createContextStore<number>();
    expect(s.getStore()).toBeUndefined();
    const seen = await s.run(7, async () => {
      await Promise.resolve();
      return s.getStore();
    });
    expect(seen).toBe(7);
    expect(s.getStore()).toBeUndefined();
  });

  it("loads and works where node:async_hooks has no AsyncLocalStorage (browser bundle)", async () => {
    vi.resetModules();
    vi.doMock("node:async_hooks", () => ({}));
    const { createContextStore: make } = await import("./contextStore");
    const s = make<number>();
    expect(s.getStore()).toBeUndefined();
    expect(
      s.run(1, () => {
        const inner = s.run(2, () => s.getStore());
        return [inner, s.getStore()];
      })
    ).toEqual([2, 1]);
    expect(s.getStore()).toBeUndefined();
    // the documented limit: not visible across an await
    const after = await s.run(3, async () => {
      await Promise.resolve();
      return s.getStore();
    });
    expect(after).toBeUndefined();
    vi.doUnmock("node:async_hooks");
  });
});
