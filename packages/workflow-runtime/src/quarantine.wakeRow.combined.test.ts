import { type EventStore, InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import {
  OP,
  collector,
  consumedOf,
  eventsByKind,
  keyOf,
  put,
  sealingStore,
} from "./__tests__/quarantineHarness";
import { build, until } from "./__tests__/r2Harness";
import { INBOX_WAKE_AT } from "./inbox";

// ADR 0130 S5 x S6 composition: a quarantine HOLD (S5) and a head-stamped REFUSAL row (S6) on the same
// execution. A node that cannot open the held message must neither loop nor re-drive; once a capable
// node runs, the held message is auto-released in order and the execution completes.

describe("S5 quarantine hold + S6 refusal row on one execution", () => {
  it("an incapable poller neither loops nor double-drives; a capable node auto-releases in order and completes", async () => {
    const raw = {
      eventStore: new InMemoryAsyncEventStore() as EventStore,
      timers: new InMemoryTimerStore(),
    };
    const keys = new InMemoryKeyStore();
    const mkA = () => build({}, { ...raw, eventStore: sealingStore(raw.eventStore, keys) });
    const a = mkA();
    const b = build({}, { ...raw }); // no key: cannot open the sealed message
    const f = collector(2, ["a"]);
    for (const h of [a, b]) h.rt.registerFlow(f.definition, f.runner);
    const e = "s56-combined-exec";
    await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await until(async () => (await a.rt.loadState(e))?.status === "suspended", 15_000);
    await a.rt.notifyInbox(e);
    await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { v: "S1" } }); // sealed
    await put(raw.eventStore, e, { topic: "a", messageId: "a2", payload: "P2" }); // plain
    await b.rt.quarantineInbox(e, { topic: "a" }, { principal: OP }); // hold a1
    expect((await eventsByKind(raw.eventStore, e, "INBOX_QUARANTINED")).length).toBeGreaterThan(0);

    // The two rows a real fleet could leave: the ordinary inbox wake and an S6 refusal stamp at the head.
    const head = (await raw.eventStore.read(e)).length - 1;
    for (const r of await raw.timers.due(Number.MAX_SAFE_INTEGER))
      await raw.timers.complete(r.executionId, r.wakeAt);
    await raw.timers.schedule({ executionId: e, wakeAt: INBOX_WAKE_AT });
    await raw.timers.schedule({ executionId: e, wakeAt: 5, refused: { head } });

    const before = (await raw.eventStore.read(e)).length;
    let notifies = 0;
    const realNotify = b.rt.notifyInboxDetailed.bind(b.rt);
    b.rt.notifyInboxDetailed = ((...x: Parameters<typeof realNotify>) => {
      notifies++;
      return realNotify(...x);
    }) as typeof realNotify;
    let resumes = 0;
    const realResume = b.rt.resume.bind(b.rt) as (...x: unknown[]) => unknown;
    b.rt.resume = ((...x: unknown[]) => {
      resumes++;
      return realResume(...x);
    }) as never;
    const poller = new TimerService(b.rt, raw.timers, {
      isAbandoned: () => true,
      redriveBackoff: { baseMs: 100, capMs: 10_000, random: () => 1 },
    });
    const TICKS = 12;
    for (let i = 0; i < TICKS; i++) await poller.tick(1_000_000 + i * 50_000);

    expect(await raw.eventStore.read(e)).toHaveLength(before); // appended nothing
    expect(notifies).toBeGreaterThan(0); // the poll did judge the row
    expect(resumes).toBe(0); // the suspended, held execution is never re-driven
    expect(notifies).toBeLessThanOrEqual(2 * TICKS); // bounded: no hot loop
    expect((await b.rt.loadState(e))?.status).toBe("suspended");
    // the wake row survives for a capable node
    const rows = await raw.timers.due(Number.MAX_SAFE_INTEGER);
    expect(rows.some((r) => r.executionId === e && r.wakeAt === INBOX_WAKE_AT)).toBe(true);

    // A capable node (holds the key) polls: a1 is auto-released first, then a2; the flow completes.
    const c = mkA();
    c.rt.registerFlow(f.definition, f.runner);
    const capable = new TimerService(c.rt, raw.timers, { isAbandoned: () => true });
    for (let i = 0; i < 4; i++) await capable.tick(10_000_000 + i * 50_000);
    await until(async () => (await c.rt.loadState(e))?.status === "completed", 15_000);
    const log = await raw.eventStore.read(e);
    expect(consumedOf(log).map((m) => m.messageId)).toEqual([keyOf("a1"), keyOf("a2")]);
    expect(consumedOf(log).map((m) => m.inboxSeq)).toEqual([0, 1]);
    expect(log.filter((x) => x.eventType === "INBOX_RELEASED")).toHaveLength(1);
    expect((await c.rt.loadState(e))?.variables._output).toEqual([
      ["a", { v: "S1" }],
      ["a", "P2"],
    ]);
    // no row left for this execution
    expect(
      (await raw.timers.due(Number.MAX_SAFE_INTEGER)).filter((r) => r.executionId === e)
    ).toEqual([]);
  });
});
