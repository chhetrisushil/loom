import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { StaleFenceError } from "./fencing";

function makeEnvelope(
  executionId: string,
  sequence: number,
  fence?: number
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}${fence !== undefined ? `-f${fence}` : ""}`,
    workflowId: "wf",
    executionId,
    eventType: "TEST_EVENT",
    sequence,
    timestamp: 1000 + sequence,
    payload: {},
    ...(fence !== undefined && { metadata: { fence } }),
  };
}

// K9.4 — fencing at the store append: the point where all writers converge.
describe("EventStore fencing (K9.4)", () => {
  it("acquireFence is monotonic per execution", async () => {
    const store = new InMemoryAsyncEventStore();
    expect(await store.acquireFence("a")).toBe(1);
    expect(await store.acquireFence("a")).toBe(2);
    expect(await store.acquireFence("a")).toBe(3);
    expect(await store.acquireFence("b")).toBe(1); // independent per execution
  });

  it("accepts appends carrying the current (or newer) token", async () => {
    const store = new InMemoryAsyncEventStore();
    const fence = await store.acquireFence("a");
    await store.append(makeEnvelope("a", 0, fence));
    expect((await store.read("a")).length).toBe(1);
  });

  it("rejects a zombie append carrying a stale token", async () => {
    const store = new InMemoryAsyncEventStore();
    const old = await store.acquireFence("a"); // worker 1
    await store.append(makeEnvelope("a", 0, old));
    await store.acquireFence("a"); // worker 2 re-dispatch → fence 2

    await expect(store.append(makeEnvelope("a", 1, old))).rejects.toThrow(StaleFenceError);
    expect((await store.read("a")).length).toBe(1); // the zombie write never landed
  });

  it("rejects an unfenced append to a fenced execution (enforcement is unbypassable once enabled)", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.acquireFence("a");
    await expect(store.append(makeEnvelope("a", 0))).rejects.toThrow(StaleFenceError);
  });

  it("leaves executions that never acquired a fence completely untouched (G2)", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.acquireFence("fenced-one");
    await store.append(makeEnvelope("unfenced", 0)); // no token, no fence row → legacy path
    await store.append(makeEnvelope("unfenced", 1));
    expect((await store.read("unfenced")).length).toBe(2);
  });

  it("carries executionId + tokens on the error for observability", async () => {
    const store = new InMemoryAsyncEventStore();
    const old = await store.acquireFence("a");
    await store.acquireFence("a");
    const err = await store.append(makeEnvelope("a", 0, old)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleFenceError);
    expect(err as StaleFenceError).toMatchObject({
      executionId: "a",
      staleFence: 1,
      currentFence: 2,
    });
  });
});
