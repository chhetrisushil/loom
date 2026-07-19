import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { CachingContentStore } from "./CachingContentStore";
import { ContentResolvingEventStore } from "./ContentResolvingEventStore";
import { type ContentStore, InMemoryContentStore } from "./ContentStore";
import type { ContentRef } from "./content";
import { ContentMissingError } from "./errors";

// ── ADR 0062 — batch-scoped two-phase resolution ──────────────────────────────

/** Latency-injecting decorator: per-call latency, so round-trip counts are measurable. */
class LatencyStore implements ContentStore {
  gets = 0;
  getManys = 0;
  constructor(
    private readonly inner: InMemoryContentStore,
    private readonly latencyMs: number,
    supportsGetMany: boolean
  ) {
    if (supportsGetMany) {
      this.getMany = async (refs: readonly ContentRef[]) => {
        this.getManys++;
        await sleep(this.latencyMs);
        return this.inner.getMany(refs);
      };
    }
  }
  getMany?: (refs: readonly ContentRef[]) => Promise<(Uint8Array | null)[]>;
  put(bytes: Uint8Array): Promise<ContentRef> {
    return this.inner.put(bytes);
  }
  async get(ref: ContentRef): Promise<Uint8Array | null> {
    this.gets++;
    await sleep(this.latencyMs);
    return this.inner.get(ref);
  }
  delete(ref: ContentRef): Promise<void> {
    return this.inner.delete(ref);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envelope(sequence: number, payload: unknown): EventEnvelope {
  return {
    id: `e-${sequence}`,
    executionId: "x-1",
    workflowId: "w-1",
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}

async function seeded(latencyMs: number, supportsGetMany: boolean, widgets = 50) {
  const memory = new InMemoryContentStore();
  const content = new LatencyStore(memory, latencyMs, supportsGetMany);
  const inner = new InMemoryAsyncEventStore();
  const store = new ContentResolvingEventStore(inner, content, {
    externalize: { STEP_COMPLETED: ["output.doc"] },
  });
  for (let i = 0; i < widgets; i++) {
    await store.append(envelope(i, { stepId: `hydrate#${i}`, output: { doc: { widget: i } } }));
  }
  return { store, content };
}

describe("batched reference resolution (TS-10, ADR 0062)", () => {
  it("resolves a whole read batch in ONE getMany round-trip", async () => {
    const { store, content } = await seeded(0, true);
    const events = await store.read("x-1");
    expect(events).toHaveLength(50);
    expect((events[7]?.payload as { output: { doc: unknown } }).output.doc).toEqual({ widget: 7 });
    expect(content.getManys).toBe(1); // the whole batch, one round-trip
    expect(content.gets).toBe(0);
  });

  it("falls back to coalesced parallel gets on a store without getMany", async () => {
    const { store, content } = await seeded(5, false, 20);
    const t0 = performance.now();
    const events = await store.read("x-1");
    const elapsed = performance.now() - t0;
    expect(events).toHaveLength(20);
    expect(content.gets).toBe(20);
    // Coalesced (parallel) — nowhere near the 20 × 5ms serialized floor.
    expect(elapsed).toBeLessThan(50);
  });

  it("duplicate refs are fetched once but decoded per-occurrence (no aliasing)", async () => {
    const memory = new InMemoryContentStore();
    const content = new LatencyStore(memory, 0, true);
    const inner = new InMemoryAsyncEventStore();
    const store = new ContentResolvingEventStore(inner, content, {
      externalize: { STEP_COMPLETED: ["output.a", "output.b"] },
    });
    // Identical values → identical content address → one blob, two payload sites.
    await store.append(envelope(0, { output: { a: { same: true }, b: { same: true } } }));
    const [event] = await store.read("x-1");
    const payload = event?.payload as { output: { a: unknown; b: unknown } };
    expect(payload.output.a).toEqual(payload.output.b);
    expect(payload.output.a).not.toBe(payload.output.b); // decoded per occurrence — never aliased
  });

  it("meets the interactive budget: 50 refs against a 5ms-per-round-trip store", async () => {
    const { store } = await seeded(5, true);
    const t0 = performance.now();
    await store.read("x-1");
    const p = performance.now() - t0;
    // One batched round-trip (~5ms) + O(nodes) walks. Budget p95 ≤ 150ms; the
    // serialized baseline would be ≥ 250ms.
    expect(p).toBeLessThan(150);
  });

  it("an erased blob still fails loudly with ContentMissingError (G1)", async () => {
    const memory = new InMemoryContentStore();
    const content = new LatencyStore(memory, 0, true);
    const inner = new InMemoryAsyncEventStore();
    const store = new ContentResolvingEventStore(inner, content, {
      externalize: { STEP_COMPLETED: ["output.doc"] },
    });
    await store.append(envelope(0, { output: { doc: { big: "x".repeat(64) } } }));
    const [raw] = await inner.read("x-1");
    const ref = (raw?.payload as { output: { doc: ContentRef } }).output.doc;
    await memory.delete(ref);
    await expect(store.read("x-1")).rejects.toBeInstanceOf(ContentMissingError);
  });
});

describe("CachingContentStore (ADR 0062)", () => {
  it("serves repeat reads from cache and splits getMany batches into hits + one miss fetch", async () => {
    const memory = new InMemoryContentStore();
    const latency = new LatencyStore(memory, 0, true);
    const cache = new CachingContentStore(latency, { maxBytes: 1024 * 1024 });

    const a = await cache.put(new TextEncoder().encode("alpha"));
    const b = await memory.put(new TextEncoder().encode("beta")); // NOT via cache — a miss

    const first = await cache.getMany([a, b]);
    expect(first.map((x) => x !== null)).toEqual([true, true]);
    expect(latency.getManys).toBe(1); // only the miss batch went to the backend

    latency.getManys = 0;
    latency.gets = 0;
    const second = await cache.getMany([a, b]);
    expect(second.map((x) => x !== null)).toEqual([true, true]);
    expect(latency.getManys).toBe(0); // both now cached
    expect(latency.gets).toBe(0);
  });

  it("delete evicts before forwarding — erasure is never resurrected from cache", async () => {
    const memory = new InMemoryContentStore();
    const cache = new CachingContentStore(memory, { maxBytes: 1024 });
    const ref = await cache.put(new TextEncoder().encode("secret-ish"));
    expect(await cache.get(ref)).not.toBeNull();
    await cache.delete(ref);
    expect(await cache.get(ref)).toBeNull(); // not served from a warm cache
    expect(cache.cacheBytes).toBe(0);
  });

  it("SEC-2: bytes from a lying inner store are neither served nor cached", async () => {
    const honest = new InMemoryContentStore();
    const ref = await honest.put(new TextEncoder().encode("the-real-script"));
    const lying: ContentStore = {
      put: (bytes) => honest.put(bytes),
      get: async () => new TextEncoder().encode("poisoned-bytes"),
      delete: (r) => honest.delete(r),
    };
    const cache = new CachingContentStore(lying, { maxBytes: 1024 });
    await expect(cache.get(ref)).rejects.toThrow(/does not match/);
    expect(cache.cacheBytes).toBe(0); // nothing poisoned the cache
  });

  it("enforces the byte budget with LRU eviction and never admits an over-budget blob", async () => {
    const memory = new InMemoryContentStore();
    const cache = new CachingContentStore(memory, { maxBytes: 10 });
    const a = await cache.put(new TextEncoder().encode("aaaa")); // 4 bytes
    const b = await cache.put(new TextEncoder().encode("bbbb")); // 4 bytes
    await cache.get(a); // touch a — b becomes LRU
    await cache.put(new TextEncoder().encode("cccc")); // 4 bytes → evicts b
    expect(cache.cacheBytes).toBe(8);

    await cache.put(new TextEncoder().encode("x".repeat(64))); // over budget — never admitted
    expect(cache.cacheBytes).toBe(8);
    // Everything still readable through the backend regardless of cache state.
    expect(await cache.get(b)).not.toBeNull();
  });
});
