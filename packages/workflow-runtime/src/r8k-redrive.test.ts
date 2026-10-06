import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import {
  RedriveExhaustedError,
  type Redriver,
  TimerService,
  redriveDelayMs,
  scheduleRedrive,
} from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";

// ADR 0118 D4 — the live re-driver: a `contended` resume leaves a due-later row, `TimerService`
// fires it through the registered re-drivers with backoff, and gives up exactly once.

function boot(redrivers: Redriver[], opts: { max?: number; batch?: number } = {}) {
  const timers = new InMemoryTimerStore();
  const errors: unknown[] = [];
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    timerStore: timers,
  });
  const service = new TimerService(runtime, timers, {
    redrivers,
    redriveBackoff: { random: () => 0.999 }, // the largest jitter: delays are deterministic
    ...(opts.max !== undefined && { maxRedriveAttempts: opts.max }),
    ...(opts.batch !== undefined && { batch: opts.batch }),
    onError: (_id, err) => errors.push(err),
    now: () => 0,
  });
  return { timers, service, errors, runtime };
}

const rows = async (t: InMemoryTimerStore) => t.due(Number.MAX_SAFE_INTEGER);

describe("R8k D4 — backoff", () => {
  it("is exponential with full jitter from the injected rng, capped", () => {
    const hi = { random: () => 0.999999 };
    expect(redriveDelayMs(0, hi)).toBe(199);
    expect(redriveDelayMs(1, hi)).toBe(399);
    expect(redriveDelayMs(3, hi)).toBe(1599);
    expect(redriveDelayMs(20, hi)).toBe(29_999); // capped at 30 s
    expect(redriveDelayMs(5, { random: () => 0 })).toBe(0);
    expect(redriveDelayMs(2, { baseMs: 100, capMs: 250, random: () => 0.5 })).toBe(125);
  });
});

