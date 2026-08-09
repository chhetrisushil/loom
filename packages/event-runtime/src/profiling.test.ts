import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { ProfilingEventStore } from "./ProfilingEventStore";

const evt = (executionId: string, sequence: number): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "STEP_COMPLETED",
  sequence,
  timestamp: 1000 + sequence,
  payload: { sequence },
});

describe("ProfilingEventStore", () => {
  it("counts envelopes and round-trips separately — batching changes one, not the other", async () => {
    const store = new ProfilingEventStore(new InMemoryAsyncEventStore());
    await store.append(evt("a", 0));
    await store.appendBatch!([evt("b", 0), evt("c", 0), evt("d", 0)]);
    const p = store.writeProfile();
    // 4 envelopes over 2 round-trips: the ratio is exactly what batching improves, so the
    // profile has to distinguish them.
    expect(p.envelopes).toBe(4);
    expect(p.roundTrips).toBe(2);
  });

  it("measures real write time", async () => {
    const store = new ProfilingEventStore(new InMemoryAsyncEventStore({ latencyMs: 10 }));
    await store.append(evt("a", 0));
    const p = store.writeProfile();
    expect(p.totalWriteMs).toBeGreaterThanOrEqual(8);
    expect(p.maxWriteMs).toBeGreaterThanOrEqual(8);
    expect(p.envelopesPerSec).toBeGreaterThan(0);
  });

  it("records peak concurrency — the queue the log is absorbing", async () => {
    const store = new ProfilingEventStore(new InMemoryAsyncEventStore({ latencyMs: 20 }));
    await Promise.all(Array.from({ length: 6 }, (_, i) => store.append(evt(`x${i}`, 0))));
    expect(store.writeProfile().peakConcurrentWrites).toBeGreaterThan(1);
  });

  it("counts a failed write rather than losing it", async () => {
    const inner = new InMemoryAsyncEventStore({ failAppendWhen: (e) => e.executionId === "bad" });
    const store = new ProfilingEventStore(inner);
    await expect(store.append(evt("bad", 0))).rejects.toThrow();
    // Time spent on writes that failed is still time the workload spent writing.
    expect(store.writeProfile().roundTrips).toBe(1);
  });

  it("resets, and does not advertise appendBatch when the inner store lacks it", async () => {
    const bare = {
      append: async () => {},
      read: async () => [],
      readFrom: async () => [],
      subscribe: async () => () => {},
      close: async () => {},
    };
    const store = new ProfilingEventStore(bare);
    expect(store.appendBatch).toBeUndefined();
    await store.append(evt("a", 0));
    expect(store.writeProfile().envelopes).toBe(1);
    store.resetProfile();
    expect(store.writeProfile()).toMatchObject({ envelopes: 0, roundTrips: 0, totalWriteMs: 0 });
  });
});
