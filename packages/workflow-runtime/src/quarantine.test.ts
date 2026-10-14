import { quarantineStreamId } from "@loom/event-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import type { WorkflowRuntimeDeps } from "./WorkflowRuntime";
import {
  OP,
  SECRET,
  collector,
  consumedOf,
  eventsByKind,
  fleet,
  keyOf,
  kindsOf,
  put,
  quarantineHead,
} from "./__tests__/quarantineHarness";
import { inboxBackends } from "./__tests__/r2Backends";
import { until } from "./__tests__/r2Harness";
import { cursorsOf, inboxStreamId } from "./inbox";
import { isSealedUnreadable } from "./sealGuard";
import {
  InboxQuarantineRefusedError,
  QuarantineHeldError,
  SealedPayloadUnreadableError,
} from "./types";

// ADR 0130 residuals D9 / S5 - quarantineInbox / releaseInbox: a per-TOPIC hold with order-preserving
// release and capable-node auto-release. The fleet: A = capable (seals and opens), B = incapable (no
// crypto), over ONE set of raw stores. Sealed messages are written through A's sealing store directly
// (no `send`), so A does not deliver them before B has had a look.

const q = (id: string) => quarantineStreamId(id);
const quarantinedOf = (state: { variables: Record<string, unknown> } | null | undefined) =>
  (state?.variables._quarantined ?? {}) as Record<
    string,
    Array<{ key: string; inboxSeq: number; heldAt: number; state: string }>
  >;

