import { runContentStoreConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { CachingContentStore } from "./CachingContentStore";
import { InMemoryContentStore } from "./ContentStore";

// The reference ContentStore must uphold the ADR-0046 contract every backing (S3/FS/KMS) owes.
runContentStoreConformance(() => new InMemoryContentStore(), "InMemoryContentStore", {
  clocked: (now) => new InMemoryContentStore({ now }),
});

// ADR 0062 — a caching decorator is still a conformant store (incl. delete-evicts-first).
runContentStoreConformance(
  () => new CachingContentStore(new InMemoryContentStore(), { maxBytes: 1024 * 1024 }),
  "CachingContentStore(InMemory)",
  {
    clocked: (now) =>
      new CachingContentStore(new InMemoryContentStore({ now }), { maxBytes: 1024 * 1024 }),
  }
);

// SPI 1.3.0 (ADR 0055 D5/D6): a decorator that drops an optional method silently turns a
// race-safe sweep into a racy one (`raceSafe: false`) and makes `reclaimOrphans` refuse.
describe("CachingContentStore forwards the SPI 1.3.0 optionals", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("exposes deleteIfUntouchedSince and listPage exactly when the inner store has them", () => {
    const full = new CachingContentStore(new InMemoryContentStore(), { maxBytes: 1024 });
    expect(typeof full.deleteIfUntouchedSince).toBe("function");
    expect(typeof full.listPage).toBe("function");
    expect(typeof full.touchClock).toBe("function");
    expect(typeof full.touch).toBe("function"); // SPI 1.4.0

    const bare = {
      put: async () => ({ __loomContent: "sha256:x", size: 0 }),
      get: async () => null,
      delete: async () => {},
    };
    const minimal = new CachingContentStore(bare, { maxBytes: 1024 });
    expect(minimal.deleteIfUntouchedSince).toBeUndefined();
    expect(minimal.listPage).toBeUndefined();
    expect(minimal.touchClock).toBeUndefined();
    expect(minimal.touch).toBeUndefined();
  });

  it("a conditional delete that erases also evicts — erasure is never served from cache", async () => {
    let clock = 0;
    const inner = new InMemoryContentStore({ now: () => clock });
    const cache = new CachingContentStore(inner, { maxBytes: 1024 });
    const ref = await cache.put(enc("cached"));
    expect(await cache.get(ref)).not.toBeNull(); // warm
    clock = 100;
    expect(await cache.deleteIfUntouchedSince!(ref, 50)).toBe(true);
    expect(await cache.get(ref)).toBeNull();
  });

  it("a refused conditional delete leaves the blob readable", async () => {
    const inner = new InMemoryContentStore({ now: () => 100 });
    const cache = new CachingContentStore(inner, { maxBytes: 1024 });
    const ref = await cache.put(enc("touched"));
    expect(await cache.deleteIfUntouchedSince!(ref, 50)).toBe(false);
    expect(await cache.get(ref)).not.toBeNull();
  });
});
