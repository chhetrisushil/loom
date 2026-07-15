import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { iterateExecutionIds } from "./types";

const evt = (executionId: string) => ({
  id: `${executionId}-0`,
  workflowId: "wf",
  executionId,
  eventType: "EXECUTION_STARTED",
  sequence: 0,
  timestamp: 1,
  payload: {},
});

describe("iterateExecutionIds (SP-2)", () => {
  it("prefers the paged surface and yields every id exactly once", async () => {
    const store = new InMemoryAsyncEventStore();
    const ids = Array.from({ length: 12 }, (_, i) => `e-${String(i).padStart(2, "0")}`);
    for (const id of ids) await store.append(evt(id));
    const seen: string[] = [];
    for await (const id of iterateExecutionIds(store, 5)) seen.push(id);
    expect(seen).toEqual(ids);
  });

  it("falls back to listExecutions when pages are unsupported", async () => {
    const source = { listExecutions: async () => ["b", "a"] };
    const seen: string[] = [];
    for await (const id of iterateExecutionIds(source)) seen.push(id);
    expect(seen).toEqual(["b", "a"]); // fallback preserves the store's order
  });

  it("refuses a source with neither surface", async () => {
    const iterator = iterateExecutionIds({})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/cannot be enumerated/);
  });
});
