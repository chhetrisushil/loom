import type { EventEnvelope } from "@loom/core";
import type { EventStore, InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { ExecutionJournal } from "./ExecutionJournal";
import { TimerService } from "./TimerService";
import { until } from "./__tests__/r2Harness";
import { FAR, type Stuck, TTL, countResumes, stuck } from "./__tests__/s7dRig";
import { collectGhostLeases } from "./leaseEvidence";
import { HEURISTIC_OWNER_SUFFIX, isHeuristicOwner } from "./leaseKeeper";
import { recoverAbandoned } from "./recoverAbandoned";

// ADR 0130 D11 (S7d): the CONSUMERS of heartbeat leases. The D10 poll re-drives by default on an
// expired lease in a cluster-visible store; an unexpired lease VETOES any `isAbandoned` heuristic
// (poll and sweep); the takeover is conditional on the log not having moved; ghost leases are
// garbage-collected; `onStoreError: "continue"` makes a node's leases heuristic. Node A drives and is
// stuck in a latched step; the lease clock is hand-driven, so nothing waits on wall time.

const lapse = (s: Stuck): void => {
  s.clock.wall += TTL + 1;
  s.clock.mono += TTL + 1;
};

const status = async (s: Stuck, rt: Stuck["a"]["rt"]) => (await rt.loadState(s.e))?.status;

/** Poll until `done` (each poll is deterministic; the loop only waits for the async settle). */
async function pollUntil(svc: TimerService, done: () => Promise<boolean>): Promise<void> {
  await until(async () => {
    await svc.tick(FAR);
    return done();
  });
}

describe("poll: lease veto (D11 section 4, closes the S6 silent-live-driver residual)", () => {
  it("an UNEXPIRED lease vetoes isAbandoned: () => true on the poll; once it lapses the row is re-driven", async () => {
    const s = await stuck();
    const c = s.node("c");
    const resumes = countResumes(c.rt);
    const errors: unknown[] = [];
    const svc = new TimerService(c.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
      onError: (_i, e) => errors.push(e),
    });
    for (let i = 0; i < 3; i++) await svc.tick(FAR);
    expect(resumes.n).toBe(0);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
    expect(await s.rows()).toHaveLength(1);
    expect(errors).toEqual([]);
    lapse(s);
    await pollUntil(svc, async () => (await status(s, c.rt)) === "completed");
    expect(resumes.n).toBe(1);
  });

  it("an UNEXPIRED lease vetoes isAbandoned on the recoverAbandoned sweep too", async () => {
    const s = await stuck();
    const c = s.node("c");
    const sum = await recoverAbandoned(c.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
      fenced: true,
    });
    expect(sum.candidates).toBe(1);
    expect(sum.recovered).toBe(0);
    expect(sum.failed).toBe(0); // vetoed up front, not refused by the driver's stand-down
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
    lapse(s);
    const after = await recoverAbandoned(c.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
      fenced: true,
    });
    expect(after.recovered).toBe(1);
  });
});

describe("poll: default re-drive on an expired lease (D11 section 7, S7e note)", () => {
  it("heartbeat on + cluster-visible store: an EXPIRED lease is evidence with NO isAbandoned, one marker, one resume", async () => {
    const s = await stuck();
    const c = s.node("c");
    const resumes = countResumes(c.rt);
    const svc = new TimerService(c.rt, s.raw.timers, { fenced: true });
    await svc.tick(FAR); // A's lease is still live: nothing happens
    expect(resumes.n).toBe(0);
    lapse(s);
    await pollUntil(svc, async () => (await status(s, c.rt)) === "completed");
    expect(resumes.n).toBe(1);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(1); // the conditional claim IS the marker
    await until(async () => (await s.rows()).length === 0);
  });

  it("NOT cluster-visible (scope process): an expired lease is no evidence by default; isAbandoned still re-drives", async () => {
    const s = await stuck({ scope: "process" });
    const c = s.node("c");
    const resumes = countResumes(c.rt);
    lapse(s);
    const bare = new TimerService(c.rt, s.raw.timers, { fenced: true });
    for (let i = 0; i < 3; i++) await bare.tick(FAR);
    expect(resumes.n).toBe(0);
    expect(await s.rows()).toHaveLength(1);
    const withHeuristic = new TimerService(c.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
    });
    await pollUntil(withHeuristic, async () => (await status(s, c.rt)) === "completed");
    expect(resumes.n).toBe(1);
  });

  it("heartbeat disabled on the poller: behaviour is today's (no default re-drive)", async () => {
    const s = await stuck();
    const c = s.node("c", { heartbeat: null });
    lapse(s);
    const resumes = countResumes(c.rt);
    const svc = new TimerService(c.rt, s.raw.timers, { fenced: true });
    for (let i = 0; i < 3; i++) await svc.tick(FAR);
    expect(resumes.n).toBe(0);
  });

  it("isAbandoned narrows the default evidence (both must hold), as in the sweep", async () => {
    const s = await stuck();
    const c = s.node("c");
    lapse(s);
    let verdict = false;
    const resumes = countResumes(c.rt);
    const svc = new TimerService(c.rt, s.raw.timers, { fenced: true, isAbandoned: () => verdict });
    for (let i = 0; i < 2; i++) await svc.tick(FAR);
    expect(resumes.n).toBe(0);
    verdict = true;
    await pollUntil(svc, async () => (await status(s, c.rt)) === "completed");
    expect(resumes.n).toBe(1);
  });
});

