import { describe, expect, it } from "vitest";
import { CoalescingEventStore } from "./CoalescingEventStore";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { ProfilingEventStore } from "./ProfilingEventStore";
import { ShardedEventStore } from "./ShardedEventStore";
import { TenantScopedEventStore } from "./TenantScopedEventStore";
import {
  EVENT_STORE_SPI_VERSION,
  type EventStore,
  OPTIONAL_EVENT_STORE_METHODS,
  type SealMarker,
  type SealingCapability,
} from "./types";

// EventStore SPI 2.5.0 (ADR 0130 residuals D7) - the optional `sealingCapability()`. RESERVED: declared
// and forwarded, no caller. The compile-time half of "every decorator forwards it" is the
// `DecoratorPlan` (`decoratorPlan.typecheck.ts` and each decorator's `satisfies`); this is the runtime
// half, over the in-repo decorators that live in this package.

const capability = (
  cipher: string,
  covers: readonly string[],
  tag = "cap"
): SealingCapability & { tag: string } => ({
  tag,
  cipher,
  covers,
  opens: (m: SealMarker) => m.cipher === cipher && m.covers.every((c) => covers.includes(c)),
});

class Sealing extends InMemoryAsyncEventStore {
  constructor(private readonly cap: SealingCapability | undefined) {
    super();
  }
  sealingCapability(): SealingCapability | undefined {
    return this.cap;
  }
}

describe("EventStore SPI 2.5.0: sealingCapability", () => {
  it("is version 2.5.0 and is a listed optional method (so every decorator plan must decide it)", () => {
    expect(EVENT_STORE_SPI_VERSION).toBe("2.5.0");
    expect(OPTIONAL_EVENT_STORE_METHODS).toContain("sealingCapability");
  });

  it("a store without it simply lacks the method: that IS 'seals and opens nothing'", () => {
    expect((new InMemoryAsyncEventStore() as EventStore).sealingCapability).toBeUndefined();
    for (const wrap of [
      (s: EventStore) => new CoalescingEventStore(s),
      (s: EventStore) => new ProfilingEventStore(s),
      (s: EventStore) => new TenantScopedEventStore(s, "t"),
      (s: EventStore) => new ShardedEventStore([s]),
    ]) {
      expect(wrap(new InMemoryAsyncEventStore()).sealingCapability).toBeUndefined();
    }
  });

  it("every decorator forwards the inner store's capability VALUE unchanged", () => {
    const cap = capability("loom/aes-256-gcm", ["STEP_COMPLETED.output"]);
    const inner = new Sealing(cap);
    expect(new CoalescingEventStore(inner).sealingCapability?.()).toBe(cap);
    expect(new ProfilingEventStore(inner).sealingCapability?.()).toBe(cap);
    expect(new TenantScopedEventStore(inner, "t").sealingCapability?.()).toBe(cap);
    // Stacked: the value survives composition.
    const stacked = new CoalescingEventStore(
      new TenantScopedEventStore(new ProfilingEventStore(inner), "t")
    );
    expect(stacked.sealingCapability?.()).toBe(cap);
  });

  it("a forwarded `undefined` stays undefined (a store that has the method and seals nothing)", () => {
    const inner = new Sealing(undefined);
    expect(typeof new CoalescingEventStore(inner).sealingCapability).toBe("function");
    expect(new CoalescingEventStore(inner).sealingCapability?.()).toBeUndefined();
    expect(
      new ShardedEventStore([inner, new Sealing(undefined)]).sealingCapability?.()
    ).toBeUndefined();
  });
});

describe("ShardedEventStore: the intersection rule", () => {
  const marker = (cipher: string, covers: string[]): SealMarker => ({ v: 1, cipher, covers });

  it("one shard: the same cipher and covers, and opens() agrees", () => {
    const sharded = new ShardedEventStore([new Sealing(capability("c", ["A.x", "B.y"]))]);
    const got = sharded.sealingCapability?.();
    expect(got?.cipher).toBe("c");
    expect(got?.covers).toEqual(["A.x", "B.y"]);
    expect(got?.opens(marker("c", ["A.x"]))).toBe(true);
    expect(got?.opens(marker("c", ["Z.z"]))).toBe(false);
    expect(got?.opens(marker("other", []))).toBe(false);
  });

  it("covers is the INTERSECTION, and opens() needs every shard to open the marker", () => {
    const sharded = new ShardedEventStore([
      new Sealing(capability("c", ["A.x", "B.y"])),
      new Sealing(capability("c", ["B.y", "C.z"])),
    ]);
    const got = sharded.sealingCapability?.();
    expect(got?.covers).toEqual(["B.y"]);
    expect(got?.opens(marker("c", ["B.y"]))).toBe(true);
    expect(got?.opens(marker("c", ["A.x"]))).toBe(false); // shard 2 cannot
    expect(got?.opens(marker("c", ["C.z"]))).toBe(false); // shard 1 cannot
  });

  it("is undefined unless EVERY shard has a capability of the SAME cipher", () => {
    const a = new Sealing(capability("c", ["A.x"]));
    expect(
      new ShardedEventStore([a, new Sealing(undefined)]).sealingCapability?.()
    ).toBeUndefined();
    expect(
      new ShardedEventStore([a, new Sealing(capability("d", ["A.x"]))]).sealingCapability?.()
    ).toBeUndefined();
  });

  it("is not offered at all when any shard lacks the method (a partial capability is worse than none)", () => {
    const sharded = new ShardedEventStore([
      new Sealing(capability("c", ["A.x"])),
      new InMemoryAsyncEventStore(),
    ]);
    expect(sharded.sealingCapability).toBeUndefined();
  });

  it("is LIVE: it reflects a shard's configuration change on the next call", () => {
    let current = capability("c", ["A.x"]);
    class Live extends InMemoryAsyncEventStore {
      sealingCapability(): SealingCapability {
        return current;
      }
    }
    const sharded = new ShardedEventStore([new Live()]);
    expect(sharded.sealingCapability?.()?.covers).toEqual(["A.x"]);
    current = capability("c", ["A.x", "B.y"]);
    expect(sharded.sealingCapability?.()?.covers).toEqual(["A.x", "B.y"]);
  });
});
