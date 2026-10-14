import type { EventEnvelope } from "@loom/core";
import { LeaseHeldError, LeaseLostError, recoverAbandoned } from "@loom/workflow-runtime";
import { LeaseStoreQuietError, StartLeaseHeldError } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { type Node, type Rig, TTL, advance, flaky, rig, settle, until } from "./__tests__/leaseRig";
import { INVARIANTS } from "./invariants";
import { splitmix64 } from "./rng";

// ── DST + N-node chaos for the heartbeat leases (ADR 0130 D11, S7f phase 1) ────────────────────
//
// What is MERGED today (S7a store atomics, S7b keeper, S7c driver lifecycle, S7e config). Every
// scenario runs on fake clocks and hand-driven keeper timers (no real time), seeded where it
// explores. The invariant across ALL of them is ZERO DOUBLE ENTRY of a step: a step is never
// entered while ANOTHER driver that is still entitled (alive and inside its lease deadline) is
// inside it. A stalled or crashed driver's in-flight effect is not entitled; re-running its step
// after the lease expired is the at-least-once window of ADR 0004, not a double entry. Alongside it:
// no append is ever made without a live lease row for the stream (leased nodes), and the log keeps
// its structural invariants (one STEP_COMPLETED per step, gap-free sequences).
//
// Scenarios that need slice S7d (poll default re-drive on lease evidence, lease veto on
// `isAbandoned`, ghost-lease GC) are written now and gated `it.skip` with an `// S7d:` marker; S7d's
// merge flips them on.

const DEADLINE = TTL - TTL / 6; // the keeper's local self-fencing window
const E = (id: string) => ({ executionId: id });

function expectClean(r: Rig, nodes: Node[]): void {
  expect(r.probe.doubleEntries).toEqual([]);
  for (const n of nodes) expect(n.unleasedAppends, `unleased appends by ${n.name}`).toEqual([]);
}

async function expectLogInvariants(r: Rig, id: string): Promise<void> {
  const log = await r.logOf(id);
  for (const inv of [INVARIANTS.noDoubleNonIdempotentEffect, INVARIANTS.logPrefixConsistency]) {
    const res = inv.check({ log });
    expect(res.ok, `${inv.name}: ${JSON.stringify(res.evidence)}`).toBe(true);
  }
}

const settleOf = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );

/** The evidence-based sweep: only expired leases are candidates. */
const evidenceSweep = (n: Node, r: Rig) =>
  recoverAbandoned(n.rt, { leases: { store: r.leases, owner: `${n.name}-sweep` } });

const statusOf = async (n: Node, id: string) => (await n.rt.loadState(id))?.status;

describe("lease DST - stall longer than the TTL", () => {
  for (let s = 1n; s <= 16n; s++) {
    it(`seed ${s}: the stalled driver self-fences, appends nothing past its deadline, and the execution is recoverable`, async () => {
      const rng = splitmix64(s);
      const r = rig();
      const a = r.node("a");
      const b = r.node("b");
      const count = 1 + rng.int(3);
      const ids = Array.from({ length: count }, (_, i) => `stall-${s}-${i}`);
      const handles = [];
      for (const id of ids) handles.push(await a.rt.start(r.flow, { id }, E(id)));
      await until(() => ids.every((id) => r.probe.count(id, "b") === 1), "all inside step b");
      const before = new Map<string, number>();
      for (const id of ids) before.set(id, (await r.logOf(id)).length);

      // The stall: nothing (no tick, no timer) for longer than the TTL, then the work returns.
      advance(r.clock, TTL + 1 + rng.int(2 * TTL));
      for (const id of ids) r.probe.gate(id).open();
      for (const h of handles) {
        const res = await settleOf(h.waitForCompletion());
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toBeInstanceOf(LeaseLostError);
      }
      // Nothing was appended after the deadline, and step c was never dispatched.
      for (const id of ids) {
        expect((await r.logOf(id)).length).toBe(before.get(id));
        expect(r.probe.count(id, "c")).toBe(0);
        expect(await statusOf(b, id)).toBe("running");
      }

      // Recoverable: the lease expired, so the evidence sweep takes each one and finishes it.
      const sum = await evidenceSweep(b, r);
      expect(sum.recovered).toBe(count);
      for (const id of ids) {
        expect(await statusOf(b, id)).toBe("completed");
        expect(r.probe.count(id, "b")).toBe(2); // the stalled attempt and the recovery's
        expect(r.probe.count(id, "c")).toBe(1);
        await expectLogInvariants(r, id);
      }
      expectClean(r, [a, b]);
    });
  }
});

