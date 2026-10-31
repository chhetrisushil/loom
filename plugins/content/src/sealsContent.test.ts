import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { CachingContentStore } from "./CachingContentStore";
import { ContentResolvingEventStore } from "./ContentResolvingEventStore";
import { CONTENT_STORE_SPI_VERSION, type ContentStore, InMemoryContentStore } from "./ContentStore";

// ADR 0143 - ContentStore SPI 1.5.0: the owner argument and the `sealsContent` marker. Two decorators
// cannot sit above a sealing store without defeating it, so they refuse at construction.

const sealing = Object.assign(new InMemoryContentStore(), { sealsContent: true as const });

describe("ContentStore SPI 1.5.0 (ADR 0143)", () => {
  it("is 1.5.0", () => {
    expect(CONTENT_STORE_SPI_VERSION).toBe("1.5.0");
  });

  it("a plain store ignores the owner argument (default byte-identical)", async () => {
    const store: ContentStore = new InMemoryContentStore();
    const owner = { executionId: "e", workflowId: "w" };
    const a = await store.put(new Uint8Array([1, 2, 3]), owner);
    const b = await store.put(new Uint8Array([1, 2, 3]));
    expect(a).toEqual(b);
    expect(store.sealsContent).toBeUndefined();
  });

  it("CachingContentStore refuses to cache PLAINTEXT above a sealing store", () => {
    expect(() => new CachingContentStore(sealing, { maxBytes: 1024 })).toThrow(/sealsContent/);
  });

  it("CachingContentStore forwards the owner to a plain inner store", async () => {
    const seen: unknown[] = [];
    const inner = new InMemoryContentStore();
    const spy = {
      put: (b: Uint8Array, a?: unknown) => {
        seen.push(["put", a]);
        return inner.put(b);
      },
      get: (r: { __loomContent: string }, a?: unknown) => {
        seen.push(["get", a]);
        return inner.get(r);
      },
      delete: (r: { __loomContent: string }) => inner.delete(r),
    };
    const owner = { executionId: "e", workflowId: "w" };
    const cache = new CachingContentStore(spy, { maxBytes: 1 }); // 1 byte: nothing is admitted
    const ref = await cache.put(new Uint8Array([9, 9]), owner);
    await cache.get(ref, owner);
    expect(seen).toEqual([
      ["put", owner],
      ["get", owner],
    ]);
  });

  it("ContentResolvingEventStore (ADR 0046 externalization) refuses a sealing store", () => {
    expect(
      () =>
        new ContentResolvingEventStore(new InMemoryAsyncEventStore(), sealing, {
          externalize: { X: ["a"] },
        })
    ).toThrow(/seals per subject/);
  });
});
