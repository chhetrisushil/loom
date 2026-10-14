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
  private holdP: Promise<void> | undefined;
  /** The NEXT store call parks until the returned function is called. */
  holdNext(): () => void {
    let go!: () => void;
    this.holdP = new Promise<void>((r) => {
      go = r;
    });
    return go;
  }
  private async gate(): Promise<void> {
    if (this.failing) throw new Error("store down");
    const h = this.holdP;
    this.holdP = undefined;
    if (h) await h;
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
  const clock = { t: 1_000, skew: 0 };
  const timers: Array<{ fn: () => void; ms: number; stopped: boolean }> = [];
  const lost: Array<[string, LeaseLostError]> = [];
  const errors: unknown[] = [];
  const keeper = new LeaseKeeper({
    store,
    nodeId: "n1",
    incarnation: "u1",
    ttlMs: 30_000,
    monotonicNow: () => clock.t,
    wallNow: () => 1_700_000_000_000 + clock.t + clock.skew,
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

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error("until: condition never became true");
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

  describe("review fixes (S7b round 2)", () => {
    it("P1: acquire while the same id's release is IN FLIGHT waits for it (validNow implies a store row)", async () => {
      const { keeper, store } = rig(true);
      await keeper.acquire("x");
      const go = store.holdNext();
      const rel = keeper.release("x");
      await until(() => store.calls.includes("releaseMany:1"));
      const acq = keeper.acquire("x");
      go();
      await Promise.all([rel, acq]);
      expect(await acq).toBe(true);
      expect(keeper.validNow("x")).toBe(true);
      expect(store.held.has("x")).toBe(true);
    });

    it("P1: acquire while the same id's release is only QUEUED cancels the release (renewal)", async () => {
      const { keeper, store } = rig(true);
      await keeper.acquire("x");
      store.calls.length = 0;
      const rel = keeper.release("x");
      const acq = keeper.acquire("x");
      await Promise.all([rel, acq]);
      expect(await acq).toBe(true);
      expect(store.calls.some((c) => c.startsWith("releaseMany"))).toBe(false);
      expect(keeper.validNow("x")).toBe(true);
      expect(store.held.has("x")).toBe(true);
    });

    it("P1: release before an in-flight acquire resolves leaves nothing held and the row released", async () => {
      const { keeper, store, lost } = rig(true);
      const go = store.holdNext();
      const acq = keeper.acquire("a");
      await until(() => store.calls.includes("acquireMany:1"));
      const rel = keeper.release("a");
      go();
      expect(await acq).toBe(false);
      await rel;
      expect(keeper.size).toBe(0);
      expect(keeper.validNow("a")).toBe(false);
      expect(store.held.has("a")).toBe(false);
      await keeper.tick();
      expect(store.calls.some((c) => c.startsWith("renewMany"))).toBe(false);
      expect(lost).toEqual([]);
    });

    it("P3-10: a stale 'not held' renew after release + re-acquire does not fire taken-over", async () => {
      const { keeper, store, lost } = rig(true);
      await keeper.acquire("a");
      let answer!: () => void;
      const parked = new Promise<void>((r) => {
        answer = r;
      });
      (store as unknown as Record<string, unknown>).renewMany = async () => {
        await parked;
        return [] as string[];
      };
      const t = keeper.tick();
      await keeper.release("a");
      expect(await keeper.acquire("a")).toBe(true);
      answer();
      await t;
      expect(lost).toEqual([]);
      expect(keeper.validNow("a")).toBe(true);
    });

    it("P2-2: a held renew answered after the deadline is a deadline loss, reported once", async () => {
      const { keeper, store, clock, lost } = rig(true);
      await keeper.acquire("a"); // deadline 26_000
      clock.t = 11_000;
      const go = store.holdNext();
      const t = keeper.tick();
      await until(() => store.calls.includes("renewMany:1"));
      clock.t = 27_000;
      go();
      await t;
      expect(keeper.validNow("a")).toBe(false);
      expect(lost.map(([id, e]) => [id, e.reason])).toEqual([["a", "deadline"]]);
    });

    it("P2-2: validNow reports the expiry transition itself, exactly once", async () => {
      const { keeper, clock, lost, watchdog } = rig(true);
      await keeper.acquire("a");
      clock.t = 26_000;
      expect(keeper.validNow("a")).toBe(false);
      expect(lost.map(([, e]) => e.reason)).toEqual(["deadline"]);
      expect(keeper.validNow("a")).toBe(false);
      watchdog.fn();
      expect(lost).toHaveLength(1);
      expect(keeper.size).toBe(0);
    });

    it("P2-3: a failing later chunk does not reject or leak the earlier granted chunk", async () => {
      const { keeper, store } = rig(true, { chunkSize: 1 });
      const self = store as unknown as Record<string, unknown>;
      self.acquireMany = async (ids: string[]) => {
        if (ids.includes("b")) throw new Error("boom");
        return ids.map((id) => {
          store.held.add(id);
          return { executionId: id, owner: "o", expiresAt: 0 };
        });
      };
      const [a, b] = await Promise.allSettled([keeper.acquire("a"), keeper.acquire("b")]);
      expect(a).toEqual({ status: "fulfilled", value: true });
      expect(b.status).toBe("rejected");
      expect(keeper.validNow("a")).toBe(true);
      expect(store.held.has("a")).toBe(true);
      expect(keeper.validNow("b")).toBe(false);
    });

    it("P2-4: one bad id in a coalesced batch rejects only that id and arms no quiet period", async () => {
      const { keeper, store } = rig(true);
      const self = store as unknown as Record<string, unknown>;
      self.acquireMany = async (ids: string[]) => {
        if (ids.includes("bad")) throw new Error("invalid byte sequence");
        return ids.map((id) => {
          store.held.add(id);
          return { executionId: id, owner: "o", expiresAt: 0 };
        });
      };
      const rs = await Promise.allSettled(["a", "bad", "c"].map((i) => keeper.acquire(i)));
      expect(rs.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      expect(keeper.size).toBe(2);
      expect(await keeper.acquire("d")).toBe(true); // not quiet
    });

    describe("round 3 (P3 fixes)", () => {
      const failingIds = (store: FakeStore, bad: Set<string>, mk: (id: string) => Error) => {
        (store as unknown as Record<string, unknown>).acquireMany = async (ids: string[]) => {
          for (const id of ids) if (bad.has(id)) throw mk(id);
          return ids.map((id) => {
            store.held.add(id);
            return { executionId: id, owner: "o", expiresAt: 0 };
          });
        };
      };

      it("P3-a: a lone id-specific error rejects only that id; the next id still acquires", async () => {
        const { keeper, store } = rig(true);
        failingIds(store, new Set(["bad"]), () => new Error("value too long for type"));
        await expect(keeper.acquire("bad")).rejects.toThrow(/too long/);
        expect(await keeper.acquire("good")).toBe(true);
      });

      it("P3-a: a connectivity-class error is store-wide and arms the quiet period", async () => {
        for (const mk of [
          () => Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
          () => Object.assign(new Error("terminating connection"), { code: "57P01" }),
          () => Object.assign(new Error("db locked"), { code: "SQLITE_BUSY" }),
          () => new Error("timeout exceeded when trying to connect"),
          () =>
            new Error("outer", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }),
        ]) {
          const { keeper, store } = rig(true);
          failingIds(store, new Set(["a"]), mk);
          await expect(keeper.acquire("a")).rejects.toBeDefined();
          await expect(keeper.acquire("b")).rejects.toBeInstanceOf(LeaseStoreQuietError);
        }
      });

      it("P3-a: lone failures on two consecutive flushes with DIFFERENT ids arm the quiet period", async () => {
        const { keeper, store } = rig(true);
        failingIds(store, new Set(["bad1", "bad2"]), () => new Error("constraint violated"));
        await expect(keeper.acquire("bad1")).rejects.toThrow();
        await expect(keeper.acquire("bad2")).rejects.toThrow();
        await expect(keeper.acquire("good")).rejects.toBeInstanceOf(LeaseStoreQuietError);
      });

      it("P3-a: the same id failing twice, or a clean flush between, does not arm", async () => {
        const { keeper, store } = rig(true);
        failingIds(store, new Set(["bad1", "bad2"]), () => new Error("constraint violated"));
        await expect(keeper.acquire("bad1")).rejects.toThrow();
        await expect(keeper.acquire("bad1")).rejects.toThrow();
        expect(await keeper.acquire("ok")).toBe(true);
        await expect(keeper.acquire("bad2")).rejects.toThrow();
        expect(await keeper.acquire("good")).toBe(true);
      });

      it("P3-b: a grant answered after its own deadline is not held, resolves false, and is released", async () => {
        const { keeper, store, clock, lost } = rig(true);
        const go = store.holdNext();
        const acq = keeper.acquire("a");
        await until(() => store.calls.includes("acquireMany:1"));
        clock.t += 26_000; // ttl - margin
        go();
        expect(await acq).toBe(false);
        expect(keeper.size).toBe(0);
        expect(keeper.validNow("a")).toBe(false);
        await until(() => store.calls.includes("releaseMany:1"));
        expect(store.held.has("a")).toBe(false);
        expect(lost).toEqual([]); // never held, so never lost
      });

      it("P3-c: a release() while an acquire is parked behind an on-the-wire release stays effective", async () => {
        const { keeper, store, lost } = rig(true);
        await keeper.acquire("x");
        const go = store.holdNext();
        const rel1 = keeper.release("x");
        await until(() => store.calls.includes("releaseMany:1"));
        const acq = keeper.acquire("x"); // parks behind the wire
        const rel2 = keeper.release("x"); // must withdraw it and stay effective
        expect(await acq).toBe(false);
        go();
        await Promise.all([rel1, rel2]);
        expect(keeper.validNow("x")).toBe(false);
        expect(keeper.size).toBe(0);
        expect(store.held.has("x")).toBe(false);
        await keeper.tick();
        expect(lost).toEqual([]);
        expect(store.calls.filter((c) => c.startsWith("acquireMany")).length).toBe(1);
      });
    });

    it("P2-4: a NUL / empty / non-string id is rejected up front with a TypeError and no store call", async () => {
      const { keeper, store } = rig(true);
      await expect(keeper.acquire("a\u0000b")).rejects.toBeInstanceOf(TypeError);
      await expect(keeper.acquire("")).rejects.toBeInstanceOf(TypeError);
      await expect(keeper.acquire(7 as unknown as string)).rejects.toBeInstanceOf(TypeError);
      expect(store.calls).toEqual([]);
      expect(await keeper.acquire("ok")).toBe(true);
    });

    it("P2-5: a host suspend (monotonic stalls, wall clock advances) invalidates the lease", async () => {
      const { keeper, clock, lost } = rig(true);
      await keeper.acquire("a");
      clock.skew += 26_000; // wall moved on; clock.t (monotonic) did not
      expect(keeper.validNow("a")).toBe(false);
      expect(lost.map(([, e]) => e.reason)).toEqual(["deadline"]);
    });

    // The two anchors are tested apart: "mono" freezes the wall clock, "wall" freezes the
    // monotonic one, so neither can mask a mutation that anchors the other at the response.
    for (const mode of ["mono", "wall"] as const) {
      const make = () =>
        mode === "mono" ? rig(true, { wallNow: () => 9_000_000_000_000 }) : rig(true);
      const pass = (r: ReturnType<typeof rig>, ms: number) => {
        if (mode === "mono") r.clock.t += ms;
        else r.clock.skew += ms;
      };
      const setElapsed = (r: ReturnType<typeof rig>, sendT: number, ms: number) => {
        if (mode === "mono") r.clock.t = sendT + ms;
        else r.clock.skew = ms;
      };

      it(`P2-6 (${mode}): acquire deadline is anchored at the SEND, not the response`, async () => {
        const r = make();
        const go = r.store.holdNext();
        const p = r.keeper.acquire("a"); // sent at t=1000
        await until(() => r.store.calls.includes("acquireMany:1"));
        pass(r, 8_000);
        go();
        expect(await p).toBe(true);
        setElapsed(r, 1_000, 24_999);
        expect(r.keeper.validNow("a")).toBe(true);
        setElapsed(r, 1_000, 25_000);
        expect(r.keeper.validNow("a")).toBe(false);
      });

      it(`P2-6 (${mode}): renew deadline is anchored at the SEND, not the response`, async () => {
        const r = make();
        await r.keeper.acquire("a");
        r.clock.t = 11_000;
        const go = r.store.holdNext();
        const t = r.keeper.tick(); // sent at 11_000
        await until(() => r.store.calls.includes("renewMany:1"));
        pass(r, 8_000);
        go();
        await t;
        setElapsed(r, 11_000, 24_999);
        expect(r.keeper.validNow("a")).toBe(true);
        setElapsed(r, 11_000, 25_000);
        expect(r.keeper.validNow("a")).toBe(false);
      });
    }

    it("P3-7: close during an in-flight acquire releases the granted row", async () => {
      const { keeper, store } = rig(true);
      const go = store.holdNext();
      const p = keeper.acquire("a");
      await until(() => store.calls.includes("acquireMany:1"));
      const c = keeper.close();
      go();
      expect(await p).toBe(false);
      await c;
      expect(store.held.has("a")).toBe(false);
      expect(keeper.size).toBe(0);
    });

    it("P3-8: invalid options are a TypeError", () => {
      const mk = (o: Partial<LeaseKeeperOptions>) => () => rig(true, o);
      expect(mk({ chunkSize: 0 })).toThrow(TypeError);
      expect(mk({ chunkSize: 1.5 })).toThrow(TypeError);
      expect(mk({ ttlMs: 0 })).toThrow(TypeError);
      expect(mk({ ttlMs: Number.POSITIVE_INFINITY })).toThrow(TypeError);
      expect(mk({ renewEveryMs: 0 })).toThrow(TypeError);
      expect(mk({ renewEveryMs: 25_000 })).toThrow(TypeError); // must be < ttl - margin
      expect(mk({ renewEveryMs: 24_999 })).not.toThrow();
    });
  });
});