describe("lease DST - store partition ordering", () => {
  // The lease store is unreachable while the event store stays reachable. The model: the keeper
  // ticks at jittered intervals; a tick extends the deadline to now + ttl*5/6 iff the store is up AND
  // the tick happens before the current deadline; a tick at or after it loses the lease.
  for (let s = 1n; s <= 24n; s++) {
    it(`seed ${s}: the driver stops at its deadline iff no renewal got through in time`, async () => {
      const rng = splitmix64(s);
      const r = rig();
      const f = flaky(r.leases);
      const a = r.node("a", { leaseStore: f.store });
      const b = r.node("b");
      const id = `part-${s}`;
      const h = await a.rt.start(r.flow, { id }, E(id));
      await until(() => r.probe.count(id, "b") === 1, "inside step b");
      const before = (await r.logOf(id)).length;

      let deadline = r.clock.mono + DEADLINE;
      let lastRowRenew = r.clock.wall; // the store row expires ttl after the last renew it APPLIED
      let lost = false;
      for (let i = 0; i < 8 && !lost; i++) {
        advance(r.clock, 5_000 + rng.int(7_000));
        const down = rng.bool(0.45);
        f.mode = down ? "down" : "up";
        await a.tick();
        if (r.clock.mono >= deadline) lost = true;
        else if (!down) {
          deadline = r.clock.mono + DEADLINE;
          lastRowRenew = r.clock.wall;
        }
        expect(a.rt.leaseKeeper?.validNow(id)).toBe(!lost);
      }
      f.mode = "up";
      r.probe.gate(id).open();
      const res = await settleOf(h.waitForCompletion());
      if (lost) {
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toBeInstanceOf(LeaseLostError);
        expect((await r.logOf(id)).length).toBe(before); // stopped at the deadline: nothing after
        expect(r.probe.count(id, "c")).toBe(0);
        // The row still names the stopped driver until ITS expiry; nobody may take over earlier.
        advance(r.clock, lastRowRenew + TTL - r.clock.wall - 1);
        expect((await evidenceSweep(b, r)).recovered).toBe(0);
        advance(r.clock, 2);
        expect((await evidenceSweep(b, r)).recovered).toBe(1);
        expect(await statusOf(b, id)).toBe("completed");
      } else {
        expect(res.ok).toBe(true); // the partition healed in time: it finished, once
        expect(r.probe.count(id, "b")).toBe(1);
      }
      await expectLogInvariants(r, id);
      expectClean(r, [a, b]);
    });
  }
});

