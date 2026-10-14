import type { Lease, LeaseStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import {
  LeaseKeeper,
  type LeaseKeeperOptions,
  LeaseLostError,
  LeaseStoreQuietError,
} from "./leaseKeeper";

// A scriptable store: counts calls, can be made to fail, hang, or report ids as lost. No timers.
class FakeStore implements LeaseStore {
  calls: string[] = [];
  held = new Set<string>(); // ids this store will report held
  taken = new Set<string>(); // ids another owner holds
  failing = false;
  hang = false;
  batch: boolean;
  constructor(batch: boolean) {
    this.batch = batch;
    if (batch) {
      const self = this as unknown as Record<string, unknown>;
      self.acquireMany = async (ids: string[]) => {
        this.calls.push(`acquireMany:${ids.length}`);
        await this.gate();
        return ids.filter((i) => !this.taken.has(i)).map((i) => this.grant(i));
      };
      self.renewMany = async (ids: string[]) => {
        this.calls.push(`renewMany:${ids.length}`);
        await this.gate();
        return ids.filter((i) => this.held.has(i) && !this.taken.has(i));
      };
      self.releaseMany = async (ids: string[]) => {
        this.calls.push(`releaseMany:${ids.length}`);
        await this.gate();
        for (const i of ids) this.held.delete(i);
      };
    }
  }
  private async gate(): Promise<void> {
    if (this.failing) throw new Error("store down");
    if (this.hang) await new Promise(() => {});
  }
  private grant(id: string): Lease {
    this.held.add(id);
    return { executionId: id, owner: "o", expiresAt: 0 };
  }
  async acquire(id: string): Promise<Lease | null> {
    this.calls.push("acquire");
    await this.gate();
    return this.taken.has(id) ? null : this.grant(id);
  }
  async renew(id: string): Promise<boolean> {
    this.calls.push("renew");
    await this.gate();
    return this.held.has(id) && !this.taken.has(id);
  }
  async expired(): Promise<Lease[]> {
    return [];
  }
  async release(id: string): Promise<void> {
    this.calls.push("release");
    await this.gate();
    this.held.delete(id);
  }
  async close(): Promise<void> {}
}

function rig(batch: boolean, over: Partial<LeaseKeeperOptions> = {}) {
  const store = new FakeStore(batch);
  const clock = { t: 1_000 };
  const timers: Array<{ fn: () => void; ms: number; stopped: boolean }> = [];
  const lost: Array<[string, LeaseLostError]> = [];
  const errors: unknown[] = [];
  const keeper = new LeaseKeeper({
    store,
    nodeId: "n1",
    incarnation: "u1",
    ttlMs: 30_000,
    monotonicNow: () => clock.t,
    every: (fn, ms) => {
      const t = { fn, ms, stopped: false };
      timers.push(t);
      return () => {
        t.stopped = true;
      };
    },
    onLost: (id, err) => lost.push([id, err]),
    onError: (e) => errors.push(e),
    ...over,
  });
  const renewTimer = timers[0] as (typeof timers)[number];
  const watchdog = timers[1] as (typeof timers)[number];
  return { store, clock, timers, lost, errors, keeper, renewTimer, watchdog };
}

describe("LeaseKeeper", () => {
  it("derives owner and default cadence from nodeId, incarnation, ttl", () => {
    const { keeper, renewTimer, watchdog } = rig(true);
    expect(keeper.owner).toBe("n1:u1");
    expect(renewTimer.ms).toBe(10_000);
    expect(watchdog.ms).toBe(2_500);
  });

  it("group-commits concurrent acquires into ONE acquireMany", async () => {
    const { keeper, store } = rig(true);
    const results = await Promise.all(["a", "b", "c", "a"].map((id) => keeper.acquire(id)));
    expect(results).toEqual([true, true, true, true]);
    expect(store.calls).toEqual(["acquireMany:3"]);
    expect(keeper.size).toBe(3);
  });

  it("resolves false for an id another owner holds and does not track it", async () => {
    const { keeper, store } = rig(true);
    store.taken.add("b");
    expect(await Promise.all([keeper.acquire("a"), keeper.acquire("b")])).toEqual([true, false]);
    expect(keeper.validNow("b")).toBe(false);
    expect(keeper.size).toBe(1);
  });

  it("renews N ids with ONE store call per tick and extends the deadline from the send time", async () => {
    const { keeper, store, clock } = rig(true);
    const ids = Array.from({ length: 50 }, (_, i) => `e${i}`);
    await Promise.all(ids.map((i) => keeper.acquire(i)));
    store.calls.length = 0;
    clock.t += 10_000;
    await keeper.tick();
    expect(store.calls).toEqual(["renewMany:50"]);
    // deadline = 11_000 + 30_000 - 5_000 = 36_000
    clock.t = 35_999;
    expect(keeper.validNow("e0")).toBe(true);
    clock.t = 36_000;
    expect(keeper.validNow("e0")).toBe(false);
  });

  it("chunks a large renew", async () => {
    const { keeper, store } = rig(true, { chunkSize: 2 });
    await Promise.all(["a", "b", "c"].map((i) => keeper.acquire(i)));
    store.calls.length = 0;
    await keeper.tick();
    expect(store.calls.sort()).toEqual(["renewMany:1", "renewMany:2"]);
  });

  it("an id missing from the renewed held set fires onLost and is forgotten", async () => {
    const { keeper, store, lost } = rig(true);
    await Promise.all(["a", "b"].map((i) => keeper.acquire(i)));
    store.taken.add("b");
    await keeper.tick();
    expect(lost.map(([id, e]) => [id, e.reason])).toEqual([["b", "taken-over"]]);
    expect(keeper.validNow("b")).toBe(false);
    expect(keeper.validNow("a")).toBe(true);
    expect(keeper.size).toBe(1);
    await keeper.tick();
    expect(lost).toHaveLength(1); // fires once
  });

  it("self-fences at the deadline even when the store never answers", async () => {
    const { keeper, store, clock, lost, watchdog } = rig(true);
    await keeper.acquire("a");
    store.hang = true;
    clock.t += 10_000;
    void keeper.tick(); // never settles
    clock.t += 14_999; // 24_999 after acquire: deadline is 25_000
    watchdog.fn();
    expect(lost).toHaveLength(0);
    expect(keeper.validNow("a")).toBe(true);
    clock.t += 1;
    expect(keeper.validNow("a")).toBe(false); // the gate is exact, no timer needed
    watchdog.fn();
    expect(lost).toHaveLength(1);
    expect(lost.map(([id]) => id)).toEqual(["a"]);
    expect(lost[0]?.[1]).toBeInstanceOf(LeaseLostError);
    expect(lost[0]?.[1].reason).toBe("deadline");
    expect(keeper.size).toBe(0);
  });

  it("a stall longer than the TTL is lost on the first tick after it, before any renew result counts", async () => {
    const { keeper, store, clock, lost } = rig(true);
    await keeper.acquire("a");
    clock.t += 120_000; // SIGSTOP / GC pause
    expect(keeper.validNow("a")).toBe(false);
    await keeper.tick();
    expect(lost.map(([id, e]) => [id, e.reason])).toEqual([["a", "deadline"]]);
    expect(store.calls).toEqual(["acquireMany:1"]); // lost ids are not renewed
  });

  it("a store error opens a quiet period of one TTL: no acquire attempts, renew failures still age the deadline", async () => {
    const { keeper, store, clock, lost, errors } = rig(true);
    await keeper.acquire("a");
    store.failing = true;
    clock.t += 10_000;
    await keeper.tick();
    expect(errors).toHaveLength(1);
    store.calls.length = 0;
    await expect(keeper.acquire("z")).rejects.toBeInstanceOf(LeaseStoreQuietError);
    await expect(keeper.acquire("y")).rejects.toBeInstanceOf(LeaseStoreQuietError);
    expect(store.calls).toEqual([]); // no storm
    clock.t += 15_000;
    await keeper.tick(); // deadline (25_000 after acquire) reached despite repeated errors
    expect(lost.map(([, e]) => e.reason)).toEqual(["deadline"]);
    clock.t += 30_000;
    store.failing = false;
    expect(await keeper.acquire("z")).toBe(true);
  });

  it("an acquire error rejects every caller in the batch and starts the quiet period", async () => {
    const { keeper, store } = rig(true);
    store.failing = true;
    const rs = await Promise.allSettled([keeper.acquire("a"), keeper.acquire("b")]);
    expect(rs.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await expect(keeper.acquire("c")).rejects.toBeInstanceOf(LeaseStoreQuietError);
  });

  it("release is awaited, group-committed, drops the id, and fires no onLost", async () => {
    const { keeper, store, lost } = rig(true);
    await Promise.all(["a", "b", "c"].map((i) => keeper.acquire(i)));
    store.calls.length = 0;
    await Promise.all([keeper.release("a"), keeper.release("b")]);
    expect(store.calls).toEqual(["releaseMany:2"]);
    expect(keeper.size).toBe(1);
    expect(keeper.validNow("a")).toBe(false);
    await keeper.tick();
    expect(lost).toEqual([]);
    expect(store.calls.at(-1)).toBe("renewMany:1");
  });

  it("a failing release resolves and is reported, not thrown", async () => {
    const { keeper, store, errors } = rig(true);
    await keeper.acquire("a");
    store.failing = true;
    await expect(keeper.release("a")).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("close releases everything, stops the timers, rejects later acquires", async () => {
    const { keeper, store, timers } = rig(true);
    await Promise.all(["a", "b"].map((i) => keeper.acquire(i)));
    store.calls.length = 0;
    await keeper.close();
    expect(store.calls).toEqual(["releaseMany:2"]);
    expect(store.held.size).toBe(0);
    expect(timers.every((t) => t.stopped)).toBe(true);
    expect(keeper.size).toBe(0);
    await expect(keeper.acquire("a")).rejects.toThrow(/closed/);
    await keeper.close(); // idempotent
  });

  it("falls back to single-id calls on a store without batch methods", async () => {
    const { keeper, store, lost } = rig(false);
    expect(await Promise.all(["a", "b"].map((i) => keeper.acquire(i)))).toEqual([true, true]);
    expect(store.calls).toEqual(["acquire", "acquire"]);
    store.calls.length = 0;
    store.taken.add("b");
    await keeper.tick();
    expect(store.calls).toEqual(["renew", "renew"]);
    expect(lost.map(([id]) => id)).toEqual(["b"]);
    store.calls.length = 0;
    await keeper.close();
    expect(store.calls).toEqual(["release"]);
  });

  it("does not stack renews against a hung store", async () => {
    const { keeper, store } = rig(true);
    await keeper.acquire("a");
    store.calls.length = 0;
    store.hang = true;
    for (let i = 0; i < 10; i++) void keeper.tick();
    await Promise.resolve();
    expect(store.calls.length).toBeLessThanOrEqual(3);
  });
});
