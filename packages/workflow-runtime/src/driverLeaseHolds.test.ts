import { InMemoryLeaseStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { type DriverLease, DriverLeases } from "./driverLease";
import { LeaseLostError, isHeuristicOwner } from "./leaseKeeper";

// DriverLeases (ADR 0130 D11, S7c): the reference-counted holds above the per-runtime keeper. Fake
// clocks and hand-driven timers; every assertion is on the store row and the keeper's own view.

function rig(over: Record<string, unknown> = {}) {
  const clock = { mono: 1_000, wall: 1_700_000_000_000 };
  const store = new InMemoryLeaseStore({ now: () => clock.wall });
  const errors: unknown[] = [];
  const dl = new DriverLeases({
    leaseStore: store,
    nodeId: "n1",
    incarnation: "i1",
    ttlMs: 30_000,
    monotonicNow: () => clock.mono,
    wallNow: () => clock.wall,
    every: () => () => {},
    after: () => () => {},
    onError: (e: unknown) => errors.push(e),
    ...over,
  } as ConstructorParameters<typeof DriverLeases>[0]);
  const row = async (id: string) => (await store.get?.(id)) ?? null;
  /** Make the store report `id` as no longer ours, then run one renew round so the keeper notices. */
  const takeOver = async (id: string): Promise<void> => {
    await store.release(id, dl.keeper.owner);
    await store.acquire(id, "other:node", 30_000, clock.wall);
    await dl.keeper.tick();
  };
  return { dl, store, clock, errors, row, takeOver };
}

const must = (l: DriverLease | null): DriverLease => {
  if (l === null) throw new Error("expected a hold");
  return l;
};

describe("DriverLeases - reference-counted holds", () => {
  it("the keeper's lease is released only when the LAST hold goes", async () => {
    const { dl, row } = rig();
    const a = must(await dl.acquire("e1"));
    const b = must(await dl.acquire("e1"));
    await a.release();
    expect(await row("e1")).not.toBeNull();
    expect(b.valid()).toBe(true);
    await b.release();
    expect(await row("e1")).toBeNull();
    expect(dl.keeper.size).toBe(0);
  });

  it("release is idempotent and a double release never drops another hold's lease", async () => {
    const { dl, row } = rig();
    const a = must(await dl.acquire("e1"));
    const b = must(await dl.acquire("e1"));
    await a.release();
    await a.release();
    expect(await row("e1")).not.toBeNull();
    expect(b.valid()).toBe(true);
  });

  it("another live owner: acquire returns null and no hold exists", async () => {
    const { dl, store, clock } = rig();
    await store.acquire("e1", "other:node", 30_000, clock.wall);
    expect(await dl.acquire("e1")).toBeNull();
  });
});

describe("DriverLeases - loss", () => {
  it("a lost lease tells every live hold ONCE, invalidates them, and a later release is a no-op", async () => {
    const { dl, takeOver } = rig();
    const a = must(await dl.acquire("e1"));
    const b = must(await dl.acquire("e1"));
    const seenA: LeaseLostError[] = [];
    const seenB: LeaseLostError[] = [];
    a.onLost((e) => seenA.push(e));
    b.onLost((e) => seenB.push(e));
    await takeOver("e1");
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenA[0]?.reason).toBe("taken-over");
    expect(a.valid()).toBe(false);
    expect(b.valid()).toBe(false);
    await a.release();
    await b.release();
    expect(seenA).toHaveLength(1);
  });

  it("(b) a loss BETWEEN acquire and the listener attaching is delivered immediately on attach", async () => {
    const { dl, takeOver } = rig();
    const h = must(await dl.acquire("e1"));
    await takeOver("e1"); // lost before anyone attached
    const seen: LeaseLostError[] = [];
    h.onLost((e) => seen.push(e));
    expect(seen).toHaveLength(1); // not a silent no-op
    expect(seen[0]).toBeInstanceOf(LeaseLostError);
    expect(seen[0]?.executionId).toBe("e1");
    expect(seen[0]?.owner).toBe(dl.keeper.owner);
    expect(h.lossError()).toBe(seen[0]);
  });

  it("a stale hold (lost, then the id was re-acquired) cannot release the NEWER lease", async () => {
    const { dl, store, takeOver, row, clock } = rig();
    const old = must(await dl.acquire("e1"));
    await takeOver("e1");
    await store.release("e1", "other:node"); // the other owner went away
    const fresh = must(await dl.acquire("e1"));
    expect(clock.wall).toBeGreaterThan(0);
    await old.release(); // stale: must be a no-op
    expect(fresh.valid()).toBe(true);
    expect(dl.keeper.validNow("e1")).toBe(true);
    expect(await row("e1")).not.toBeNull();
  });

  it("(c) close() tells every live hold the lease is gone, naming the keeper's real owner", async () => {
    const { dl } = rig();
    const a = must(await dl.acquire("e1"));
    const seen: LeaseLostError[] = [];
    a.onLost((e) => seen.push(e));
    await dl.close();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe("closed");
    expect(seen[0]?.owner).toBe(dl.keeper.owner);
    expect(a.valid()).toBe(false);
  });
});