describe("lease DST - crash mid-renew and mid-release", () => {
  for (let s = 1n; s <= 10n; s++) {
    it(`seed ${s}: a node that dies with a renew on the wire is recovered only after its lease expires`, async () => {
      const rng = splitmix64(s);
      const r = rig();
      const f = flaky(r.leases);
      const a = r.node("a", { leaseStore: f.store });
      const b = r.node("b");
      const id = `renew-${s}`;
      await a.rt.start(r.flow, { id }, E(id));
      await until(() => r.probe.count(id, "b") === 1, "inside step b");
      let lastApplied = r.clock.wall; // the row was written at acquire
      for (let i = rng.int(3); i > 0; i--) {
        advance(r.clock, 10_000);
        await a.tick();
        lastApplied = r.clock.wall;
      }
      // The crash: the next renew is on the wire; the store may or may not have applied it.
      advance(r.clock, 10_000);
      const applied = rng.bool();
      f.mode = applied ? "lose-renew-response" : "hang-renew";
      void a.tick();
      await settle();
      if (applied) lastApplied = r.clock.wall;
      a.alive = false;
      f.mode = "up";
      const rowExpiry = lastApplied + TTL;
      const row = await r.leases.get?.(id);
      expect(row?.expiresAt).toBe(rowExpiry);

      // One tick before the row expires: nobody may take the execution, and nothing is appended.
      advance(r.clock, rowExpiry - 1 - r.clock.wall);
      const len = (await r.logOf(id)).length;
      const refused = await settleOf(
        b.rt.resume(id, { eventType: "EXECUTION_RECOVERED", payload: {} })
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toBeInstanceOf(LeaseHeldError);
      expect((await evidenceSweep(b, r)).recovered).toBe(0);
      expect((await r.logOf(id)).length).toBe(len);

      advance(r.clock, 2);
      r.probe.gate(id).open();
      expect((await evidenceSweep(b, r)).recovered).toBe(1);
      expect(await statusOf(b, id)).toBe("completed");
      await expectLogInvariants(r, id);
      expectClean(r, [a, b]);
    });
  }

  for (const mode of ["drop-release", "lose-release-response"] as const) {
    it(`${mode}: a release that fails never fails the run, and the lease just expires`, async () => {
      const r = rig();
      const f = flaky(r.leases);
      const a = r.node("a", { leaseStore: f.store });
      const b = r.node("b");
      const id = `rel-${mode}`;
      const h = await a.rt.start(r.flow, { id }, E(id));
      await until(() => r.probe.count(id, "b") === 1, "inside step b");
      f.mode = mode;
      r.probe.gate(id).open();
      expect((await settleOf(h.waitForCompletion())).ok).toBe(true);
      expect(await statusOf(b, id)).toBe("completed");
      const row = await r.leases.get?.(id);
      if (mode === "drop-release") {
        expect(row?.owner).toBe("a:i1"); // still named until it expires
        expect(a.errors.length).toBeGreaterThan(0); // reported, never thrown
        expect(await r.leases.acquire(id, "x:1", TTL, r.clock.wall)).toBeNull();
        advance(r.clock, TTL + 1);
      } else {
        expect(row ?? null).toBeNull(); // applied; only the reply was lost
      }
      expect(await r.leases.acquire(id, "x:1", TTL, r.clock.wall)).not.toBeNull();
      // A completed execution under an orphaned lease row is never re-driven.
      f.mode = "up";
      advance(r.clock, TTL + 1);
      expect((await evidenceSweep(b, r)).recovered).toBe(0);
      for (const st of ["a", "b", "c"]) expect(r.probe.count(id, st)).toBe(1);
      expectClean(r, [a, b]);
    });
  }
});

describe("lease DST - continue-as-new handoff", () => {
  it("the successor is leased before its first append and the predecessor keeps its lease until after it: no unleased running instant", async () => {
    const r = rig();
    const a = r.node("a");
    const h = await a.rt.start(r.rot, { id: "cn", n: 0 }, E("cn"));
    await settleOf(h.waitForCompletion());
    const startedAt = (id: string) =>
      r.timeline.findIndex((c) => c === `append:${id}:EXECUTION_STARTED`);
    const succ = r.timeline
      .filter((c) => c.endsWith(":EXECUTION_STARTED"))
      .map((c) => c.split(":")[1] as string)
      .find((id) => id !== "cn");
    expect(succ).toBeDefined();
    const succId = succ as string;
    await until(async () => (await statusOf(a, succId)) === "completed", "successor completes");
    const idx = (c: string) => r.timeline.findIndex((x) => x === c);
    expect(idx(`lease.acquire:${succId}`)).toBeGreaterThanOrEqual(0);
    expect(idx(`lease.acquire:${succId}`)).toBeLessThan(startedAt(succId));
    expect(idx("lease.acquire:cn")).toBeLessThan(startedAt("cn"));
    // The predecessor's lease is released only after the successor exists.
    const predRelease = idx("lease.release:cn");
    expect(predRelease === -1 || predRelease > startedAt(succId)).toBe(true);
    expect(await statusOf(a, "cn")).toBe("continued");
    // Both streams ended unleased and the node holds nothing.
    expect(a.rt.leaseKeeper?.size).toBe(0);
    expectClean(r, [a]);
  });
});

describe("lease DST - outage and the quiet period", () => {
  it("a store outage costs a bounded number of store calls, not one per start; a start after it works", async () => {
    const r = rig();
    const f = flaky(r.leases);
    const a = r.node("a", { leaseStore: f.store });
    f.mode = "down";
    const storeCalls = () => (f.calls.get("acquireMany") ?? 0) + (f.calls.get("acquire") ?? 0);
    // A burst: one group-committed flush, one store call.
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        settleOf(a.rt.start(r.flow, { id: `burst-${i}` }, E(`burst-${i}`)))
      )
    );
    expect(burst.every((x) => !x.ok)).toBe(true);
    // (the first flushes fail, which arms the quiet period: 3 calls for 20 starts)
    const afterBurst = storeCalls();
    expect(afterBurst).toBeLessThanOrEqual(4);
    // Then a long run of sequential starts: the quiet period turns the rest away locally.
    let quiet = 0;
    for (let i = 0; i < 40; i++) {
      const x = await settleOf(a.rt.start(r.flow, { id: `seq-${i}` }, E(`seq-${i}`)));
      expect(x.ok).toBe(false);
      if (!x.ok && x.error instanceof LeaseStoreQuietError) quiet++;
    }
    expect(quiet).toBeGreaterThanOrEqual(30);
    expect(storeCalls() - afterBurst).toBeLessThanOrEqual(1); // no acquire storm: 40 starts, <= 1 call
    // Nothing was appended for any of them.
    expect((await r.logOf("seq-0")).length).toBe(0);
    expect((await r.logOf("burst-0")).length).toBe(0);

    // The store heals, but the keeper stays quiet for the TTL: still no store call.
    f.mode = "up";
    const calls = storeCalls();
    const still = await settleOf(a.rt.start(r.flow, { id: "after-heal" }, E("after-heal")));
    expect(still.ok).toBe(false);
    expect(storeCalls()).toBe(calls);
    advance(r.clock, TTL + 1);
    const h = await a.rt.start(r.flow, { id: "after-quiet" }, E("after-quiet"));
    r.probe.gate("after-quiet").open();
    await h.waitForCompletion();
    expect(await statusOf(a, "after-quiet")).toBe("completed");
    expectClean(r, [a]);
  });
});

