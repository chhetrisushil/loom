import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import {
  build,
  crashHarness,
  echo,
  eventsOf,
  flow,
  kinds,
  settle,
  until,
} from "./__tests__/r2Harness";
import { recoverAbandoned } from "./recoverAbandoned";

// ADR 0109 D2 / D8 — the frozen DST criterion of ADR 0052, as a SWEEP: kill the process at EVERY
// append of a two-generation conversation (the predecessor's, the successor's, the commit), reboot a
// fresh process over the surviving logs, drive the EXISTING recovery (no new sweep exists), and
// require the same end state every time: exactly one live successor, the continuation committed
// once, both messages delivered, each exactly once.

const on = { continueAsNewEnabled: true } as const;

const conversation = () =>
  flow<{ first?: string }, unknown>("conv", async (ctx, input) => {
    if (input?.first === undefined) {
      const m1 = unwrapTainted(await ctx.receive<string>("q")) as string;
      await ctx.run(echo, m1);
      return ctx.continueAsNew({ first: m1 });
    }
    const m2 = unwrapTainted(await ctx.receive<string>("q")) as string;
    return [input.first, m2];
  });

const appendsOf = async (store: EventStore): Promise<number> =>
  (await store.read("p")).length + (await store.read("p~1")).length;

async function nominalAppends(): Promise<number> {
  const inner = new InMemoryAsyncEventStore();
  const h = build(on, { eventStore: inner });
  const f = conversation();
  h.rt.registerFlow(f.definition, f.runner);
  await settle(await h.rt.start(f, {}, { executionId: "p" }));
  await h.rt.send("p", { topic: "q", payload: "m1", messageId: "m1" });
  await until(async () => (await h.rt.loadState("p~1"))?.status === "suspended");
  await h.rt.send("p", { topic: "q", payload: "m2", messageId: "m2" });
  await until(async () => (await h.rt.loadState("p~1"))?.status === "completed");
  return appendsOf(inner);
}