describe("mixed fleet: a legacy (unleased) driver is never re-driven by lease evidence", () => {
  it("no lease row at all: the cluster-visible poll does nothing by default; isAbandoned alone re-drives, as before S7", async () => {
    const s = await stuck({ aHeartbeat: null });
    const c = s.node("c");
    expect(await s.leases.get?.(s.e)).toBeNull();
    lapse(s);
    const resumes = countResumes(c.rt);
    const bare = new TimerService(c.rt, s.raw.timers, { fenced: true });
    for (let i = 0; i < 3; i++) await bare.tick(FAR);
    expect(resumes.n).toBe(0);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
    const heuristic = new TimerService(c.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
    });
    await pollUntil(heuristic, async () => (await status(s, c.rt)) === "completed");
    expect(resumes.n).toBe(1);
  });

  it("the sweep's lease mode never sees a legacy driver (no lease to be expired)", async () => {
    const s = await stuck({ aHeartbeat: null });
    const c = s.node("c");
    lapse(s);
    const sum = await recoverAbandoned(c.rt, {
      leases: { store: s.leases, owner: "c" },
      fenced: true,
    });
    expect(sum.recovered).toBe(0);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
  });
});

describe("fail closed on lease-store errors in the re-drive path", () => {
  function faulty(s: Stuck) {
    const flag = { on: false, reads: 0 };
    const store = Object.create(s.leases) as InMemoryLeaseStore;
    store.get = async (id: string) => {
      flag.reads++;
      if (flag.on) throw new Error("lease store down");
      return s.leases.get?.(id) ?? null;
    };
    store.expired = async (...a: Parameters<InMemoryLeaseStore["expired"]>) => {
      if (flag.on) throw new Error("lease store down");
      return s.leases.expired(...a);
    };
    return { flag, store };
  }

  it("poll: an error reading the lease re-drives nothing and reports; after healing it waits one TTL (quiet period), then acts", async () => {
    const s = await stuck();
    const f = faulty(s);
    const c = s.node("c", { heartbeat: { leaseStore: f.store } });
    lapse(s);
    const errors: unknown[] = [];
    const resumes = countResumes(c.rt);
    const svc = new TimerService(c.rt, s.raw.timers, {
      fenced: true,
      onError: (_i, e) => errors.push(e),
    });
    f.flag.on = true;
    for (let i = 0; i < 3; i++) await svc.tick(FAR);
    expect(resumes.n).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(await s.rows()).toHaveLength(1); // the row is KEPT, not spent against the attempt cap
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
    // healed: the first successful read opens the quiet period; an expired row is not yet evidence
    f.flag.on = false;
    for (let i = 0; i < 3; i++) await svc.tick(FAR);
    expect(resumes.n).toBe(0);
    s.clock.mono += TTL + 1;
    s.clock.wall += TTL + 1;
    await pollUntil(svc, async () => (await status(s, c.rt)) === "completed");
    expect(resumes.n).toBe(1);
  });

  it("sweep: an error reading the lease skips the execution (failed, reported), never re-drives", async () => {
    const s = await stuck();
    const f = faulty(s);
    const c = s.node("c", { heartbeat: { leaseStore: f.store } });
    lapse(s);
    f.flag.on = true;
    const errors: unknown[] = [];
    const sum = await recoverAbandoned(c.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
      fenced: true,
      onError: (_i, e) => errors.push(e),
    });
    expect(sum.recovered).toBe(0);
    expect(sum.failed).toBe(1);
    expect(errors).toHaveLength(1);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
  });
});

