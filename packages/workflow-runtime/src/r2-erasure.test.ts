import { unwrapTainted } from "@loom/classify";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  type KeyStore,
  PayloadShreddedError,
  isShredded,
  shredSubject,
} from "@loom/plugin-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inboxBackends } from "./__tests__/r2Backends";
import { build, eventsOf, flow, retirable, sealedSnapshots, until } from "./__tests__/r2Harness";
import { inboxStreamId } from "./inbox";
import { InboxMessageRefusedError } from "./types";

// ADR 0110 follow-up — erasure reaches a payload still in flight in the inbox stream.
//
// The stream is sealed under the OWNER's erasure subject (the crypto plugin resolves
// `__loom_inbox__:<chainId>` to the subject of the chain's generation-0 execution), so destroying
// the key makes an unconsumed payload unreadable. A consume after the erasure delivers the
// `{ $shredded: true }` marker, journaled in the owner's log like any delivery, so a replay of that
// log never consults the stream or the key again.

const PRINCIPAL_PATHS = [
  "principal.identity.tenant",
  "principal.identity.actor",
  "principal.identity.onBehalfOf",
];
const SECRET = "123-45-6789";
// What `defineConfig` registers when crypto and the inbox are on (P3-2: the consumed copy too).
const SENSITIVE = { INBOX_MESSAGE: ["payload"], MESSAGE_CONSUMED: ["payload"] };
/** `alice-*` executions belong to the subject "alice"; any other execution is its own subject. */
const subjectOf = (e: { executionId: string }): string =>
  e.executionId.startsWith("alice-") ? "alice" : e.executionId;