describe("DriverLeases - the acquire/release race (S7c review P2-1a)", () => {
  it("a concurrent last-release cannot drop the lease out from under a pending acquire", async () => {
    const { dl, row } = rig();
    const first = must(await dl.acquire("e1"));
    const pending = dl.acquire("e1"); // registers its hold only after an await
    const released = first.release(); // the LAST registered hold goes in the same tick
    const second = must(await pending);
    await released;
    expect(second.valid()).toBe(true);
    expect(dl.keeper.validNow("e1")).toBe(true);
    expect(await row("e1")).not.toBeNull();
    await second.release();
    expect(await row("e1")).toBeNull();
  });

  it("a release deferred for a pending acquire still happens if that acquire fails", async () => {
    const { dl, store, row } = rig();
    const first = must(await dl.acquire("e1"));
    const keeperAcquire = dl.keeper.acquire.bind(dl.keeper);
    dl.keeper.acquire = (id: string) => keeperAcquire(id).then(() => false); // the pending one is refused
    const pending = dl.acquire("e1");
    await first.release();
    expect(await pending).toBeNull();
    // nobody holds it: it must not linger until the TTL (the deferred release is group-committed)
    for (let i = 0; i < 100 && (await row("e1")) !== null; i++)
      await new Promise((r) => setImmediate(r));
    expect(await row("e1")).toBeNull();
    expect(store).toBeDefined();
  });
});

describe("HeartbeatOptions.onStoreError (S7c review P2-3)", () => {
  it("'continue' is accepted: the keeper is heuristic and its owner carries the marker", () => {
    const { dl } = rig({ onStoreError: "continue" });
    expect(dl.keeper.heuristic).toBe(true);
    expect(isHeuristicOwner(dl.keeper.owner)).toBe(true);
    expect(isHeuristicOwner(rig().dl.keeper.owner)).toBe(false);
  });
  it("an unknown value is rejected", () => {
    expect(() => rig({ onStoreError: "sometimes" })).toThrow(TypeError);
  });
  it("'continue': a NEW driver whose acquire hits a store outage runs UNLEASED instead of failing; 'stop' rejects", async () => {
    const down = new InMemoryLeaseStore();
    down.acquire = async () => {
      throw new Error("lease store down");
    };
    down.acquireMany = async () => {
      throw new Error("lease store down");
    };
    const cont = rig({ onStoreError: "continue", leaseStore: down });
    const hold = await cont.dl.acquire("e1");
    expect(hold).not.toBeNull();
    expect(hold?.valid()).toBe(true);
    const stop = rig({ leaseStore: down });
    await expect(stop.dl.acquire("e1")).rejects.toThrow(/lease store down/);
  });
  it("'stop' and absent are accepted", () => {
    expect(() => rig({ onStoreError: "stop" })).not.toThrow();
    expect(() => rig()).not.toThrow();
  });
});

describe("DriverLeases - forget (S7d round 3)", () => {
  it("the last hold forgetting leaves the ROW to expire: not renewed, not valid, and it IS expired evidence after the TTL", async () => {
    const { dl, row, clock, store } = rig();
    const a = must(await dl.acquire("e1"));
    a.forget();
    expect(a.valid()).toBe(false);
    expect(dl.keeper.size).toBe(0);
    expect(await row("e1")).not.toBeNull();
    clock.wall += 31_000;
    clock.mono += 31_000;
    expect((await store.expired(clock.wall)).map((l) => l.executionId)).toContain("e1");
  });

  it("with another hold live, forget does not stop the lease; the intent applies when the LAST goes", async () => {
    const { dl, row } = rig();
    const a = must(await dl.acquire("e1"));
    const b = must(await dl.acquire("e1"));
    a.forget();
    expect(b.valid()).toBe(true);
    expect(dl.keeper.size).toBe(1);
    await b.release();
    expect(dl.keeper.size).toBe(0);
    expect(await row("e1")).not.toBeNull(); // forgotten, not deleted
  });

  it("forget is idempotent and a release afterwards is a no-op", async () => {
    const { dl, row } = rig();
    const a = must(await dl.acquire("e1"));
    a.forget();
    a.forget();
    await a.release();
    expect(await row("e1")).not.toBeNull();
  });

  it("a forget is not sticky: a later hold that releases normally deletes the row", async () => {
    const { dl, row } = rig();
    const a = must(await dl.acquire("e1"));
    a.forget();
    const b = must(await dl.acquire("e1"));
    expect(b.valid()).toBe(true);
    await b.release();
    expect(await row("e1")).toBeNull();
  });

  it("a forget while a concurrent acquire is pending defers to it and still forgets (row kept)", async () => {
    const { dl, row } = rig();
    const a = must(await dl.acquire("e1"));
    const pendingB = dl.acquire("e1"); // counted synchronously, mid-flight
    a.forget();
    const b = must(await pendingB);
    expect(b.valid()).toBe(true); // the pending acquire relied on the lease: it was not dropped
    await b.release(); // last hold, forget intent still stands
    expect(await row("e1")).not.toBeNull();
    expect(dl.keeper.size).toBe(0);
  });

  it("a lost lease clears the intent (the next driver's release deletes normally)", async () => {
    const { dl, row, takeOver, store, clock } = rig();
    const a = must(await dl.acquire("e1"));
    const b = must(await dl.acquire("e1"));
    a.forget();
    await takeOver("e1");
    expect(b.valid()).toBe(false);
    await store.release("e1", "other:node");
    clock.wall += 1;
    const c = must(await dl.acquire("e1"));
    await c.release();
    expect(await row("e1")).toBeNull();
  });
});