for (const backend of inboxBackends("quarantine")) {
  describe.skipIf(backend.skip === true)(
    `quarantineInbox / releaseInbox on ${backend.name}`,
    () => {
      beforeAll(() => backend.setup());
      afterAll(() => backend.teardown());
      let n = 0;
      const id = () => `${backend.name}-q${++n}-${Math.random().toString(36).slice(2, 6)}`;

      /** A parked on select([a, b]); a1 SEALED, a2 plain on `a`, b1 plain on `b`; nobody has woken it. */
      async function scene(
        opts: {
          a?: Partial<WorkflowRuntimeDeps>;
          b?: Partial<WorkflowRuntimeDeps>;
          total?: number;
          withB1?: boolean;
        } = {}
      ) {
        const raw = backend.make();
        const fl = fleet(raw, {
          a: opts.a ?? { inboxAutoRelease: false },
          ...(opts.b !== undefined && { b: opts.b }),
        });
        const f = collector(opts.total ?? 3);
        fl.a.rt.registerFlow(f.definition, f.runner);
        fl.b.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await (await fl.a.rt.start(f, {}, { executionId: e })).waitForSuspend();
        await until(async () => (await fl.a.rt.loadState(e))?.status === "suspended");
        await fl.a.rt.notifyInbox(e); // settle the owner's own post-park read before anything lands
        await put(fl.a.eventStore, e, { topic: "a", messageId: "a1", payload: { ssn: SECRET } });
        await put(raw.eventStore, e, { topic: "a", messageId: "a2", payload: "plain-a2" });
        if (opts.withB1 !== false) {
          await put(raw.eventStore, e, { topic: "b", messageId: "b1", payload: "plain-b1" });
        }
        return { ...fl, f, e, raw };
      }
      /** Wait until the owner has re-parked (after a delivery it runs, then parks again). */
      const parked = (
        h: { rt: { loadState: (id: string) => Promise<{ status: string } | null> } },
        e: string
      ) => until(async () => (await h.rt.loadState(e))?.status === "suspended", 15_000);
      const done = async (
        h: {
          rt: {
            loadState: (
              id: string
            ) => Promise<{ status: string; variables: Record<string, unknown> } | null>;
          };
        },
        e: string
      ) => {
        await until(async () => (await h.rt.loadState(e))?.status === "completed", 15_000);
        return (await h.rt.loadState(e))?.variables._output;
      };

      it("B (incapable) quarantines the sealed head: the other topic flows, the copy is byte-identical, the hold blocks every node", async () => {
        const s = await scene();
        // Without a hold the sealed head blocks the whole execution on B (D4): nothing is appended.
        const before = await kindsOf(s.raw.eventStore, s.e);
        const refusal = await s.b.rt.notifyInbox(s.e).catch((x) => x);
        expect(isSealedUnreadable(refusal)).toBe(true);
        expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
        expect(await quarantineHead(s.raw.eventStore, s.e)).toBeNull();

        const res = await s.b.rt.quarantineInbox(
          s.e,
          { topic: "a", reason: "key rotation" },
          { principal: OP }
        );
        expect(res).toMatchObject({
          executionId: s.e,
          topic: "a",
          messageId: "a1",
          inboxSeq: 0,
          heldAt: 1,
        });

        // The copy: same envelope bytes (payload still sealed, metadata.seal kept), deterministic id.
        const original = (await s.raw.eventStore.read(inboxStreamId(s.e)))[0];
        const copy = (await s.raw.eventStore.read(q(s.e)))[1]; // sequence 0 is the payload-free anchor
        expect(JSON.stringify(original?.payload)).toContain("__loomEnc");
        expect(copy?.payload).toEqual(original?.payload);
        expect(copy?.metadata?.seal).toEqual(original?.metadata?.seal);
        expect(copy?.metadata?.seal).toBeDefined();
        expect(copy?.id).toBe(`quarantine:${s.e}:${keyOf("a1")}:0`); // chain, key, original inboxSeq
        expect(JSON.stringify(copy)).not.toContain(SECRET);

        // The fact: audit trail names the operator and reason; the fold holds the topic.
        const [fact] = await eventsByKind(s.raw.eventStore, s.e, "INBOX_QUARANTINED");
        expect(fact?.metadata?.kernel).toBe(true);
        expect(fact?.payload).toMatchObject({
          topic: "a",
          inboxSeq: 0,
          key: keyOf("a1"),
          messageId: "a1",
          heldAt: 1,
          operator: OP,
          reason: "key rotation",
        });
        // B delivers b1 (the other arm); a2 is NOT delivered on B.
        await until(async () =>
          consumedOf(await s.raw.eventStore.read(s.e)).some((c) => c.messageId === keyOf("b1"))
        );
        await parked(s.b, s.e);
        const st = await s.b.rt.loadState(s.e);
        expect(quarantinedOf(st).a).toEqual([
          { key: keyOf("a1"), inboxSeq: 0, heldAt: 1, state: "held" },
        ]);
        expect(cursorsOf(st?.variables ?? {}).a).toBe(0);
        await s.b.rt.notifyInbox(s.e).catch(() => undefined);
        expect(consumedOf(await s.raw.eventStore.read(s.e)).map((c) => c.topic)).toEqual(["b"]);
        // ...and NOT on capable node A either (autoRelease is off on A): the hold is for every node.
        await s.a.rt.notifyInbox(s.e).catch(() => undefined);
        expect(consumedOf(await s.raw.eventStore.read(s.e)).map((c) => c.topic)).toEqual(["b"]);
        expect((await s.a.rt.loadState(s.e))?.status).toBe("suspended");
      });

      it("ORDER: a manual release delivers the held message FIRST, from the copy, at its ORIGINAL inboxSeq, then the message that arrived behind it", async () => {
        const s = await scene();
        await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
        await until(async () => consumedOf(await s.raw.eventStore.read(s.e)).length === 1);
        await parked(s.b, s.e);
        const released = await s.a.rt.releaseInbox(
          s.e,
          { topic: "a", messageId: "a1", disposition: "deliver" },
          { principal: OP }
        );
        expect(released).toMatchObject({ messageId: "a1", disposition: "deliver" });
        expect(await done(s.a, s.e)).toEqual([
          ["b", "plain-b1"],
          ["a", { ssn: SECRET }],
          ["a", "plain-a2"],
        ]);
        const log = await s.raw.eventStore.read(s.e);
        const consumed = consumedOf(log);
        const a = consumed.filter((c) => c.topic === "a");
        expect(a.map((c) => c.messageId)).toEqual([keyOf("a1"), keyOf("a2")]);
        expect(a[0]?.inboxSeq).toBe(0); // original position
        expect(a[1]?.inboxSeq).toBe(1);
        // INBOX_RELEASED{operator} precedes the delivery; the cursor never regressed.
        const [rel] = await eventsByKind(s.raw.eventStore, s.e, "INBOX_RELEASED");
        expect(rel?.payload).toMatchObject({ topic: "a", disposition: "deliver", operator: OP });
        expect((rel?.payload as { auto?: unknown }).auto).toBeUndefined();
        // a2 was never delivered before a1, and a fresh capable node replays the identical fold.
        const replayed = await s.a2().rt.loadState(s.e);
        const live = await s.a.rt.loadState(s.e);
        expect(replayed?.variables._inbox).toEqual(live?.variables._inbox);
        expect(replayed?.variables._quarantined).toBeUndefined(); // full cycle: never-quarantined shape
        expect(replayed?.variables._output).toEqual(live?.variables._output);
      });

      it("AUTO-RELEASE: a capable node lifts the hold at its next notify in ONE atomic batch, no operator, no authorizer", async () => {
        const calls: string[] = [];
        const s = await scene({
          a: {
            executionAuthorizer: {
              authorize: (r: { op: string }) => {
                calls.push(r.op);
                return { allowed: true } as const;
              },
            },
          },
        });
        await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
        await until(async () => consumedOf(await s.raw.eventStore.read(s.e)).length === 1);
        await parked(s.b, s.e);
        const callsBefore = calls.length;
        await s.a.rt.notifyInbox(s.e);
        expect(await done(s.a, s.e)).toEqual([
          ["b", "plain-b1"],
          ["a", { ssn: SECRET }],
          ["a", "plain-a2"],
        ]);
        expect(calls.length).toBe(callsBefore); // no principal, no authorizer call
        const log = await s.raw.eventStore.read(s.e);
        const i = log.findIndex((e) => e.eventType === "INBOX_RELEASED");
        expect(i).toBeGreaterThan(0);
        const rel = log[i];
        expect(rel?.payload).toMatchObject({
          topic: "a",
          key: keyOf("a1"),
          messageId: "a1",
          disposition: "deliver",
          auto: true,
        });
        expect((rel?.payload as { operator?: unknown }).operator).toBeUndefined();
        expect(rel?.metadata?.kernel).toBe(true);
        // ONE batch: the very next event is the delivery of the original inboxSeq, in the same append.
        expect(log[i + 1]?.eventType).toBe("MESSAGE_CONSUMED");
        expect(log[i + 1]?.payload).toMatchObject({
          topic: "a",
          messageId: keyOf("a1"),
          inboxSeq: 0,
        });
        expect(log[i + 2]?.eventType).toBe("EXECUTION_RESUMED");
      });

      it("AUTO-RELEASE: the LIVE run reaching a receive on a held topic releases and delivers in the same batch", async () => {
        const raw = backend.make();
        const fl = fleet(raw, { a: {}, b: {} });
        const { flow } = await import("./__tests__/r2Harness");
        const { unwrapTainted } = await import("@loom/classify");
        const f = flow("gated", async (ctx) => {
          await ctx.suspend({ on: "Go" });
          return unwrapTainted(await ctx.receive<unknown>("a"));
        });
        for (const h of [fl.a, fl.b]) h.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await (await fl.a.rt.start(f, {}, { executionId: e })).waitForSuspend();
        await put(fl.a.eventStore, e, { topic: "a", messageId: "a1", payload: { ssn: SECRET } });
        await fl.b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
        await fl.a.rt.resume(e, { eventType: "Go", payload: null });
        expect(await done(fl.a, e)).toEqual({ ssn: SECRET });
        const log = await raw.eventStore.read(e);
        const i = log.findIndex((x) => x.eventType === "INBOX_RELEASED");
        expect(log[i]?.payload).toMatchObject({ auto: true });
        expect(log[i + 1]?.eventType).toBe("MESSAGE_CONSUMED");
      });

      it("NO capable node: the topic stays held, other topics flow, the poll leaves the row and reports first-then-every-16th, appends nothing; a capable node later releases on its first poll with no send", async () => {
        // The shared sealed back-off runs on the RUNTIME's clock (ADR 0130 D10), so the injected clock
        // is the runtime's too, not only the poller's.
        const clock = { t: 1_000 };
        const s = await scene({ a: {}, b: { now: () => clock.t } });
        await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
        await until(async () => consumedOf(await s.raw.eventStore.read(s.e)).length === 1); // b1 flowed
        await parked(s.b, s.e);
        const reports: unknown[] = [];
        const svcB = new TimerService(s.b.rt, s.raw.timers, {
          now: () => clock.t,
          // a shared database may hold other tests' due rows: only THIS execution's reports count
          onError: (i: string, err: unknown) => {
            if (i === s.e) reports.push(err);
          },
        });
        const before = await kindsOf(s.raw.eventStore, s.e);
        await s.raw.timers.schedule({ executionId: s.e, wakeAt: -1 });
        await svcB.tick(clock.t);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toBeInstanceOf(QuarantineHeldError);
        expect(reports[0]).toBeInstanceOf(SealedPayloadUnreadableError); // the existing operator machinery applies
        expect(String((reports[0] as Error).message)).toMatch(/HELD.*awaiting a capable node/);
        expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before); // nothing appended
        expect(
          (await s.raw.timers.due(Number.MAX_SAFE_INTEGER)).some((r) => r.executionId === s.e)
        ).toBe(true);
        // ...and then only every 16th refusal is reported (attempts 2..15 are silent), the row never retired
        for (let attempt = 2; attempt <= 16; attempt++) {
          clock.t += 120_000; // past any back-off
          await svcB.tick(clock.t);
        }
        expect(reports).toHaveLength(2);
        expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
        // A capable node starts later: its first poll of the wake row releases and delivers, no send.
        const svcA = new TimerService(s.a.rt, s.raw.timers, { now: () => clock.t + 1e9 });
        await svcA.tick(clock.t + 1e9);
        expect(await done(s.a, s.e)).toEqual([
          ["b", "plain-b1"],
          ["a", { ssn: SECRET }],
          ["a", "plain-a2"],
        ]);
      });

      it("an incapable node NEVER auto-quarantines: a raw poll over a sealed head appends nothing", async () => {
        const s = await scene();
        const before = await kindsOf(s.raw.eventStore, s.e);
        for (let i = 0; i < 3; i++) await s.b.rt.notifyInbox(s.e).catch(() => undefined);
        const svc = new TimerService(s.b.rt, s.raw.timers);
        await s.raw.timers.schedule({ executionId: s.e, wakeAt: -1 });
        await svc.tick(Date.now());
        expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
        expect(await quarantineHead(s.raw.eventStore, s.e)).toBeNull();
      });

      it("`inboxAutoRelease: false` leaves the hold until an operator releases it", async () => {
        const s = await scene({ a: { inboxAutoRelease: false } });
        await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
        await until(async () => consumedOf(await s.raw.eventStore.read(s.e)).length === 1);
        await parked(s.b, s.e);
        await s.a.rt.notifyInbox(s.e).catch(() => undefined);
        expect(await eventsByKind(s.raw.eventStore, s.e, "INBOX_RELEASED")).toHaveLength(0);
        await s.a.rt.releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: OP }); // deliver is the default
        expect(await done(s.a, s.e)).toBeDefined();
      });

      it("`not-sealed`: a capable node, and a plain head, are refused; nothing is appended and no copy is made", async () => {
        const s = await scene({ withB1: false });
        const before = await kindsOf(s.raw.eventStore, s.e);
        // A can open a1 -> it is not a moderation hold.
        const e1 = await s.a.rt
          .quarantineInbox(s.e, { topic: "a" }, { principal: OP })
          .catch((x) => x);
        expect(e1).toBeInstanceOf(InboxQuarantineRefusedError);
        expect((e1 as InboxQuarantineRefusedError).reason).toBe("not-sealed");
        // B quarantines a1; the next head of `a` is the PLAIN a2: not sealed.
        await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
        const e2 = await s.b.rt
          .quarantineInbox(s.e, { topic: "a" }, { principal: OP })
          .catch((x) => x);
        expect((e2 as InboxQuarantineRefusedError).reason).toBe("not-sealed");
        expect(
          (await kindsOf(s.raw.eventStore, s.e)).filter((k) => k === "INBOX_QUARANTINED")
        ).toHaveLength(1);
        expect(await quarantineHead(s.raw.eventStore, s.e)).toBe(1); // the anchor and the one copy
        expect(before.length).toBeLessThan((await kindsOf(s.raw.eventStore, s.e)).length);
      });

      it("multiple holds: release in queue order only; a later one first is `invalid`; discard drops the head and unblocks; a resent discarded id is a duplicate", async () => {
        const raw = backend.make();
        const fl = fleet(raw, { a: { inboxAutoRelease: false } });
        const f = collector(3, ["a"]); // a third receive that never completes: the RESENT id is a duplicate
        fl.a.rt.registerFlow(f.definition, f.runner);
        fl.b.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await (await fl.a.rt.start(f, {}, { executionId: e })).waitForSuspend();
        await fl.a.rt.notifyInbox(e);
        await put(fl.a.eventStore, e, { topic: "a", messageId: "a1", payload: "S1" });
        await put(fl.a.eventStore, e, { topic: "a", messageId: "a2", payload: "S2" });
        await put(raw.eventStore, e, { topic: "a", messageId: "a3", payload: "P3" });
        await fl.b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
        await fl.b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
        expect(quarantinedOf(await fl.b.rt.loadState(e)).a?.map((x) => x.state)).toEqual([
          "held",
          "held",
        ]);
        const bad = await fl.a.rt
          .releaseInbox(e, { topic: "a", messageId: "a2" }, { principal: OP })
          .catch((x) => x);
        expect(bad).toBeInstanceOf(InboxQuarantineRefusedError);
        expect((bad as InboxQuarantineRefusedError).reason).toBe("invalid");
        expect(await eventsByKind(raw.eventStore, e, "INBOX_RELEASED")).toHaveLength(0);
        // discard the head (B needs no ability to open it): a2 is now first.
        await fl.b.rt.releaseInbox(
          e,
          { topic: "a", messageId: "a1", disposition: "discard", reason: "poison" },
          { principal: OP }
        );
        expect(quarantinedOf(await fl.b.rt.loadState(e)).a?.map((x) => x.key)).toEqual([
          keyOf("a2"),
        ]);
        const [disc] = await eventsByKind(raw.eventStore, e, "INBOX_RELEASED");
        expect(disc?.payload).toMatchObject({
          topic: "a",
          messageId: "a1",
          disposition: "discard",
          operator: OP,
          reason: "poison",
        });
        // a sender's retry of the discarded id is a duplicate: skipped, nothing delivered
        await put(raw.eventStore, e, { topic: "a", messageId: "a1", payload: "RESENT" });
        await fl.a.rt.releaseInbox(e, { topic: "a", messageId: "a2" }, { principal: OP });
        await until(async () =>
          consumedOf(await raw.eventStore.read(e)).some((c) => c.messageId === keyOf("a1"))
        );
        await parked(fl.a, e);
        const consumed = consumedOf(await fl.a.eventStore.read(e)); // A's view: payloads opened
        const resent = consumed.find((c) => c.messageId === keyOf("a1"));
        expect(resent?.payload).toBeNull(); // the duplicate advanced the cursor and delivered nothing
        expect(consumed.filter((c) => c.payload !== null).map((c) => c.messageId)).toEqual([
          keyOf("a2"),
          keyOf("a3"),
        ]);
        // a sealed S2 / plain P3 reached the flow in queue order: replay it on a fresh capable node
        const replay = await fl.a2().rt.loadState(e);
        expect(
          (replay?.variables._waitAnswers as Record<string, { payload: unknown }>)["#0"]?.payload
        ).toBeDefined();
      });

      it("select determinism: a capable and an incapable node fold the same state; a select whose only arm is held stays parked and wakes on release", async () => {
        const raw = backend.make();
        const fl = fleet(raw, { a: { inboxAutoRelease: false } });
        const f = collector(1, ["a"]);
        fl.a.rt.registerFlow(f.definition, f.runner);
        fl.b.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await (await fl.a.rt.start(f, {}, { executionId: e })).waitForSuspend();
        await fl.a.rt.notifyInbox(e);
        await put(fl.a.eventStore, e, { topic: "a", messageId: "a1", payload: "S" });
        await fl.b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP });
        const sa = await fl.a.rt.loadState(e);
        const sb = await fl.b.rt.loadState(e);
        for (const k of ["_inbox", "_quarantined", "_waitAnswers"])
          expect(sa?.variables[k]).toEqual(sb?.variables[k]);
        await fl.b.rt.notifyInbox(e).catch(() => undefined);
        await fl.a.rt.notifyInbox(e).catch(() => undefined);
        expect((await fl.a.rt.loadState(e))?.status).toBe("suspended"); // only arm is held
        await fl.a.rt.releaseInbox(e, { topic: "a", messageId: "a1" }, { principal: OP });
        expect(await done(fl.a, e)).toEqual([["a", "S"]]);
      });

      it("refusals: running owner, no message, bad reason, cap, release by an incapable node, repeat release is idempotent", async () => {
        const s = await scene({ b: { inboxQuarantineMax: 1 }, total: 2, withB1: false });
        const rr = async (p: Promise<unknown>) =>
          (await p.catch((x) => x)) as InboxQuarantineRefusedError | undefined;
        expect(
          (await rr(s.b.rt.quarantineInbox(s.e, { topic: "nothing" }, { principal: OP })))?.reason
        ).toBe("invalid");
        expect(
          (
            await rr(
              s.b.rt.quarantineInbox(
                s.e,
                { topic: "a", reason: "x".repeat(257) },
                { principal: OP }
              )
            )
          )?.reason
        ).toBe("invalid");
        // cap 1: put a second sealed message behind a2? a2 is plain; quarantine a1 then the cap is reached.
        await s.b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
        await put(s.a.eventStore, s.e, { topic: "c", messageId: "c1", payload: "S" });
        expect(
          (await rr(s.b.rt.quarantineInbox(s.e, { topic: "c" }, { principal: OP })))?.reason
        ).toBe("invalid");
        // release by B (incapable) is a typed sealed error, nothing appended
        const before = await kindsOf(s.raw.eventStore, s.e);
        const err = await s.b.rt
          .releaseInbox(s.e, { topic: "a", messageId: "a1" }, { principal: OP })
          .catch((x) => x);
        expect(err).toBeInstanceOf(SealedPayloadUnreadableError);
        expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
        // a repeat release by a capable node: first changes, second is an idempotent no-op
        const r1 = await s.a.rt.releaseInbox(
          s.e,
          { topic: "a", messageId: "a1" },
          { principal: OP }
        );
        expect(r1.changed).toBe(true);
        await done(s.a, s.e).catch(() => undefined);
        const mark = (await kindsOf(s.raw.eventStore, s.e)).length;
        const r2 = await s.a.rt.releaseInbox(
          s.e,
          { topic: "a", messageId: "a1" },
          { principal: OP }
        );
        expect(r2.changed).toBe(false);
        expect((await kindsOf(s.raw.eventStore, s.e)).length).toBe(mark);
      });

      it("a quarantine on a RUNNING owner is `not-parked`, retryable, and appends nothing", async () => {
        const raw = backend.make();
        const { flow, Latch, slow } = await import("./__tests__/r2Harness");
        const { build, sealedSnapshots } = await import("./__tests__/r2Harness");
        const { sealingStore } = await import("./__tests__/quarantineHarness");
        const { InMemoryKeyStore } = await import("@loom/plugin-crypto");
        const latch = new Latch();
        const b = build({}, { ...raw, latch });
        const sealing = sealingStore(raw.eventStore, new InMemoryKeyStore());
        const a = build(
          {},
          {
            ...raw,
            eventStore: sealing,
            snapshotStore: sealedSnapshots(sealing, raw.snapshotStore),
          }
        );
        const f = flow("busy", async (ctx) => {
          await ctx.run(slow, {});
          return "x";
        });
        for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await b.rt.start(f, {}, { executionId: e });
        await latch.entered;
        await until(async () => (await kindsOf(raw.eventStore, e)).includes("STEP_STARTED"));
        await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: "S" });
        const before = await kindsOf(raw.eventStore, e);
        const err = await b.rt
          .quarantineInbox(e, { topic: "a" }, { principal: OP })
          .catch((x) => x);
        expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
        expect(err.reason).toBe("not-parked");
        expect(err.retryable).toBe(true);
        expect(await kindsOf(raw.eventStore, e)).toEqual(before);
        expect(await quarantineHead(raw.eventStore, e)).toBeNull();
        latch.release();
      });
    }
  );
}