for (const backend of inboxBackends("erase")) {
  describe.skipIf(backend.skip === true)(`inbox erasure on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    let seq = 0;
    const id = () => `alice-${backend.name}-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

    function sealed(sealPrincipal = false) {
      const raw = backend.make();
      const keys: KeyStore = new InMemoryKeyStore();
      const store = new EncryptingEventStore(raw.eventStore, keys, {
        sensitive: {
          ...SENSITIVE,
          ...(sealPrincipal && { EXECUTION_STARTED: PRINCIPAL_PATHS }),
        },
        subjectOf,
      });
      const h = build(sealPrincipal ? { principalIdentity: "encrypted" } : {}, {
        ...raw,
        eventStore: store,
        snapshotStore: sealedSnapshots(store, raw.snapshotStore),
      });
      const erase = (executionIds: string[]) =>
        shredSubject(keys, raw.eventStore, executionIds[0] as string, {
          subjectId: "alice",
          executionIds,
          snapshotStore: raw.snapshotStore,
        });
      const rawText = async (stream: string): Promise<string> =>
        JSON.stringify(await raw.eventStore.read(stream));
      return { raw, keys, h, erase, rawText };
    }

    /**
     * Parked on a gate that is not the topic, so a message sent meanwhile stays IN FLIGHT in the
     * stream. (These tests call `shredSubject` directly on a parked owner. The coordinator does NOT
     * shred a parked owner by default: a `suspended` execution is live to it and defers the erasure;
     * `eraseSubject(..., { parked: "shred" })` is the opt-in. Neither shreds a RUNNING one.)
     */
    const parkedThenReceive = () =>
      flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        const y = unwrapTainted(await ctx.receive<unknown>("y"));
        return { y };
      });
    const finished = (h: ReturnType<typeof build>, e: string) =>
      until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);

    it("an in-flight payload is sealed at rest, and a consume after the erasure gets the marker", async () => {
      const { h, erase, rawText } = sealed();
      const f = parkedThenReceive();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
      expect(await rawText(inboxStreamId(e))).not.toContain(SECRET);
      // ...and is readable through the store while the key lives.
      const live = await h.eventStore.read(inboxStreamId(e));
      expect((live[0]?.payload as { payload: unknown }).payload).toEqual({ ssn: SECRET });

      await erase([e]);
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await finished(h, e);

      const out = (await h.rt.loadState(e))?.variables._output as { y: unknown };
      expect(isShredded(out.y)).toBe(true);
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(await rawText(e)).not.toContain(SECRET);
      expect(await rawText(inboxStreamId(e))).not.toContain(SECRET);

      // Replay determinism: the consumption is journaled once with the marker as its payload,
      // and a fresh runtime folds the same answer from the same log without the stream or key.
      const consumed = await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED");
      expect(consumed).toHaveLength(1);
      expect(isShredded((consumed[0]?.payload as { payload: unknown }).payload)).toBe(true);
      const again = await h.sibling().loadState(e, h.rt.systemOptions());
      expect(again?.variables._output).toEqual(out);
    });

    it("P3-2: a consumed payload is sealed in the owner's log too, and the flow still receives it", async () => {
      const { h, rawText } = sealed();
      // (returns a derived value: the flow's own output is not what this test is about)
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        const y = unwrapTainted(await ctx.receive<{ ssn: string }>("y"));
        return y.ssn.length;
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await finished(h, e);
      expect((await h.rt.loadState(e))?.variables._output).toBe(SECRET.length);
      // ...and the state the store hands the fold still has the payload (it is opened on read)
      const consumed = await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED");
      expect((consumed[0]?.payload as { payload: unknown }).payload).toEqual({ ssn: SECRET });
      expect(await rawText(inboxStreamId(e))).not.toContain(SECRET);
      expect(await rawText(e)).not.toContain(SECRET);
      // A fresh runtime over the same sealed log folds the same answer (replay is unchanged).
      const again = await h.sibling().loadState(e, h.rt.systemOptions());
      expect(again?.variables._output).toBe(SECRET.length);
    });

    it("P3-2: a log written BEFORE the path was sealed (plaintext consumption) still replays beside sealed ones", async () => {
      const raw = backend.make();
      const keys: KeyStore = new InMemoryKeyStore();
      // The old process's snapshot store is fenced by the same switch: its park writes a checkpoint
      // AFTER the suspension is durable, and that save must not land once the process is gone.
      const unsealed = retirable(
        new EncryptingEventStore(raw.eventStore, keys, { sensitive: {}, subjectOf }),
        raw.snapshotStore
      );
      const before = build(
        {},
        { ...raw, eventStore: unsealed.store, snapshotStore: unsealed.snapshotStore }
      );
      const f = flow("w", async (ctx) => {
        const a = unwrapTainted(await ctx.receive<string>("a"));
        const b = unwrapTainted(await ctx.receive<string>("b"));
        return [a, b.length];
      });
      before.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await before.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await before.rt.send(e, { topic: "a", payload: "plain-a", messageId: "a1" });
      // Wait for the WHOLE exchange on the old deployment: "a" consumed AND the flow parked again on
      // "b". The consumption alone is not enough: the old runtime is still running the flow, and its
      // next `receive("b")` reads the inbox through ITS store, which does not open the sealed path.
      // ...and the park's TAIL: a park saves its checkpoint after EXECUTION_SUSPENDED is durable, and
      // the status turns "suspended" before that save runs. Retiring in that gap fenced the store
      // under a live save (on Postgres, where the append is slow enough to lose the race).
      await until(async () => {
        const consumed = await eventsOf(raw.eventStore, e, "MESSAGE_CONSUMED");
        const parks = await eventsOf(raw.eventStore, e, "EXECUTION_SUSPENDED");
        const lastPark = parks[parks.length - 1]?.sequence ?? Number.POSITIVE_INFINITY;
        const checkpoint = await raw.snapshotStore.loadLatest(e);
        return (
          consumed.length === 1 &&
          parks.length === 2 &&
          lastPark > (consumed[0]?.sequence ?? 0) &&
          (checkpoint?.sequence ?? -1) >= lastPark &&
          (await before.rt.loadState(e))?.status === "suspended"
        );
      });
      // ...then the old deployment goes away. A park is followed by a fire-and-forget re-read of the
      // inbox (ADR 0110 D5 closure 2); left alive, that read could consume "b" through the unsealed
      // store and hand the flow the ciphertext envelope (`b.length` undefined).
      await unsealed.retire();
      // crypto is now turned on (a redeploy): the next consumption is sealed
      const sealedStore = new EncryptingEventStore(raw.eventStore, keys, {
        sensitive: SENSITIVE,
        subjectOf,
      });
      const after = build(
        {},
        {
          ...raw,
          eventStore: sealedStore,
          snapshotStore: sealedSnapshots(sealedStore, raw.snapshotStore),
        }
      );
      after.rt.registerFlow(f.definition, f.runner);
      await after.rt.send(e, { topic: "b", payload: SECRET, messageId: "b1" });
      await until(async () => (await after.rt.loadState(e))?.status === "completed", 8000);
      expect((await after.rt.loadState(e))?.variables._output).toEqual(["plain-a", SECRET.length]);
      const rawLog = JSON.stringify(await raw.eventStore.read(e));
      expect(rawLog).toContain("plain-a"); // the old one stays as it was written
      expect(rawLog).not.toContain(SECRET);
    });

    it("P3-5: a sender cannot forge the erasure marker", async () => {
      const { h, raw } = sealed();
      const f = parkedThenReceive();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      for (const forged of [{ $shredded: true }, { $shredded: true, note: "x" }]) {
        await expect(
          h.rt.send(e, { topic: "y", payload: forged, messageId: "forged" })
        ).rejects.toBeInstanceOf(InboxMessageRefusedError);
      }
      expect(await raw.eventStore.read(inboxStreamId(e))).toHaveLength(0);
      // Look-alikes that are not the marker are ordinary payloads.
      for (const [i, ok] of [
        { $shredded: false },
        { x: { $shredded: true } },
        [{ $shredded: true }],
      ].entries()) {
        await h.rt.send(e, { topic: "y", payload: ok, messageId: `ok${i}` });
      }
      expect(await raw.eventStore.read(inboxStreamId(e))).toHaveLength(3);
    });

    it("P2-2: a PARKED owner shredded in place can be CANCELLED (terminal, under the fence); its resume and loadState fail with the typed error and append nothing", async () => {
      const { raw, keys, h } = sealed(true);
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      const principal = { actor: "alice", tenant: "t1" };
      await (await h.rt.start(f, {}, { executionId: e, principal })).waitForSuspend();
      const before = (await raw.eventStore.read(e)).length;
      await shredSubject(keys, raw.eventStore, e, {
        subjectId: "alice",
        executionIds: [e],
        snapshotStore: raw.snapshotStore,
      });
      // The owner is still parked, its principal sealed under a key that is gone. A resume rejects
      // with the typed error rather than folding ciphertext...
      const err = await h.rt.resume(e, { eventType: "Go", payload: null }).catch((x) => x);
      expect(err).toBeInstanceOf(PayloadShreddedError);
      expect((await raw.eventStore.read(e)).length).toBe(before + 2); // only the erase intent and the tombstone
      // ...and so does the strict query, whose error carries the REDACTED view for tooling.
      const q = await h.rt.loadState(e, { principal }).catch((x) => x);
      expect(q).toBeInstanceOf(PayloadShreddedError);
      expect(JSON.stringify((q as PayloadShreddedError).redacted)).not.toContain('"actor":"alice"');
      // ...but the owner is NOT stuck: a cancel needs no sealed field.
      expect(await h.rt.cancel(e, "erased", { principal })).toBe(true);
      const log = await raw.eventStore.read(e);
      expect(log.map((x) => x.eventType).slice(-2)).toEqual([
        "PAYLOAD_SHREDDED",
        "EXECUTION_CANCELLED",
      ]);
      expect(log.at(-1)?.payload).toMatchObject({ reason: "erased" });
      expect(JSON.stringify(log)).not.toContain('"actor":"alice"');
      // terminal now: a second cancel is quiet, a resume still refuses
      expect(await h.rt.cancel(e, "again", { principal }).catch((x) => x)).toBe(false);
      expect((await raw.eventStore.read(e)).length).toBe(log.length);
    });

    it("after the erasure a send is refused loudly and appends nothing (the key is never resurrected)", async () => {
      const { h, erase, raw } = sealed();
      const f = parkedThenReceive();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "y", payload: SECRET, messageId: "m1" });
      await erase([e]);
      const before = (await raw.eventStore.read(inboxStreamId(e))).length;
      await expect(h.rt.send(e, { topic: "y", payload: "late", messageId: "m2" })).rejects.toThrow(
        /destroyed/
      );
      expect((await raw.eventStore.read(inboxStreamId(e))).length).toBe(before);
      // The pre-erasure message is still consumable as the marker; the owner is not wedged.
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await finished(h, e);
      expect(isShredded(((await h.rt.loadState(e))?.variables._output as { y: unknown }).y)).toBe(
        true
      );
    });

    it("an unrelated subject's in-flight payload is untouched by the erasure", async () => {
      const { h, erase } = sealed();
      const f = parkedThenReceive();
      h.rt.registerFlow(f.definition, f.runner);
      const alice = id();
      const bob = `bob-${backend.name}-${++seq}`;
      for (const e of [alice, bob]) {
        await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
        await h.rt.send(e, { topic: "y", payload: `for-${e}`, messageId: "m1" });
      }
      await erase([alice]);
      for (const e of [alice, bob]) {
        await h.rt.resume(e, { eventType: "Go", payload: null });
        await finished(h, e);
      }
      const bobOut = (await h.rt.loadState(bob))?.variables._output as { y: unknown };
      const aliceOut = (await h.rt.loadState(alice))?.variables._output as { y: unknown };
      expect(bobOut.y).toBe(`for-${bob}`);
      expect(isShredded(aliceOut.y)).toBe(true);
    });
  });
}
