import { describe, expect, it } from "vitest";
import { CoalescingEventStore } from "./CoalescingEventStore";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { ProfilingEventStore } from "./ProfilingEventStore";
import { ShardSealingMismatchError, ShardedEventStore } from "./ShardedEventStore";
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
    expect(EVENT_STORE_SPI_VERSION).toBe("2.6.0");
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

describe("ShardedEventStore: the sealing capability fails closed on disagreement", () => {
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

  it("AGREE: identical capabilities on every shard answer that capability", () => {
    const sharded = new ShardedEventStore([
      new Sealing(capability("c", ["A.x", "B.y"])),
      new Sealing(capability("c", ["A.x", "B.y"])),
    ]);
    const got = sharded.sealingCapability?.();
    expect(got?.cipher).toBe("c");
    expect(got?.covers).toEqual(["A.x", "B.y"]);
    expect(got?.opens(marker("c", ["B.y"]))).toBe(true);
    expect(got?.opens(marker("c", ["Z.z"]))).toBe(false);
  });

  it("ALL ABSENT: no shard seals -> undefined (not an error)", () => {
    const sharded = new ShardedEventStore([new Sealing(undefined), new Sealing(undefined)]);
    expect(sharded.sealingCapability?.()).toBeUndefined();
  });

  it("MIXED absent/present throws ShardSealingMismatchError (a store that seals on some shards seals)", () => {
    const sharded = new ShardedEventStore([
      new Sealing(capability("c", ["A.x"])),
      new Sealing(undefined),
    ]);
    expect(() => sharded.sealingCapability?.()).toThrow(ShardSealingMismatchError);
    const reversed = new ShardedEventStore([
      new Sealing(undefined),
      new Sealing(capability("c", ["A.x"])),
    ]);
    expect(() => reversed.sealingCapability?.()).toThrow(ShardSealingMismatchError);
  });

  it("DIFFERENT covers throws (no intersection that hides a sealing shard)", () => {
    const sharded = new ShardedEventStore([
      new Sealing(capability("c", ["A.x", "B.y"])),
      new Sealing(capability("c", ["B.y", "C.z"])),
    ]);
    expect(() => sharded.sealingCapability?.()).toThrow(ShardSealingMismatchError);
  });

  it("covers compare as SETS: another order or a duplicate agrees; a subset still throws", () => {
    const agree = new ShardedEventStore([
      new Sealing(capability("c", ["A.x", "B.y"])),
      new Sealing(capability("c", ["B.y", "A.x", "A.x"])),
    ]);
    expect(agree.sealingCapability?.()?.covers).toEqual(["A.x", "B.y"]);
    const subset = new ShardedEventStore([
      new Sealing(capability("c", ["A.x", "A.x"])),
      new Sealing(capability("c", ["A.x", "B.y"])),
    ]);
    expect(() => subset.sealingCapability?.()).toThrow(ShardSealingMismatchError);
    // The reverse order: same length, every element known to the first shard, still a subset.
    const reversed = new ShardedEventStore([
      new Sealing(capability("c", ["A.x", "B.y"])),
      new Sealing(capability("c", ["A.x", "A.x"])),
    ]);
    expect(() => reversed.sealingCapability?.()).toThrow(ShardSealingMismatchError);
  });

  it("DIFFERENT cipher throws, and the error names the shards without key material", () => {
    const sharded = new ShardedEventStore([
      new Sealing(capability("c", ["A.x"])),
      new Sealing(capability("d", ["A.x"])),
    ]);
    let caught: unknown;
    try {
      sharded.sealingCapability?.();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShardSealingMismatchError);
    const err = caught as ShardSealingMismatchError;
    expect(err.shards.map((x) => x.cipher)).toEqual(["c", "d"]);
    expect(err.shards.map((x) => x.index)).toEqual([0, 1]);
  });

  it("is LIVE: a registerSensitive-style change on ONE shard flips agree -> throws -> agree", () => {
    let second = capability("c", ["A.x"]);
    class Live extends InMemoryAsyncEventStore {
      constructor(private readonly get: () => SealingCapability | undefined) {
        super();
      }
      sealingCapability(): SealingCapability | undefined {
        return this.get();
      }
    }
    const sharded = new ShardedEventStore([
      new Sealing(capability("c", ["A.x"])),
      new Live(() => second),
    ]);
    expect(sharded.sealingCapability?.()?.covers).toEqual(["A.x"]);
    second = capability("c", ["A.x", "B.y"]); // shard 2 registers another path
    expect(() => sharded.sealingCapability?.()).toThrow(ShardSealingMismatchError);
    second = capability("c", ["A.x"]);
    expect(sharded.sealingCapability?.()?.covers).toEqual(["A.x"]);
  });

  it("a method-ABSENT shard counts as sealing nothing: sealing + absent throws, in both orders", () => {
    const sealing = (): EventStore => new Sealing(capability("c", ["A.x"]));
    const plain = (): EventStore => new InMemoryAsyncEventStore();
    expect(plain().sealingCapability).toBeUndefined();
    const a = new ShardedEventStore([sealing(), plain()]);
    expect(a.sealingCapability).toBeTypeOf("function");
    expect(() => a.sealingCapability?.()).toThrow(ShardSealingMismatchError);
    const b = new ShardedEventStore([plain(), sealing()]);
    expect(() => b.sealingCapability?.()).toThrow(ShardSealingMismatchError);
  });

  it("method-absent + undefined-returning shard -> undefined (nothing seals)", () => {
    const sharded = new ShardedEventStore([new InMemoryAsyncEventStore(), new Sealing(undefined)]);
    expect(sharded.sealingCapability).toBeTypeOf("function");
    expect(sharded.sealingCapability?.()).toBeUndefined();
  });

  it("ALL shards lack the method -> the method is omitted (an all-plain fleet is unchanged)", () => {
    const sharded = new ShardedEventStore([
      new InMemoryAsyncEventStore(),
      new InMemoryAsyncEventStore(),
    ]);
    expect(sharded.sealingCapability).toBeUndefined();
  });
});