describe("R8k D4 — TimerService fires a re-drive row", () => {
  it("is NOT retired as obsolete: the re-driver runs, then the row completes", async () => {
    const seen: Array<[string, number]> = [];
    const h = boot([
      async (id, { attempt }) => {
        seen.push([id, attempt]);
        return "done";
      },
    ]);
    await h.timers.schedule({ executionId: "nobody-parked", wakeAt: 100, redrive: { attempt: 2 } });
    await h.service.tick(1000);
    expect(seen).toEqual([["nobody-parked", 2]]);
    expect(await rows(h.timers)).toEqual([]);
  });

  it("contended -> the NEXT row (attempt + 1, later) is written, then the old one retired; it eventually completes with no recover()", async () => {
    let calls = 0;
    const h = boot([async () => (++calls < 3 ? "contended" : "done")]);
    await h.timers.schedule({ executionId: "p", wakeAt: 0, redrive: { attempt: 0 } });
    await h.service.tick(0);
    let pending = await rows(h.timers);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.redrive).toEqual({ attempt: 1 });
    expect(pending[0]?.wakeAt).toBeGreaterThan(0); // due LATER (full jitter, rng 0.999 -> 399)
    await h.service.tick(10_000);
    pending = await rows(h.timers);
    expect(pending[0]?.redrive).toEqual({ attempt: 2 });
    await h.service.tick(100_000);
    expect(calls).toBe(3);
    expect(await rows(h.timers)).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("exhaustion reports onError ONCE and leaves the execution to recover() (no row left)", async () => {
    let calls = 0;
    const h = boot(
      [
        async () => {
          calls++;
          return "contended" as const;
        },
      ],
      { max: 3 }
    );
    await h.timers.schedule({ executionId: "p", wakeAt: 0, redrive: { attempt: 0 } });
    for (let t = 0; t < 10; t++) await h.service.tick(t * 1_000_000);
    expect(calls).toBe(3); // attempts 0, 1, 2
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(RedriveExhaustedError);
    expect(await rows(h.timers)).toEqual([]);
  });

  it("a re-driver that THROWS is a contended attempt, not a dropped row", async () => {
    let calls = 0;
    const h = boot([
      async () => {
        if (++calls === 1) throw new Error("boom");
        return "done";
      },
    ]);
    await h.timers.schedule({ executionId: "p", wakeAt: 0, redrive: { attempt: 0 } });
    await h.service.tick(0);
    expect((await rows(h.timers))[0]?.redrive).toEqual({ attempt: 1 });
    await h.service.tick(1_000_000);
    expect(calls).toBe(2);
    expect(await rows(h.timers)).toEqual([]);
  });

  it("every re-driver 'noop' retires the row; the first non-noop verdict wins", async () => {
    const order: string[] = [];
    const h = boot([
      async () => {
        order.push("a");
        return "noop" as const;
      },
      async () => {
        order.push("b");
        return "done" as const;
      },
      async () => {
        order.push("c");
        return "done" as const;
      },
    ]);
    await h.timers.schedule({ executionId: "p", wakeAt: 0, redrive: { attempt: 0 } });
    await h.service.tick(0);
    expect(order).toEqual(["a", "b"]);
    expect(await rows(h.timers)).toEqual([]);
  });

  it("a node with NO re-driver leaves the row for one that has it (never a silent loss)", async () => {
    const h = boot([]);
    await h.timers.schedule({ executionId: "p", wakeAt: 0, redrive: { attempt: 0 } });
    await h.service.tick(0);
    expect(await rows(h.timers)).toHaveLength(1);
    const unregister = h.service.registerRedriver(async () => "done");
    await h.service.tick(0);
    expect(await rows(h.timers)).toEqual([]);
    unregister();
  });

  it("the NEXT row never collides with the row it retires, even with a zero jitter draw at wakeAt == now (P3-7)", async () => {
    const h = boot([async () => "contended" as const]);
    // random() = 0 -> delay 0; now() = 0 = the row's wakeAt: the next row would be the SAME key.
    const service = new TimerService(h.runtime, h.timers, {
      redrivers: [async () => "contended"],
      redriveBackoff: { random: () => 0 },
      now: () => 0,
    });
    await h.timers.schedule({ executionId: "p", wakeAt: 0, redrive: { attempt: 0 } });
    await service.tick(0);
    const pending = await rows(h.timers);
    expect(pending).toHaveLength(1); // the re-drive survived `complete`
    expect(pending[0]?.redrive).toEqual({ attempt: 1 });
    expect(pending[0]?.wakeAt).toBe(1);
    // and the helper's bound is explicit
    const t = new InMemoryTimerStore();
    expect((await scheduleRedrive(t, "q", 1, 10, { random: () => 0 }, 11)).wakeAt).toBe(11);
  });

  it("a node with NO re-driver does not starve plain wakes behind a batch of re-drive rows (P3-8)", async () => {
    const h = boot([], { batch: 2 });
    for (let i = 0; i < 4; i++) {
      await h.timers.schedule({ executionId: `r${i}`, wakeAt: i, redrive: { attempt: 0 } });
    }
    // a plain wake for an execution that does not exist: fired = retired as obsolete
    await h.timers.schedule({ executionId: "plain-obsolete", wakeAt: 100 });
    await h.service.tick(1000);
    expect(h.errors).toEqual([]);
    const left = (await rows(h.timers)).map((r) => r.executionId).sort();
    expect(left).toEqual(["r0", "r1", "r2", "r3"]); // the plain row was reached and retired
  });

  it("scheduleRedrive writes a flagged, due-later row", async () => {
    const t = new InMemoryTimerStore();
    const row = await scheduleRedrive(t, "p", 0, 1000, { random: () => 0.5 });
    expect(row).toEqual({ executionId: "p", wakeAt: 1100, redrive: { attempt: 0 } });
    expect(await t.due(1099)).toEqual([]);
    expect(await t.due(1100)).toEqual([row]);
  });
});