describe("lease DST - ghost lease", () => {
  it("a lease whose holder died before sequence 0 stands a caller-chosen start down (retryable) until it expires", async () => {
    const r = rig();
    const b = r.node("b");
    await r.leases.acquire("ghost", "dead:node", TTL, r.clock.wall);
    for (let i = 0; i < 3; i++) {
      const x = await settleOf(b.rt.start(r.flow, { id: "ghost" }, E("ghost")));
      expect(x.ok).toBe(false);
      if (!x.ok) expect(x.error).toBeInstanceOf(StartLeaseHeldError);
      expect((await r.logOf("ghost")).length).toBe(0); // nothing appended, no fence taken
      advance(r.clock, TTL / 3 - 1);
    }
    const last = await settleOf(b.rt.start(r.flow, { id: "ghost" }, E("ghost")));
    expect(last.ok).toBe(false);
    advance(r.clock, 10);
    const h = await b.rt.start(r.flow, { id: "ghost" }, E("ghost"));
    r.probe.gate("ghost").open();
    await h.waitForCompletion();
    expect(await statusOf(b, "ghost")).toBe("completed");
    for (const st of ["a", "b", "c"]) expect(r.probe.count("ghost", st)).toBe(1);
    expectClean(r, [b]);
  });
});

describe("lease DST - mixed fleet", () => {
  it("an unleased legacy driver is never re-driven by lease evidence, however long it runs", async () => {
    const r = rig();
    const legacy = r.node("old", { legacy: true });
    const b = r.node("b");
    const h = await legacy.rt.start(r.flow, { id: "old-1" }, E("old-1"));
    await until(() => r.probe.count("old-1", "b") === 1, "inside step b");
    advance(r.clock, 20 * TTL);
    const sum = await evidenceSweep(b, r);
    expect(sum).toMatchObject({ scanned: 0, recovered: 0 }); // no lease row: not a candidate
    r.probe.gate("old-1").open();
    expect((await settleOf(h.waitForCompletion())).ok).toBe(true);
    for (const st of ["a", "b", "c"]) expect(r.probe.count("old-1", st)).toBe(1);
    expectClean(r, [legacy, b]);
  });

  it("with a stalled leased driver beside it, the sweep recovers only the leased one", async () => {
    const r = rig();
    const legacy = r.node("old", { legacy: true });
    const a = r.node("a");
    const b = r.node("b");
    await legacy.rt.start(r.flow, { id: "L" }, E("L"));
    const ha = await a.rt.start(r.flow, { id: "P" }, E("P"));
    await until(
      () => r.probe.count("L", "b") === 1 && r.probe.count("P", "b") === 1,
      "both inside b"
    );
    advance(r.clock, TTL + 1); // P's driver stalls past its TTL; L has no lease to expire
    r.probe.gate("P").open();
    await settleOf(ha.waitForCompletion());
    const sum = await evidenceSweep(b, r);
    expect(sum.recovered).toBe(1);
    expect(await statusOf(b, "P")).toBe("completed");
    expect(await statusOf(b, "L")).toBe("running");
    expect(r.probe.count("L", "b")).toBe(1);
    r.probe.gate("L").open();
    expectClean(r, [legacy, a, b]);
  });
});

