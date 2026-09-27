import { runEventStoreDecoratorConformance } from "@loom/conformance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { faultInjectingStore } from "./faultStore";
import { splitmix64 } from "./rng";

const env = (
  executionId: string,
  sequence: number,
  eventType = "STEP_COMPLETED"
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "w",
  executionId,
  eventType,
  sequence,
  timestamp: sequence,
  payload: { stepId: "pay" },
});

async function appendMany(
  storeAppend: (e: EventEnvelope) => Promise<void>,
  n: number
): Promise<number> {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    try {
      await storeAppend(env("e1", i));
      ok++;
    } catch {
      // injected rejection
    }
  }
  return ok;
}

describe("faultInjectingStore", () => {
  it("with an empty model, is a transparent pass-through (zero faults)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const fis = faultInjectingStore(inner, { mode: "explore", rng: splitmix64(1n), model: {} });
    await appendMany(fis.store.append.bind(fis.store), 5);
    expect(fis.draws).toEqual([]);
    expect(fis.crashed).toBe(false);
    expect((await inner.read("e1")).length).toBe(5);
  });

  it("crash swallows the triggering append and all later ones", async () => {
    const inner = new InMemoryAsyncEventStore();
    const fis = faultInjectingStore(inner, {
      mode: "explore",
      rng: splitmix64(1n),
      model: { crashBeforeAppend: 1 }, // crash on the very first append
    });
    await appendMany(fis.store.append.bind(fis.store), 5);
    expect(fis.crashed).toBe(true);
    expect((await inner.read("e1")).length).toBe(0); // nothing persisted
    expect(fis.dropped.length).toBe(5);
    expect(fis.draws.filter((d) => d.kind === "crash").length).toBe(1);
  });

  it("explore then replay: recorded draws reproduce the exact durable outcome", async () => {
    // Explore with a mixed model, capture what happened.
    const innerA = new InMemoryAsyncEventStore();
    const explore = faultInjectingStore(innerA, {
      mode: "explore",
      rng: splitmix64(7n),
      model: { appendReject: 0.5 },
    });
    const okA = await appendMany(explore.store.append.bind(explore.store), 8);
    const persistedA = (await innerA.read("e1")).map((e) => e.sequence);
    const schedule = [...explore.draws];
    expect(schedule.length).toBeGreaterThan(0); // the model actually fired something

    // Replay the recorded schedule against a fresh store — no rng involved.
    const innerB = new InMemoryAsyncEventStore();
    const replay = faultInjectingStore(innerB, { mode: "replay", draws: schedule });
    const okB = await appendMany(replay.store.append.bind(replay.store), 8);
    const persistedB = (await innerB.read("e1")).map((e) => e.sequence);

    expect(okB).toBe(okA);
    expect(persistedB).toEqual(persistedA);
    expect(replay.draws).toEqual(schedule);
  });

  it("restore() disables all further faults", async () => {
    const inner = new InMemoryAsyncEventStore();
    const fis = faultInjectingStore(inner, {
      mode: "explore",
      rng: splitmix64(3n),
      model: { appendReject: 1 },
    });
    fis.restore();
    const ok = await appendMany(fis.store.append.bind(fis.store), 4);
    expect(ok).toBe(4); // no rejections after restore
    expect(fis.draws).toEqual([]);
  });

  it("forwards optional store capabilities identically to the inner store", async () => {
    const inner = new InMemoryAsyncEventStore();
    const fis = faultInjectingStore(inner, { mode: "explore", rng: splitmix64(1n), model: {} });
    // InMemoryAsyncEventStore implements these optional methods — the wrapper must expose them.
    expect(typeof fis.store.readRange).toBe("function");
    expect(typeof fis.store.acquireFence).toBe("function");
    expect(typeof fis.store.copyPrefix).toBe("function");
  });
});

// ── L1 / ADR 0074 Amendment — the fault store carries the whole optional SPI ───────────
// With no faults drawn it must be indistinguishable from the store it wraps.
runEventStoreDecoratorConformance(
  "faultInjectingStore",
  (inner) => faultInjectingStore(inner, { mode: "replay", draws: [] }).store
);

describe("faultInjectingStore — appendBatch draws ONE fault per batch (the coalescing path)", () => {
  it("an appendReject rejects the whole batch and lands none of it", async () => {
    const inner = new InMemoryAsyncEventStore();
    const f = faultInjectingStore(inner, {
      mode: "replay",
      draws: [
        {
          tick: 0,
          kind: "appendReject",
          envelopeId: "a-0",
          sequence: 0,
          eventType: "STEP_COMPLETED",
        },
      ],
    });
    await expect(f.store.appendBatch!([env("a", 0), env("b", 0)])).rejects.toThrow(
      /batch rejection/
    );
    expect(await inner.read("a")).toEqual([]);
    expect(await inner.read("b")).toEqual([]);
    expect(f.draws.map((d) => d.kind)).toEqual(["appendReject"]);
    // The next batch is a new tick — and lands whole, in one round-trip.
    await f.store.appendBatch!([env("a", 0), env("b", 0)]);
    expect((await inner.read("b")).length).toBe(1);
  });

  it("a crash swallows the batch and every later append; restore() reboots", async () => {
    const inner = new InMemoryAsyncEventStore();
    const f = faultInjectingStore(inner, {
      mode: "replay",
      draws: [
        { tick: 0, kind: "crash", envelopeId: "a-0", sequence: 0, eventType: "STEP_COMPLETED" },
      ],
    });
    await f.store.appendBatch!([env("a", 0), env("b", 0)]);
    await f.store.append(env("c", 0));
    expect(f.crashed).toBe(true);
    expect(f.dropped.map((e) => e.id)).toEqual(["a-0", "b-0", "c-0"]);
    expect(await inner.read("a")).toEqual([]);
    f.restore();
    await f.store.appendBatch!([env("a", 0)]);
    expect((await inner.read("a")).length).toBe(1);
  });

  it("explore mode draws once per batch, so a seeded run replays identically", async () => {
    const run = async () => {
      const f = faultInjectingStore(new InMemoryAsyncEventStore(), {
        mode: "explore",
        rng: splitmix64(7n),
        model: { appendReject: 0.5 },
      });
      for (let i = 0; i < 20; i++) {
        await f.store.appendBatch!([env(`x${i}`, 0), env(`y${i}`, 0)]).catch(() => {});
      }
      return f.draws;
    };
    const first = await run();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((d) => d.tick < 20)).toBe(true); // one tick per batch, not per envelope
    expect(await run()).toEqual(first);
  });
});
