import { unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { build, flow, tick, until } from "./__tests__/r2Harness";
import { inboxStreamId } from "./inbox";

// ADR 0110 D5.3 — the load test the design asks for before the PR lands: a burst of 10,000 sends
// to ONE parked chain. Records the timer rows written, the TimerService wake, and the drain.
//
// Honest scope: in-memory stores, one process; the numbers are about the PROTOCOL's shape (rows
// written, reads per delivery), not about a database's throughput (see tools/bench-throughput).

const N = 10_000;

describe("R2 load — a burst of 10,000 sends to one parked chain", () => {
  it("writes ONE timer row, wakes once, delivers every message in order", async () => {
    const h = build({ inboxMaxBacklog: N + 10 });
    const f = flow("drain", async (ctx) => {
      let n = 0;
      let last = -1;
      for (;;) {
        const m = unwrapTainted(await ctx.receive<number>("burst"));
        if (m !== last + 1) throw new Error(`out of order: ${m} after ${last}`);
        last = m;
        if (++n === N) return n;
      }
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: "e1" })).waitForSuspend();

    const sender = h.sibling(); // another process: no fast path, only the durable row
    const t0 = Date.now();
    // sends are SEQUENCED by one sender here so the payload order equals the stream order
    for (let i = 0; i < N; i++) await sender.send("e1", { topic: "burst", payload: i });
    const sendMs = Date.now() - t0;

    const rows = await h.timers.due(Date.now() + 1e9);
    expect(rows.map((r) => [r.executionId, r.wakeAt])).toEqual([["e1", 0]]); // N sends, ONE row

    const t1 = Date.now();
    const service = new TimerService(h.rt, h.timers);
    await service.tick(Date.now());
    const wakeMs = Date.now() - t1;
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed", 120_000);
    const drainMs = Date.now() - t1;
    expect((await h.rt.loadState("e1"))?.variables._output).toBe(N);
    expect(await h.timers.due(Date.now() + 1e9)).toEqual([]); // the row was retired
    await tick(100);
    const retained = (await h.eventStore.read(inboxStreamId("e1"))).length;
    console.log(
      `[R2 load] ${N} sends: ${sendMs} ms (${((N / sendMs) * 1000) | 0}/s); timer rows written: ${rows.length}; ` +
        `TimerService tick -> first delivery ${wakeMs} ms, all ${N} delivered ${drainMs} ms; ` +
        `inbox stream retained after trim: ${retained} of ${N}`
    );
    expect(retained).toBeLessThan(5); // consumed prefix trimmed (head + the store's sequence-0 anchor)
  }, 180_000);
});
