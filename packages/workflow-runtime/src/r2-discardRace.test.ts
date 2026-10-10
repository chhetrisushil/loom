import { unwrapTainted } from "@loom/classify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inboxBackends } from "./__tests__/r2Backends";
import { build, eventsOf, flow, until } from "./__tests__/r2Harness";
import { createInboxSource, cursorsOf } from "./inbox";
import type { InboxSource } from "./types";

// ADR 0110 amendment (D8), review P2-1 — a discard that lands while a notifier holds a batch it
// built from the PRE-discard cursors must win: the discarded message is never delivered.

const OPERATOR = { actor: "ops", tenant: "t1" };

for (const backend of inboxBackends("discardrace")) {
  describe.skipIf(backend.skip === true)(`discard racing a delivery on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    let seq = 0;
    const id = () => `${backend.name}-e${++seq}-${Math.random().toString(36).slice(2, 6)}`;

    it("P3-4: a discarded messageId resent is a duplicate, not a fresh message", async () => {
      const h = build({}, backend.make());
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return unwrapTainted(await ctx.receive<string>("t"));
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const m1 = await h.rt.send(e, { topic: "t", payload: "old", messageId: "same" });
      const res = await h.rt.discardInbox(
        e,
        { topic: "t", throughSeq: m1.inboxSeq },
        { principal: OPERATOR }
      );
      expect(res.skipped).toBe(1);
      // The sender retries the discarded id: accepted into the stream, but a duplicate for the owner.
      await h.rt.send(e, { topic: "t", payload: "RESENT", messageId: "same" });
      await h.rt.send(e, { topic: "t", payload: "fresh", messageId: "other" });
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      expect((await h.rt.loadState(e))?.variables._output).toBe("fresh");
    });

    for (const fenced of [true, false]) {
      it(`a notifier paused after its scan: the discard wins, nothing is delivered (park ${fenced ? "fenced" : "unfenced"})`, async () => {
        const be = backend.make();
        const real = createInboxSource(be.eventStore);
        // The notifier's FIRST non-empty scan returns its page, then holds until released.
        let armed = false;
        let paused!: () => void;
        const pausedAt = new Promise<void>((r) => {
          paused = r;
        });
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const source: InboxSource = async (chain, topic, after, limit) => {
          const page = await real(chain, topic, after, limit);
          if (armed && page.length > 0) {
            armed = false;
            paused();
            await gate;
          }
          return page;
        };
        const h = build({ inbox: source }, be);
        const f = flow("w", async (ctx) => {
          await ctx.suspend({ on: "Go" });
          return unwrapTainted(await ctx.receive<string>("t"));
        });
        h.rt.registerFlow(f.definition, f.runner);
        const e = id();
        const fence = fenced ? await h.rt.acquireFence(e) : undefined;
        await (
          await h.rt.start(f, {}, { executionId: e, ...(fence !== undefined && { fence }) })
        ).waitForSuspend();
        // A parked-on-Go owner has no inbox wait yet: the receive registers only after Go. Park on
        // the inbox wait instead, so the send wakes a notifier.
        const wake = fenced ? await h.rt.acquireFence(e) : undefined;
        await (
          await h.rt.resume(
            e,
            { eventType: "Go", payload: null },
            wake !== undefined ? { fence: wake } : undefined
          )
        ).waitForSuspend();
        armed = true;
        const m1 = await h.rt.send(e, { topic: "t", payload: "DISCARDED", messageId: "m1" });
        await pausedAt; // the notifier built its batch from cursor -1
        const res = await h.rt.discardInbox(
          e,
          { topic: "t", throughSeq: m1.inboxSeq },
          { principal: OPERATOR }
        );
        expect(res.skipped).toBe(1);
        release();
        // The notifier must refold, see the cursor, and deliver nothing.
        // (a buggy runtime has already finished the owner on the discarded message: the send is
        // then refused as closed, and the assertions below name the real failure)
        await h.rt
          .send(e, { topic: "t", payload: "FRESH", messageId: "m2" })
          .catch(() => undefined);
        await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
        const state = await h.rt.loadState(e);
        expect(state?.variables._output).toBe("FRESH");
        const consumed = await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED");
        const delivered = consumed.map((c) => (c.payload as { payload: unknown }).payload);
        expect(delivered).not.toContain("DISCARDED");
        // The log never records a consumption at or below an already-advanced cursor as an answer.
        let cursor = -1;
        for (const c of consumed) {
          const p = c.payload as { inboxSeq: number; payload: unknown; waitId: string };
          if (p.waitId !== "__loom_discard__" && p.payload !== null) {
            expect(p.inboxSeq).toBeGreaterThan(cursor);
          }
          cursor = Math.max(cursor, p.inboxSeq);
        }
        expect(cursorsOf(state?.variables ?? {}).t).toBe(m1.inboxSeq + 1);
      });
    }
  });
}
