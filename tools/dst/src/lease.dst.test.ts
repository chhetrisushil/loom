import type { EventEnvelope } from "@loom/core";
import { LeaseHeldError, LeaseLostError, recoverAbandoned } from "@loom/workflow-runtime";
import { LeaseStoreQuietError, StartLeaseHeldError } from "@loom/workflow-runtime";
import { TimerService } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import {
  type Node,
  Probe,
  type Rig,
  TTL,
  advance,
  deferred,
  flaky,
  rig,
  settle,
  until,
} from "./__tests__/leaseRig";
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
// Phase 2 (S7d merged): the lease veto on `isAbandoned`, the poll's DEFAULT re-drive on expired-lease
// evidence, ghost-lease GC and the entitlement window are live scenarios; the double-entry detector
// has independent negative controls so a green run is not vacuous.

const FAR = Number.MAX_SAFE_INTEGER / 2; // far enough ahead that every held refusal row is due
const DEADLINE = TTL - TTL / 6; // the keeper's local self-fencing window
const DEADLINE_MARGIN = TTL / 6; // how long before the row expires the keeper stops its driver
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

// `leased`: a peer sweeper with its own keeper (a different lease owner). `twin`: a second runtime of
// the SAME node (same owner as the driver), the case the lease store alone cannot refuse - the keeper
// answers true for a lease its own owner holds, so only the veto stands between it and a re-drive.
// `legacy`: a keeper-less sweeper wired to nothing (no lease to consult).
async function silentLive(sweeper: "leased" | "twin" | "legacy") {
  const r = rig();
  const a = r.node("a");
  const b = r.node(sweeper === "twin" ? "a" : "b", { legacy: sweeper === "legacy" });
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

describe("lease DST - a live silent driver and an aggressive isAbandoned", () => {
  it("a heartbeat-wired sweeper vetoes an aggressive isAbandoned up front: nothing is re-driven or double-entered", async () => {
    const { r, a, b, h, sweep, errors } = await silentLive("leased");
    const sum = await sweep;
    expect(sum.recovered).toBe(0);
    expect(sum.failed).toBe(0); // vetoed before any claim, not refused by the driver's stand-down
    expect(errors).toEqual([]);
    expect(r.probe.count("live", "b")).toBe(1);
    r.probe.gate("live").open();
    expect((await settleOf(h.waitForCompletion())).ok).toBe(true);
    expectClean(r, [a, b]);
  });

  // S7d replacement for the S6-residual test that used to sit here: it asserted that an aggressive
  // `isAbandoned` DOUBLE-ENTERED a live silent driver (the sweeper had no lease to consult). Only ONE
  // of the pair is active: this one. The unwired variant's double entry survives as the detector's
  // negative control below ("the double-entry detector fires ...").
  it("S7d veto: a same-owner twin runtime's aggressive sweep never double-enters a live silent driver (only the veto stops it)", async () => {
    const { r, a, b, h, sweep, errors } = await silentLive("twin");
    // Without the veto the sweep re-enters step b and then blocks on the gate, so race it against that
    // entry instead of awaiting it: a regression fails fast here, not on a 30 s timeout.
    let swept = false; // stops the losing `until` once the sweep wins the race
    const sum = await Promise.race([
      sweep.finally(() => {
        swept = true;
      }),
      until(() => swept || r.probe.count("live", "b") === 2, "the sweep re-entered step b").then(
        () => (swept ? undefined : null)
      ),
    ]);
    if (sum === undefined) throw new Error("unreachable: the sweep settled first");
    expect(sum, "the twin's sweep re-drove a live driver").not.toBeNull();
    if (sum === null) return;
    expect(sum.recovered).toBe(0);
    expect(errors).toEqual([]);
    expect(r.probe.count("live", "b")).toBe(1);
    expect(r.probe.doubleEntries).toEqual([]);
    expect((await r.logOf("live")).some((e) => e.eventType === "EXECUTION_RECOVERED")).toBe(false);
    r.probe.gate("live").open();
    expect((await settleOf(h.waitForCompletion())).ok).toBe(true);
    expectClean(r, [a, b]);
  });
});

describe("lease DST - the double-entry detector is not vacuous (independent negative controls)", () => {
  it("Probe unit: two ENTITLED drivers inside one step is flagged; a non-entitled one is not", async () => {
    const probe = new Probe();
    const g = deferred();
    const first = probe.around(
      "x",
      "b",
      () => true,
      () => g.promise
    );
    await probe.around(
      "x",
      "b",
      () => true,
      async () => {}
    ); // overlaps the entitled first
    expect(probe.doubleEntries).toEqual(["x/b"]);
    g.open();
    await first;

    const quiet = new Probe();
    const g2 = deferred();
    const stale = quiet.around(
      "y",
      "b",
      () => false,
      () => g2.promise
    ); // not entitled (stalled)
    await quiet.around(
      "y",
      "b",
      () => true,
      async () => {}
    );
    expect(quiet.doubleEntries).toEqual([]);
    g2.open();
    await stale;
  });

  it("end to end: a sweeper wired to NO lease source re-drives a live driver and the audit reports the double entry", async () => {
    // This is the S6 residual, kept as the control: with nothing to consult, no veto exists, so two
    // nodes really do drive "live" at once. If the detector went quiet this would fail.
    const { r, h, sweep } = await silentLive("legacy");
    await until(() => r.probe.count("live", "b") === 2, "the sweeper re-entered step b");
    expect(r.probe.doubleEntries).toEqual(["live/b"]);
    r.probe.gate("live").open();
    await settleOf(h.waitForCompletion());
    await settleOf(sweep);
    // The fence still keeps the LOG consistent: one completion per step.
    await expectLogInvariants(r, "live");
  });
});

describe("lease DST - S7d consumers (poll default re-drive, ghost GC)", () => {
  /** Poll until `done` (each poll is deterministic; the loop only waits for the async settle). */
  async function pollUntil(svc: TimerService, done: () => Promise<boolean>): Promise<void> {
    await until(async () => {
      await svc.tick(FAR);
      return done();
    }, "the poll's condition");
  }

  it("the poll re-drives a stalled driver's execution on expired-lease evidence by DEFAULT (no `leases` option), never earlier", async () => {
    const r = rig();
    const a = r.node("a");
    const b = r.node("b", { extra: { inboxEnabled: true } }); // the poll acts on refusal rows only with an inbox
    const h = await a.rt.start(r.flow, { id: "poll" }, E("poll"));
    await until(() => r.probe.count("poll", "b") === 1, "inside step b");
    await r.refusalRow("poll");
    // Cluster-visible store + heartbeat "stop" mode: the default evidence, with no `leases` wiring.
    const svc = new TimerService(b.rt, r.timers, { fenced: true });

    // Not before the lease lapses (a stalled-but-unexpired lease is a veto).
    advance(r.clock, TTL - 1_000);
    for (let i = 0; i < 3; i++) {
      // A premature re-drive would block this tick on the step b gate until vitest's timeout; race the
      // tick against the re-entry so a regression fails fast with a message instead.
      let ticked = false;
      const early = await Promise.race([
        svc.tick(FAR).finally(() => {
          ticked = true;
        }),
        until(() => ticked || r.probe.count("poll", "b") > 1, "an early re-drive").then(() =>
          ticked ? undefined : "early"
        ),
      ]);
      expect(early === "early", "the poll re-drove before the lease lapsed").toBe(false);
    }
    expect(r.probe.count("poll", "b")).toBe(1);
    expect(await statusOf(b, "poll")).toBe("running");

    advance(r.clock, 2_000); // now past the TTL: the lease row is expired evidence
    // The poll's re-drive runs the resumed step to completion inside the tick, so it is awaited only
    // after the gate opens; until then wait for the CONDITION that B re-entered step b.
    const polling = svc.tick(FAR);
    await until(() => r.probe.count("poll", "b") === 2, "the poll re-entered step b");
    r.probe.gate("poll").open();
    await polling;
    await pollUntil(svc, async () => (await statusOf(b, "poll")) === "completed");
    const stalled = await settleOf(h.waitForCompletion());
    expect(stalled.ok).toBe(false); // the stalled driver self-fenced
    expect(
      (await r.logOf("poll")).filter((e) => e.eventType === "EXECUTION_RECOVERED")
    ).toHaveLength(1);
    expect(r.probe.doubleEntries).toEqual([]);
    await expectLogInvariants(r, "poll");
  });

  it("an expired ghost lease (no stream) is garbage-collected by the poll, and a live execution's lease is left alone", async () => {
    const r = rig();
    const a = r.node("a");
    const b = r.node("b");
    const h = await a.rt.start(r.flow, { id: "alive" }, E("alive"));
    await until(() => r.probe.count("alive", "b") === 1, "inside step b");
    await r.leases.acquire("ghost-gc", "dead:node", TTL, r.clock.wall);
    expect(await r.leases.get?.("ghost-gc")).not.toBeNull();
    advance(r.clock, TTL + 1);
    const svc = new TimerService(b.rt, r.timers, { fenced: true });
    await svc.tick(FAR);
    expect((await r.leases.get?.("ghost-gc")) ?? null).toBeNull();
    // The stalled driver's stream exists: its (expired) lease row is an orphan, evidence, not a ghost.
    expect(await r.leases.get?.("alive")).not.toBeNull();
    r.probe.gate("alive").open();
    await settleOf(h.waitForCompletion());
  });
});

describe("lease DST - entitlement window", () => {
  // The keeper stops its driver TTL/6 BEFORE the store row expires, so with agreeing clocks a driver
  // never outlives its row. The window opens under CLOCK SKEW: the store's clock runs ahead of the
  // node's, so the row is expired on the store's clock while the node's own deadline (monotonic AND
  // wall) has not been reached - it has not observed its expiry (`validNow` is still true). Another
  // node then takes over (evidence sweep -> conditional takeover, then the fence). The stale node's
  // write must be REFUSED: one driver per committed range of the log. This does NOT claim that no
  // side effect overlaps: inside the window both drivers are entitled, so step b's EFFECT runs twice
  // concurrently (accepted at-least-once); only the log is protected.
  for (const ahead of [DEADLINE_MARGIN + 1, DEADLINE_MARGIN + 5_000]) {
    it(`store clock +${ahead}ms ahead: a node that has not observed its expiry cannot commit after the takeover`, async () => {
      const r = rig();
      const a = r.node("a");
      const b = r.node("b");
      const h = await a.rt.start(r.flow, { id: "win" }, E("win"));
      await until(() => r.probe.count("win", "b") === 1, "inside step b");

      advance(r.clock, DEADLINE - 1_000); // still inside A's own deadline
      r.skew.ms = TTL - (DEADLINE - 1_000) + (ahead - DEADLINE_MARGIN); // store time just past the row's expiry
      expect(a.rt.leaseKeeper?.validNow("win")).toBe(true); // A has not observed its expiry
      const row = await r.leases.get?.("win");
      expect(row?.expiresAt).toBeLessThan(r.clock.wall + r.skew.ms); // but the store says it lapsed

      const sweep = evidenceSweep(b, r);
      await until(() => r.probe.count("win", "b") === 2, "B took over and entered step b");
      const markers = (await r.logOf("win")).filter((e) => e.eventType === "EXECUTION_RECOVERED");
      expect(markers).toHaveLength(1); // the conditional takeover landed exactly once
      const markerSeq = markers[0]?.sequence as number;

      r.probe.gate("win").open(); // both drivers' step b return; A's write races B's
      const aRes = await settleOf(h.waitForCompletion());
      expect(aRes.ok).toBe(false); // A's commit was refused
      await sweep;
      expect(await statusOf(b, "win")).toBe("completed");

      // One driver per range of the LOG: A's stale write was attempted (the audit saw it) and REFUSED
      // by the store's sequence fence (it lost the slot to B's marker), and everything after the
      // marker is exactly B's run of the rest of the flow, each step completing once, gap-free.
      const log = await r.logOf("win");
      expect(String((aRes as { error?: unknown }).error)).toMatch(/duplicate sequence/);
      expect(
        log
          .filter((e) => e.sequence > markerSeq)
          .map((e) => `${e.eventType}:${(e.payload as { stepId?: string }).stepId ?? ""}`)
      ).toEqual([
        "STEP_STARTED:b",
        "STEP_COMPLETED:b",
        "STEP_STARTED:c",
        "STEP_COMPLETED:c",
        "EXECUTION_COMPLETED:",
      ]);
      // The fence protects the LOG, not side effects: A is still entitled (it has not observed its
      // expiry) while B re-enters step b, so the effect overlaps. That is the accepted at-least-once
      // window of ADR 0004, and the detector reports it here (step c overlaps too, as observed:
      // A's runner is still entitled and keeps going beside B; the log stays single-writer regardless).
      expect(r.probe.doubleEntries).toEqual(["win/b", "win/c"]);
      expect(log.filter((e) => e.eventType === "STEP_COMPLETED")).toHaveLength(3);
      expect(log.map((e) => e.sequence)).toEqual(log.map((_, i) => i));
      await expectLogInvariants(r, "win");
      expect(a.unleasedAppends.length).toBeGreaterThan(0);
      expect(b.unleasedAppends).toEqual([]);
    });
  }
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