describe("lease DST - a live silent driver and an aggressive isAbandoned", () => {
  async function silentLive(sweeper: "leased" | "legacy") {
    const r = rig();
    const a = r.node("a");
    const b = r.node("b", { legacy: sweeper === "legacy" });
    const h = await a.rt.start(r.flow, { id: "live" }, E("live"));
    await until(() => r.probe.count("live", "b") === 1, "inside step b");
    await a.tick(); // healthy: renewing, just silent in the log
    advance(r.clock, 10_000);
    await a.tick();
    const errors: unknown[] = [];
    const sweep = recoverAbandoned(b.rt, {
      source: r.events,
      isAbandoned: () => true,
      onError: (_id, e) => errors.push(e),
    });
    return { r, a, b, h, sweep, errors };
  }

  it("CURRENT: a heartbeat-wired sweeper is refused by the live lease, so nothing is re-driven or double-entered", async () => {
    const { r, a, b, h, sweep, errors } = await silentLive("leased");
    const sum = await sweep;
    expect(sum.recovered).toBe(0);
    expect(errors.some((e) => e instanceof LeaseHeldError)).toBe(true);
    expect(r.probe.count("live", "b")).toBe(1);
    r.probe.gate("live").open();
    expect((await settleOf(h.waitForCompletion())).ok).toBe(true);
    expectClean(r, [a, b]);
  });

  it("CURRENT (S6 residual): an UNLEASED sweeper has no lease to consult, so an aggressive predicate re-drives a live driver (a double entry)", async () => {
    const { r, h, sweep } = await silentLive("legacy");
    // The sweeper enters step b while the live driver is still inside it.
    await until(() => r.probe.count("live", "b") === 2, "the sweeper re-entered step b");
    expect(r.probe.doubleEntries).toEqual(["live/b"]);
    r.probe.gate("live").open();
    await settleOf(h.waitForCompletion());
    await settleOf(sweep);
    // The fence still keeps the LOG consistent: one completion per step.
    await expectLogInvariants(r, "live");
  });

  // S7d: the lease veto on `isAbandoned` (and conditional takeover) flips this on. The contract:
  // an unexpired live lease vetoes the predicate, so the aggressive sweep NEVER double-enters.
  it.skip("S7d: an aggressive isAbandoned never double-enters a live silent driver (lease veto)", async () => {
    const { r, h, sweep } = await silentLive("legacy");
    await Promise.race([sweep, settle(50)]);
    expect(r.probe.doubleEntries).toEqual([]);
    expect(r.probe.count("live", "b")).toBe(1);
    r.probe.gate("live").open();
    await settleOf(h.waitForCompletion());
    await settleOf(sweep);
  });
});

describe("lease DST - S7d-gated scenarios", () => {
  // S7d: the poll's DEFAULT re-drive on expired-lease evidence. After a stall longer than the TTL the
  // execution is recovered by the poll (no `recoverAbandoned` sweep configured) once its lease row
  // has expired, and never before.
  it.skip("S7d: the poll re-drives a stalled driver's execution on expired-lease evidence, never earlier", async () => {
    const r = rig();
    const a = r.node("a");
    const b = r.node("b");
    const h = await a.rt.start(r.flow, { id: "poll" }, E("poll"));
    await until(() => r.probe.count("poll", "b") === 1, "inside step b");
    advance(r.clock, TTL + 1);
    r.probe.gate("poll").open();
    await settleOf(h.waitForCompletion());
    // S7d wires the poll (TimerService.tick) to do what evidenceSweep does today.
    const { TimerService } = await import("@loom/workflow-runtime");
    const { InMemoryTimerStore } = await import("@loom/event-runtime");
    const timers = new TimerService(b.rt, new InMemoryTimerStore(), {
      leases: { store: r.leases, owner: "b-poll" },
    });
    await timers.tick(r.clock.wall);
    expect(await statusOf(b, "poll")).toBe("completed");
    expect(r.probe.doubleEntries).toEqual([]);
  });

  // S7d: ghost-lease GC. A lease row whose stream never got a sequence 0 is deleted once expired.
  it.skip("S7d: an expired ghost lease (no stream) is garbage-collected by the sweep", async () => {
    const r = rig();
    const b = r.node("b");
    await r.leases.acquire("ghost-gc", "dead:node", TTL, r.clock.wall);
    advance(r.clock, TTL + 1);
    await evidenceSweep(b, r);
    expect((await r.leases.get?.("ghost-gc")) ?? null).toBeNull();
  });
});

