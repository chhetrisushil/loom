import { unwrapTainted } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  InMemoryTimerStore,
} from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { build, flow, until } from "./__tests__/r2Harness";
import { INBOX_WAKE_AT } from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import { SealedPayloadUnreadableError } from "./types";

// ADR 0130 D10 (R-d): a replay refusal leaves a durable wake row; the timer poll re-drives a
// `running` execution that carries one, only if it is abandoned. The wake row is a TIMER-store row,
// never an event-log append, so "an incapable node appends nothing" holds.

const SECRET = "123-45-6789";
let seq = 0;
const id = (): string => `wr-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

/** The same raw stores seen as an UNMARKED log (a writer that did not stamp `metadata.seal`). */
function legacyView(inner: EventStore): EventStore {
  const strip = (events: EventEnvelope[]): EventEnvelope[] =>
    events.map((e) => {
      if (e.metadata?.seal === undefined) return e;
      const { seal: _seal, ...rest } = e.metadata;
      return { ...e, metadata: rest };
    });
  return {
    append: (e) => inner.append(e),
    appendBatch: (es) => inner.appendBatch!(es),
    read: async (i) => strip(await inner.read(i)),
    readFrom: async (i, from) => strip(await inner.readFrom(i, from)),
    readRange: async (i, from, to) => strip(await inner.readRange!(i, from, to)),
    head: (i) => inner.head!(i),
    subscribe: (i, h) => inner.subscribe(i, h),
    acquireFence: (i) => inner.acquireFence!(i),
    acquireFenceIf: (i, x) => inner.acquireFenceIf!(i, x),
    appendIfUnchanged: (i, ev, expect) => inner.appendIfUnchanged!(i, ev, expect),
    close: () => inner.close(),
  };
}

const f = flow("w", async (ctx) => {
  const y = unwrapTainted(await ctx.receive<unknown>("y"));
  await ctx.suspend({ on: "Go" });
  return { y };
});

async function scenario() {
  const raw = {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    timers: new InMemoryTimerStore(),
  };
  const keys = new InMemoryKeyStore();
  const sealedStore = new EncryptingEventStore(raw.eventStore, keys, {
    sensitive: { MESSAGE_CONSUMED: ["payload"], INBOX_MESSAGE: ["payload"] },
    subjectOf: (e) => e.executionId,
  });
  const a = build({}, { ...raw, eventStore: sealedStore });
  // B and C are separate nodes over the same stores (B: incapable, unmarked view; C: capable).
  const b = build(
    {},
    {
      ...raw,
      eventStore: legacyView(raw.eventStore),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    }
  );
  const c = build(
    {},
    { ...raw, eventStore: sealedStore, snapshotStore: new InMemoryAsyncSnapshotStore() }
  );
  for (const n of [a, b, c]) n.rt.registerFlow(f.definition, f.runner);
  const e = id();
  await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
  await a.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
  await until(async () => (await a.rt.loadState(e))?.suspendedOn?.on === "Go");
  // node A "crashes" here (we simply never use it again). Clear send's own rows.
  for (const r of await raw.timers.due(Number.MAX_SAFE_INTEGER)) {
    await raw.timers.complete(r.executionId, r.wakeAt);
  }
  const leaseStore = new InMemoryLeaseStore();
  const lease = (owner: string) => ({ store: leaseStore, owner, ttlMs: 60_000 });
  const wakeRows = async () =>
    (await raw.timers.due(Number.MAX_SAFE_INTEGER)).filter(
      (r) => r.executionId === e && r.wakeAt === INBOX_WAKE_AT
    );
  const logLen = async () => (await raw.eventStore.read(e)).length;
  return { raw, a, b, c, e, leaseStore, lease, wakeRows, logLen };
}

/** B resumes the unrelated Go gate and refuses at replay. */
async function refuseOnB(s: Awaited<ReturnType<typeof scenario>>) {
  const h = await s.b.rt.resume(s.e, { eventType: "Go", payload: null });
  const err = await h.waitForCompletion().then(
    () => undefined,
    (x: unknown) => x
  );
  expect(err).toBeInstanceOf(SealedPayloadUnreadableError);
}

describe("ADR 0130 D10 - replay refusal leaves a wake row; the poll re-drives", () => {
  it("R-d repro: B's refusal writes a wake row (no log append for it); capable C's poll completes it with no send, sweep or resume", async () => {
    const s = await scenario();
    expect(await s.wakeRows()).toHaveLength(0);
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    // the row is a timer-store row: the log did not move because of it
    const afterRefusal = await s.logLen();
    await new Promise((r) => setTimeout(r, 30));
    expect(await s.logLen()).toBe(afterRefusal);
    expect((await s.b.rt.loadState(s.e))?.status).toBe("running");

    let resumes = 0;
    const real = s.c.rt.resume.bind(s.c.rt);
    s.c.rt.resume = (...a: Parameters<typeof real>) => {
      resumes++;
      return real(...a);
    };
    await new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") }).tick(Date.now() + 1);
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
    expect(resumes).toBe(1); // the poll's own re-drive, nothing else
    expect((await s.c.rt.loadState(s.e))?.variables._output).toEqual({ y: { ssn: SECRET } });
    // the row is retired once the execution is terminal
    await new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") }).tick(Date.now() + 1);
    await until(async () => (await s.wakeRows()).length === 0);
  });

  it("a live lease holder is never superseded; once the lease lapses the poll re-drives", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const before = await s.logLen();
    await s.leaseStore.acquire(s.e, "live-node", 60_000);
    let resumes = 0;
    const real = s.c.rt.resume.bind(s.c.rt);
    s.c.rt.resume = (...a: Parameters<typeof real>) => {
      resumes++;
      return real(...a);
    };
    const svc = new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") });
    for (let i = 0; i < 3; i++) await svc.tick(Date.now() + 1);
    expect(resumes).toBe(0);
    expect(await s.logLen()).toBe(before);
    expect(await s.wakeRows()).toHaveLength(1); // row survives
    // lapse: the holder stopped renewing
    await s.leaseStore.acquire(s.e, "live-node", 1, Date.now() - 10_000);
    await svc.tick(Date.now() + 1);
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
    expect(resumes).toBe(1);
  });

  it("an incapable node's polls back off (injected clock, no hot loop), never retire the row, and a capable node still completes", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const kindsBefore = (await s.raw.eventStore.read(s.e)).length;
    let clock = 5_000_000;
    const errors: unknown[] = [];
    const svc = new TimerService(s.b.rt, s.raw.timers, {
      leases: s.lease("b"),
      now: () => clock,
      onError: (_i: string, err: unknown) => errors.push(err),
      redriveBackoff: { baseMs: 100, capMs: 10_000, random: () => 1 },
    });
    let resumes = 0;
    const real = s.b.rt.resume.bind(s.b.rt);
    s.b.rt.resume = (...a: Parameters<typeof real>) => {
      resumes++;
      return real(...a);
    };
    for (let i = 0; i < 200; i++) {
      clock += 50;
      await svc.tick(clock);
    }
    expect(resumes).toBeGreaterThan(0);
    expect(resumes).toBeLessThanOrEqual(10);
    expect(errors.length).toBeLessThanOrEqual(2);
    expect(errors.every((x) => x instanceof SealedPayloadUnreadableError)).toBe(true);
    expect(await s.wakeRows()).toHaveLength(1);
    // On an UNMARKED legacy stream the incapable node cannot know in advance, so each (backed-off)
    // re-drive attempt appends only the re-drive's own marker; the REFUSAL appends nothing else
    // and no payload-bearing event ever reaches the log (the marked-stream test below asserts
    // that nothing at all is written when the marker is visible).
    const added = (await s.raw.eventStore.read(s.e)).slice(kindsBefore);
    expect(added.length).toBeLessThanOrEqual(resumes * 2);
    for (const ev of added)
      expect(["EXECUTION_RECOVERED", "EXECUTION_RESUMED"]).toContain(ev.eventType);
    await new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") }).tick(Date.now() + 1);
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
  });

  it("a MARKED stream is refused before any fence acquire: a raw node's polls write nothing and keep the row", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const raw = build(
      {},
      {
        eventStore: s.raw.eventStore,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timers: s.raw.timers,
      }
    );
    raw.rt.registerFlow(f.definition, f.runner);
    const before = await s.logLen();
    const fenceBefore = await s.raw.eventStore.acquireFence!(s.e);
    let clock = 7_000_000;
    const svc = new TimerService(raw.rt, s.raw.timers, {
      leases: s.lease("raw"),
      now: () => clock,
      fenced: true,
      redriveBackoff: { baseMs: 100, capMs: 10_000, random: () => 1 },
    });
    for (let i = 0; i < 20; i++) {
      clock += 500;
      await svc.tick(clock);
    }
    expect(await s.logLen()).toBe(before);
    expect(await s.wakeRows()).toHaveLength(1);
    // no fence was taken by the refusing node: the next acquire is exactly one past ours
    const fenceAfter = await s.raw.eventStore.acquireFence!(s.e);
    expect(Number(fenceAfter)).toBe(Number(fenceBefore) + 1);
  });

  it("a refusal on the poll suppresses the sweep on that node (no double drive), and vice versa", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    let resumes = 0;
    const real = s.b.rt.resume.bind(s.b.rt);
    s.b.rt.resume = (...a: Parameters<typeof real>) => {
      resumes++;
      return real(...a);
    };
    const svc = new TimerService(s.b.rt, s.raw.timers, { leases: s.lease("b") });
    await svc.tick(Date.now() + 1);
    await until(() => resumes === 1);
    const sweep = await recoverAbandoned(s.b.rt, {
      source: s.raw.eventStore,
      isAbandoned: () => true,
    });
    expect(sweep.recovered).toBe(0);
    expect(resumes).toBe(1); // the poll's refusal backed the sweep off
  });

  it("two pollers (incapable + capable) race the row: exactly one completion, no ciphertext delivered, fence monotonic", async () => {
    const s = await scenario();
    await refuseOnB(s);
    await until(async () => (await s.wakeRows()).length === 1);
    const at = Date.now() + 1;
    await Promise.all([
      new TimerService(s.b.rt, s.raw.timers, { leases: s.lease("b") }).tick(at),
      new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") }).tick(at),
    ]);
    // if B lost the lease race, C picks it up on the next poll
    await new TimerService(s.c.rt, s.raw.timers, { leases: s.lease("c") }).tick(Date.now() + 1);
    await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
    const evs = await s.raw.eventStore.read(s.e);
    expect(evs.filter((x) => x.eventType === "EXECUTION_COMPLETED")).toHaveLength(1);
    expect((await s.c.rt.loadState(s.e))?.variables._output).toEqual({ y: { ssn: SECRET } });
    const seqs = evs.map((x) => x.sequence);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("no timer store: the refusal still throws the typed error, writes no row, and recoverAbandoned still recovers", async () => {
    const raw = {
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    };
    const keys = new InMemoryKeyStore();
    const sealedStore = new EncryptingEventStore(raw.eventStore, keys, {
      sensitive: { MESSAGE_CONSUMED: ["payload"], INBOX_MESSAGE: ["payload"] },
      subjectOf: (e) => e.executionId,
    });
    const a = build({}, { ...raw, eventStore: sealedStore, timers: null });
    const b = build(
      {},
      {
        eventStore: legacyView(raw.eventStore),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timers: null,
      }
    );
    for (const n of [a, b]) n.rt.registerFlow(f.definition, f.runner);
    const e = id();
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await a.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
    await until(async () => (await a.rt.loadState(e))?.suspendedOn?.on === "Go");
    const h = await b.rt.resume(e, { eventType: "Go", payload: null });
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(SealedPayloadUnreadableError);
    expect(b.storageErrors).toHaveLength(0);
    const sweep = await recoverAbandoned(a.rt, { source: raw.eventStore, isAbandoned: () => true });
    expect(sweep.recovered).toBeGreaterThanOrEqual(1);
    await until(async () => (await a.rt.loadState(e))?.status === "completed");
  });

  it("DST: random crash points over a {capable, incapable} fleet - completes iff a capable node is up; ciphertext never reaches a flow", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = await scenario();
      let rng = seed * 7919;
      const rand = () => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return rng / 0x7fffffff;
      };
      await refuseOnB(s);
      await until(async () => (await s.wakeRows()).length === 1);
      let clock = 9_000_000;
      const svcB = new TimerService(s.b.rt, s.raw.timers, {
        leases: s.lease("b"),
        now: () => clock,
      });
      const svcC = new TimerService(s.c.rt, s.raw.timers, {
        leases: s.lease("c"),
        now: () => clock,
      });
      const capableUp = seed % 4 !== 0; // every 4th seed: the capable node never comes up
      for (let i = 0; i < 12; i++) {
        clock += 5_000;
        if (rand() < 0.6) await svcB.tick(clock);
        if (capableUp && rand() < 0.5) await svcC.tick(clock);
      }
      if (capableUp) {
        await svcC.tick(clock + 100_000);
        await until(async () => (await s.c.rt.loadState(s.e))?.status === "completed");
      } else {
        expect((await s.b.rt.loadState(s.e))?.status).toBe("running");
        expect(await s.wakeRows()).toHaveLength(1);
      }
      for (const ev of await s.raw.eventStore.read(s.e)) {
        if (ev.eventType === "EXECUTION_COMPLETED") {
          expect(JSON.stringify(ev.payload)).not.toContain("__loomEnc");
        }
      }
    }
  }, 60_000);
});
