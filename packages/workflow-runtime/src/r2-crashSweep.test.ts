import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { build, crashHarness, eventsOf, flow, tick, until } from "./__tests__/r2Harness";
import { recoverAbandoned } from "./recoverAbandoned";

// ADR 0110 D5 — a SWEEP, not a hand-picked list: kill the owner's process at EVERY append of a
// two-message conversation (including each half of the notify pair), reboot a fresh process over
// the surviving log, drive recovery the way a deployment would (TimerService tick + a
// recoverAbandoned pass), and require the same end state every time: both messages delivered,
// each exactly once, in order, never lost, never doubled.

const conversation = () =>
  flow("conv", async (ctx) => {
    const a = unwrapTainted(await ctx.receive<string>("q"));
    const b = unwrapTainted(await ctx.receive<string>("q"));
    return [a, b];
  });

/** Appends of the owner's log during an undisturbed run (the sweep's range). */
async function nominalAppends(): Promise<number> {
  const inner = new InMemoryAsyncEventStore();
  const h = build({}, { eventStore: inner });
  const f = conversation();
  h.rt.registerFlow(f.definition, f.runner);
  await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();
  await h.rt.send("e1", { topic: "q", payload: "m1", messageId: "m1" });
  await h.rt.send("e1", { topic: "q", payload: "m2", messageId: "m2" });
  await until(async () => (await h.rt.loadState("e1"))?.status === "completed");
  await tick(30);
  return (await inner.read("e1")).length;
}

describe("R2 D5 — crash-point sweep", () => {
  it("a crash at ANY owner append converges to: both messages, once each, in order", async () => {
    const total = await nominalAppends();
    expect(total).toBeGreaterThanOrEqual(6);
    for (const atomicBatch of [true, false]) {
      for (let k = 1; k <= total; k++) {
        let appended = 0;
        const c = crashHarness((e) => e.executionId === "e1" && ++appended === k, { atomicBatch });
        const { inner, h } = c;
        const f = conversation();
        h.rt.registerFlow(f.definition, f.runner);
        const sender = c.process(); // the sender's process: alive throughout, owns no flow
        await h.rt.start(f, {}, { executionId: "e1" }).catch(() => undefined);
        await tick(25);
        // the messages are sent by a live process; the owner may be dead, parked or mid-flight
        for (const m of ["m1", "m2"]) {
          await sender.send("e1", { topic: "q", payload: m, messageId: m }).catch((e: unknown) => {
            if (!/No execution/.test(String(e))) throw e;
          });
          await tick(25);
        }
        const rt2 = await c.reboot();
        rt2.registerFlow(f.definition, f.runner);
        const view = await inner.read("e1");
        if (view.length === 0) continue; // the start never became durable: nothing to recover

        const service = new TimerService(rt2, c.timers);
        for (let round = 0; round < 12; round++) {
          if ((await rt2.loadState("e1"))?.status === "completed") break;
          await service.tick(Date.now() + 1e9);
          await recoverAbandoned(rt2, { source: inner as EventStore, isAbandoned: () => true });
          await tick(15);
        }
        const state = await rt2.loadState("e1");
        const where = `crash at append ${k} (atomicBatch ${atomicBatch})`;
        expect(state?.status, where).toBe("completed");
        expect(state?.variables._output, where).toEqual(["m1", "m2"]);
        // never doubled: each message answers exactly one wait, and the ids are distinct
        const answers = state?.variables._waitAnswers as Record<string, { payload: unknown }>;
        expect(
          Object.values(answers).map((a) => a.payload),
          where
        ).toEqual(["m1", "m2"]);
        const ids = (await eventsOf(inner, "e1", "MESSAGE_CONSUMED")).map(
          (c) => (c.payload as { messageId: string }).messageId
        );
        expect(new Set(ids).size, where).toBe(2);
      }
    }
  }, 120_000);
});