const coverage = { runs: 0, crashes: 0, flips: 0, sweeps: 0, recoveredRuns: 0, started: 0 };

describe("lease DST - N-node chaos", () => {
  // Three-plus nodes over one event store and one (breakable) lease store. A seeded op stream: start,
  // tick, advance the clock, open a gate, crash a node (its effects stay in flight, it is dead),
  // flip the store partition, run an evidence sweep. Whatever the interleaving: zero double entry,
  // no unleased append, one completion per step, and once healed every started execution finishes.
  for (let s = 1n; s <= 30n; s++) {
    it(`seed ${s}`, async () => {
      const rng = splitmix64(s);
      const r = rig();
      const f = flaky(r.leases);
      const nodes: Node[] = [];
      let nodeSeq = 0;
      const spawn = () => {
        const n = r.node(`n${nodeSeq++}`, { leaseStore: f.store });
        nodes.push(n);
        return n;
      };
      for (let i = 0; i < 3; i++) spawn();
      const live = () => nodes.filter((n) => n.alive);
      const ids: string[] = [];
      const pending: Array<Promise<unknown>> = [];
      const track = <T>(p: Promise<T>) => pending.push(p.catch(() => undefined));

      for (let step = 0; step < 45; step++) {
        const n = rng.pick(live());
        switch (rng.int(8)) {
          case 0:
          case 1:
            if (ids.length < 4) {
              const id = `chaos-${s}-${ids.length}`;
              ids.push(id);
              track(n.rt.start(r.flow, { id }, E(id)).then((h) => h.waitForCompletion()));
            }
            break;
          case 2:
          case 3:
            await n.tick();
            break;
          case 4:
            advance(r.clock, 1_000 + rng.int(14_000));
            break;
          case 5:
            if (ids.length > 0) r.probe.gate(rng.pick(ids)).open();
            break;
          case 6:
            if (live().length > 1 && rng.bool(0.5)) {
              n.alive = false;
              coverage.crashes++;
              if (live().length < 3) spawn();
            } else {
              f.mode = f.mode === "up" ? "down" : "up";
              coverage.flips++;
            }
            break;
          default:
            coverage.sweeps++;
            track(evidenceSweep(n, r));
        }
        await settle(5);
      }

      // Heal, release every gate, and let evidence-based recovery finish what the chaos broke.
      f.mode = "up";
      for (const id of ids) r.probe.gate(id).open();
      const closer = spawn();
      for (let round = 0; round < 6; round++) {
        advance(r.clock, TTL + 1);
        await settle(5);
        await settleOf(evidenceSweep(closer, r));
        await closer.tick();
        const states = await Promise.all(ids.map((id) => statusOf(closer, id)));
        if (states.every((st) => st === undefined || st === "completed")) break;
      }
      await Promise.all(pending);

      for (const id of ids) {
        const st = await statusOf(closer, id);
        // An id whose every start attempt failed on the partition never existed: nothing to recover.
        if ((await r.logOf(id)).length === 0) continue;
        expect(st, `${id} must converge once healed`).toBe("completed");
        await expectLogInvariants(r, id);
        coverage.started++;
        if ((await r.logOf(id)).some((e: EventEnvelope) => e.eventType === "EXECUTION_RECOVERED"))
          coverage.recoveredRuns++;
      }
      coverage.runs++;
      expectClean(r, nodes);
    });
  }

  it("is not vacuous: across the seeds, nodes crashed, the store partitioned, and executions were recovered", () => {
    expect(coverage.runs).toBe(30);
    expect(coverage.crashes).toBeGreaterThan(5);
    expect(coverage.flips).toBeGreaterThan(5);
    expect(coverage.sweeps).toBeGreaterThan(20);
    expect(coverage.started).toBeGreaterThan(30);
    expect(coverage.recoveredRuns).toBeGreaterThan(5);
  });
});

describe("lease DST - negative control", () => {
  it("the audit fires when a lease row is stolen behind a node that has not ticked yet (the fence, not the lease, is the write guard)", async () => {
    const r = rig();
    const a = r.node("a");
    const h = await a.rt.start(r.flow, { id: "steal" }, E("steal"));
    await until(() => r.probe.count("steal", "b") === 1, "inside step b");
    await r.leases.release("steal", "a:i1");
    await r.leases.acquire("steal", "thief:1", TTL, r.clock.wall);
    r.probe.gate("steal").open();
    await settleOf(h.waitForCompletion());
    expect(a.unleasedAppends.length).toBeGreaterThan(0);
  });
});
