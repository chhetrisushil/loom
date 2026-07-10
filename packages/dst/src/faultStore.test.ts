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