describe("R1b D2 — crash-point sweep", () => {
  it("a crash at ANY append converges to: one successor, one commit, both messages once each", async () => {
    const total = await nominalAppends();
    expect(total).toBeGreaterThanOrEqual(10);
    for (let k = 1; k <= total; k++) {
      let appended = 0;
      const c = crashHarness(
        (e) => (e.executionId === "p" || e.executionId === "p~1") && ++appended === k,
        {
          deps: on,
        }
      );
      const { inner, h } = c;
      const where = `crash at append ${k}/${total}`;
      const f = conversation();
      h.rt.registerFlow(f.definition, f.runner);
      // The owner's process sends while it is alive (its own notify wakes the parked owner); once it
      // has died, a live process that owns no flow does.
      const sender = c.process();
      const sendTo = async (m: string) =>
        (c.crash.crashed ? sender : h.rt)
          .send("p", { topic: "q", payload: m, messageId: m })
          .catch((e: unknown) => {
            if (!/No execution|will never consume/.test(String(e))) throw e;
          });
      await h.rt.start(f, {}, { executionId: "p" }).catch(() => undefined);
      await until(
        async () =>
          c.crash.crashed ||
          (await inner.read("p")).some((e) => e.eventType === "EXECUTION_SUSPENDED")
      );
      await sendTo("m1");
      await until(
        async () =>
          c.crash.crashed ||
          (await inner.read("p~1")).some((e) => e.eventType === "EXECUTION_SUSPENDED")
      );
      await sendTo("m2");
      await until(
        async () =>
          c.crash.crashed ||
          (await inner.read("p~1")).some((e) => e.eventType === "EXECUTION_COMPLETED")
      );

      const rt2 = await c.reboot();
      rt2.registerFlow(f.definition, f.runner);
      if ((await inner.read("p")).length === 0) continue; // the start never became durable
      const service = new TimerService(rt2, c.timers);
      for (let round = 0; round < 14; round++) {
        if ((await rt2.loadState("p~1"))?.status === "completed") break;
        await service.tick(Date.now() + 1e9);
        await recoverAbandoned(rt2, { source: inner as EventStore, isAbandoned: () => true });
        await until(async () => true); // one scheduler turn
        await new Promise((r) => setTimeout(r, 12));
      }
      // m1 may not have been durably delivered if the crash predates its send: re-send what a
      // client would (the same messageIds: the dedupe window makes it idempotent)
      if ((await rt2.loadState("p~1"))?.status !== "completed") {
        for (const m of ["m1", "m2"]) {
          await rt2.send("p", { topic: "q", payload: m, messageId: m }).catch(() => undefined);
        }
        for (let round = 0; round < 14; round++) {
          if ((await rt2.loadState("p~1"))?.status === "completed") break;
          await service.tick(Date.now() + 1e9);
          await recoverAbandoned(rt2, { source: inner as EventStore, isAbandoned: () => true });
          await new Promise((r) => setTimeout(r, 12));
        }
      }

      const succ = await rt2.loadState("p~1");
      expect(succ?.status, where).toBe("completed");
      expect(succ?.variables._output, where).toEqual(["m1", "m2"]);
      expect((await rt2.loadState("p"))?.status, where).toBe("continued");
      // exactly one live successor, the commit landed exactly once
      expect(
        (await inner.read("p~1")).filter((e) => e.sequence === 0),
        where
      ).toHaveLength(1);
      expect(await eventsOf(inner, "p", "EXECUTION_CONTINUED"), where).toHaveLength(1);
      expect(await eventsOf(inner, "p~1", "EXECUTION_COMPLETED"), where).toHaveLength(1);
      // never doubled: m1 consumed once on p, m2 once on p~1
      const ids = async (id: string) =>
        (await eventsOf(inner, id, "MESSAGE_CONSUMED")).map(
          (e) => (e.payload as { payload: unknown }).payload
        );
      expect(await ids("p"), where).toEqual(["m1"]);
      expect(await ids("p~1"), where).toEqual(["m2"]);
    }
  }, 240_000);

  it("a crash between the successor's start and the commit leaves a running predecessor and a started successor; recovery commits once", async () => {
    const c = crashHarness((e) => e.executionId === "p" && e.eventType === "EXECUTION_CONTINUED", {
      deps: on,
    });
    const { inner, h } = c;
    const f = conversation();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "p" }));
    await h.rt.send("p", { topic: "q", payload: "m1", messageId: "m1" });
    await until(async () => c.crash.crashed);
    expect((await inner.read("p~1"))[0]?.eventType).toBe("EXECUTION_STARTED"); // successor FIRST
    expect(await kinds(inner, "p")).not.toContain("EXECUTION_CONTINUED"); // ...then the commit: lost
    expect((await c.process().loadState("p"))?.status).toBe("running"); // the predecessor stays running

    // a message sent now resolves FORWARD to the successor (the start-to-commit window), not to a
    // body that is about to stop
    const sent = await c.process().send("p", { topic: "q", payload: "m2", messageId: "m2" });
    expect(sent.executionId).toBe("p~1");

    const rt2 = await c.reboot();
    rt2.registerFlow(f.definition, f.runner);
    const service = new TimerService(rt2, c.timers);
    await until(async () => {
      await service.tick(Date.now() + 1e9);
      await recoverAbandoned(rt2, { source: inner as EventStore, isAbandoned: () => true });
      return (await rt2.loadState("p~1"))?.status === "completed";
    }, 8000);
    expect((await rt2.loadState("p~1"))?.variables._output).toEqual(["m1", "m2"]);
    expect(await eventsOf(inner, "p", "EXECUTION_CONTINUED")).toHaveLength(1);
    expect((await inner.read("p~1")).filter((e) => e.sequence === 0)).toHaveLength(1);
    expect((await eventsOf(inner, "p~1", "MESSAGE_CONSUMED")).length).toBe(1);
  });

  it("a crash BEFORE the successor's start leaves no successor; recovery re-drives and starts exactly one", async () => {
    const c = crashHarness((e) => e.executionId === "p~1" && e.sequence === 0, { deps: on });
    const { inner, h } = c;
    const f = conversation();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "p" }));
    await h.rt.send("p", { topic: "q", payload: "m1", messageId: "m1" });
    await until(async () => c.crash.crashed);
    expect(await inner.read("p~1")).toEqual([]);
    expect(await kinds(inner, "p")).not.toContain("EXECUTION_CONTINUED");

    const rt2 = await c.reboot();
    rt2.registerFlow(f.definition, f.runner);
    await until(async () => {
      await recoverAbandoned(rt2, { source: inner as EventStore, isAbandoned: () => true });
      return (await rt2.loadState("p~1"))?.status === "suspended";
    }, 8000);
    expect(await eventsOf(inner, "p", "EXECUTION_CONTINUED")).toHaveLength(1);
    await rt2.send("p", { topic: "q", payload: "m2", messageId: "m2" });
    await until(async () => (await rt2.loadState("p~1"))?.status === "completed");
    expect((await rt2.loadState("p~1"))?.variables._output).toEqual(["m1", "m2"]);
  });
});
