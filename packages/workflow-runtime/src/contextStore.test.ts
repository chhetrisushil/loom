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

  it("loads where node:async_hooks has no AsyncLocalStorage, and refuses to ENTER a scope there", async () => {
    vi.resetModules();
    vi.doMock("node:async_hooks", () => ({}));
    try {
      const { createContextStore: make, AsyncContextUnavailableError: E } = await import(
        "./contextStore"
      );
      const s = make<number>();
      expect(s.getStore()).toBeUndefined();
      const ran = vi.fn();
      expect(() => s.run(1, ran)).toThrow(E);
      expect(ran).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:async_hooks");
    }
  });
});