describe("conditional takeover (D11 section 4 step 4): a live append wins", () => {
  /** A store view that, right after the FIRST observation, lets a "live driver" append. */
  function racing(s: Stuck) {
    const inner = s.raw.eventStore as InMemoryAsyncEventStore;
    const calls = { acquireFence: 0, raced: false };
    const store = new Proxy(inner, {
      get(t, p) {
        if (p === "appendIfUnchanged") {
          return async (...args: Parameters<NonNullable<EventStore["appendIfUnchanged"]>>) => {
            const r = await t.appendIfUnchanged(...args);
            if (args[1] === null && !calls.raced) {
              calls.raced = true;
              const head = (await t.head?.(s.e)) as number;
              await t.append(
                ExecutionJournal.envelopeAt(
                  { executionId: s.e, workflowId: "h" },
                  head + 1,
                  "LIVE_DRIVER_APPEND",
                  {},
                  {}
                ) as EventEnvelope
              );
            }
            return r;
          };
        }
        if (p === "acquireFence") {
          return (...args: [string]) => {
            calls.acquireFence++;
            return t.acquireFence?.(...args);
          };
        }
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as unknown as EventStore;
    return { store, calls };
  }

  it("sweep: the observation->claim gap loses to a live append: no marker, no fence taken, nothing recovered", async () => {
    const s = await stuck();
    const r = racing(s);
    const c = s.node("c", { eventStore: r.store });
    lapse(s);
    const sum = await recoverAbandoned(c.rt, {
      source: r.store,
      isAbandoned: () => true,
      fenced: true,
    });
    expect(r.calls.raced).toBe(true);
    expect(sum.recovered).toBe(0);
    expect(sum.failed).toBe(0);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
    expect(r.calls.acquireFence).toBe(0);
  });

  it("poll: the same loss leaves the row for the next poll and takes no fence", async () => {
    const s = await stuck();
    const r = racing(s);
    const c = s.node("c", { eventStore: r.store });
    lapse(s);
    const resumes = countResumes(c.rt);
    const svc = new TimerService(c.rt, s.raw.timers, { fenced: true });
    await svc.tick(FAR);
    expect(r.calls.raced).toBe(true);
    expect(resumes.n).toBe(0);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
    expect(r.calls.acquireFence).toBe(0);
  });
});

describe("ghost leases (a lease with no stream) are garbage-collected, bounded, never re-driven", () => {
  it("the poll deletes an EXPIRED ghost; a real orphan's lease, a fresh (starting) lease and the stream are left alone", async () => {
    const s = await stuck();
    await s.raw.timers.complete(s.e, 1); // isolate: no refusal row for the real execution
    const c = s.node("c");
    await s.leases.acquire("ghost-1", "dead:1", TTL, s.clock.wall);
    await s.leases.acquire("ghost-2", "dead:2", TTL, s.clock.wall);
    lapse(s);
    await s.leases.acquire("starting-1", "other:1", TTL, s.clock.wall); // unexpired: a start in flight
    const resumes = countResumes(c.rt);
    await new TimerService(c.rt, s.raw.timers, { fenced: true }).tick(FAR);
    expect(await s.leases.get?.("ghost-1")).toBeNull();
    expect(await s.leases.get?.("ghost-2")).toBeNull();
    expect(await s.leases.get?.("starting-1")).not.toBeNull();
    expect(await s.leases.get?.(s.e)).not.toBeNull(); // a stream exists: this is an orphan, not a ghost
    expect(resumes.n).toBe(0);
    expect(await c.rt.hasSequenceZero("ghost-1")).toBe(false); // GC created nothing
  });

  it("collectGhostLeases is bounded by `limit`", async () => {
    const s = await stuck();
    const c = s.node("c");
    for (const g of ["g1", "g2", "g3"]) await s.leases.acquire(g, "dead:1", TTL, s.clock.wall);
    lapse(s);
    // soonest-expired first: A's real orphan lease, then g1, g2 -> `limit` bounds what is EXAMINED
    expect(await collectGhostLeases(c.rt, { limit: 3 })).toBe(2);
    expect(await s.leases.get?.("g1")).toBeNull();
    expect(await s.leases.get?.("g2")).toBeNull();
    expect(await s.leases.get?.("g3")).not.toBeNull();
    expect(await collectGhostLeases(c.rt, { limit: 3 })).toBe(1);
    expect(await s.leases.get?.("g3")).toBeNull();
    expect(await s.leases.get?.(s.e)).not.toBeNull();
  });

  it("a node without heartbeat collects nothing", async () => {
    const s = await stuck();
    const c = s.node("c", { heartbeat: null });
    await s.leases.acquire("g1", "dead:1", TTL, s.clock.wall);
    lapse(s);
    expect(await collectGhostLeases(c.rt, { limit: 5 })).toBe(0);
    expect(await s.leases.get?.("g1")).not.toBeNull();
  });
});

describe('onStoreError: "continue" (D11 section 6)', () => {
  it("a driver keeps running through a lease-store outage past its deadline; its owner is marked heuristic", async () => {
    const s = await stuck({ aHeartbeat: { onStoreError: "continue" } });
    const keeper = s.a.rt.leaseKeeper;
    expect(keeper).toBeDefined();
    expect(isHeuristicOwner(keeper?.owner ?? "")).toBe(true);
    expect(keeper?.owner.endsWith(HEURISTIC_OWNER_SUFFIX)).toBe(true);
    s.outage.on = true;
    lapse(s); // well past lastRenew + TTL - margin
    await keeper?.tick();
    expect(keeper?.validNow(s.e)).toBe(true);
    s.latchA.release();
    const out = await s.aHandle.waitForCompletion();
    expect(out.status).toBe("completed");
  });

  it('contrast: with "stop" the same outage aborts the driver at its deadline (LeaseLostError)', async () => {
    const s = await stuck();
    s.outage.on = true;
    lapse(s);
    await s.a.rt.leaseKeeper?.tick();
    expect(s.a.rt.leaseKeeper?.validNow(s.e)).toBe(false);
    s.latchA.release();
    await expect(s.aHandle.waitForCompletion()).rejects.toThrow(/lease lost/);
  });

  it("a taken-over lease still stops a continue driver (the outage carve-out is only the deadline)", async () => {
    const s = await stuck({ aHeartbeat: { onStoreError: "continue" } });
    await s.leases.release(s.e, s.a.rt.leaseKeeper?.owner ?? "");
    await s.leases.acquire(s.e, "other:1", TTL, s.clock.wall);
    await s.a.rt.leaseKeeper?.tick();
    expect(s.a.rt.leaseKeeper?.validNow(s.e)).toBe(false);
  });

  it("its expired leases are NOT evidence: a stop-mode cluster poller does not re-drive by default, only with isAbandoned", async () => {
    const s = await stuck({ aHeartbeat: { onStoreError: "continue" } });
    const c = s.node("c");
    lapse(s);
    const resumes = countResumes(c.rt);
    const bare = new TimerService(c.rt, s.raw.timers, { fenced: true });
    for (let i = 0; i < 3; i++) await bare.tick(FAR);
    expect(resumes.n).toBe(0);
    const heuristic = new TimerService(c.rt, s.raw.timers, {
      fenced: true,
      isAbandoned: () => true,
    });
    await pollUntil(heuristic, async () => (await status(s, c.rt)) === "completed");
    expect(resumes.n).toBe(1);
  });

  it("a continue-mode POLLER treats the whole fleet as heuristic: no default re-drive even on a stop-owner's expired lease", async () => {
    const s = await stuck();
    const c = s.node("c", { heartbeat: { onStoreError: "continue" } });
    lapse(s);
    const resumes = countResumes(c.rt);
    const svc = new TimerService(c.rt, s.raw.timers, { fenced: true });
    for (let i = 0; i < 3; i++) await svc.tick(FAR);
    expect(resumes.n).toBe(0);
  });

  it("the sweep's lease mode skips a heuristic owner's expired lease unless isAbandoned says so", async () => {
    const s = await stuck({ aHeartbeat: { onStoreError: "continue" } });
    const c = s.node("c");
    lapse(s);
    const bare = await recoverAbandoned(c.rt, {
      leases: { store: s.leases, owner: "c" },
      fenced: true,
    });
    expect(bare.recovered).toBe(0);
    const narrowed = await recoverAbandoned(c.rt, {
      leases: { store: s.leases, owner: "c" },
      isAbandoned: () => true,
      fenced: true,
    });
    expect(narrowed.recovered).toBe(1);
  });
});

describe("D11 testing case 4: a live silent driver is never double-entered", () => {
  it("N pollers + a sweep with an aggressive isAbandoned, A silent mid-step but renewing: zero re-drives, the effect runs once", async () => {
    const s = await stuck();
    const pollers = ["c", "d", "e"].map((id) => {
      const n = s.node(id);
      return {
        n,
        resumes: countResumes(n.rt),
        svc: new TimerService(n.rt, s.raw.timers, { fenced: true, isAbandoned: () => true }),
      };
    });
    // 60 s of virtual time (2 TTLs) in 10 s ticks: A renews every tick, the others poll and sweep.
    for (let round = 0; round < 6; round++) {
      s.clock.wall += TTL / 3;
      s.clock.mono += TTL / 3;
      await s.a.rt.leaseKeeper?.tick();
      await Promise.all(pollers.map((p) => p.svc.tick(FAR)));
      for (const p of pollers) {
        const sum = await recoverAbandoned(p.n.rt, {
          source: s.raw.eventStore,
          isAbandoned: () => true,
          fenced: true,
        });
        expect(sum.recovered).toBe(0);
      }
    }
    for (const p of pollers) expect(p.resumes.n).toBe(0);
    expect(await s.count("EXECUTION_RECOVERED")).toBe(0);
    expect(await s.count("STEP_STARTED")).toBe(1);
    s.latchA.release();
    expect((await s.aHandle.waitForCompletion()).status).toBe("completed");
    expect(await s.count("STEP_STARTED")).toBe(1); // the effect was paid once
  });
});
