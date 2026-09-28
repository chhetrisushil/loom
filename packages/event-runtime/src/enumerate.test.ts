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

  it("refuses a non-advancing cursor (buggy 3P store) instead of spinning", async () => {
    const stuck = {
      listExecutionsPage: async () => ({ executionIds: ["a"], nextCursor: "same" }),
    };
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const id of iterateExecutionIds(stuck)) seen.push(id);
      })()
    ).rejects.toThrow(/non-advancing cursor/);
    expect(seen.length).toBeLessThanOrEqual(2); // aborted immediately, no spin
  });

  it("refuses a source with neither surface", async () => {
    const iterator = iterateExecutionIds({})[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/cannot be enumerated/);
  });
});

describe("InMemoryAsyncEventStore paging keeps its sorted index current (L10)", () => {
  it("sees executions created and deleted between pages, and sorts once per change", async () => {
    const store = new InMemoryAsyncEventStore();
    for (const id of ["b", "d"]) await store.append(evt(id));
    expect(await store.listExecutionsPage({ limit: 1 })).toEqual({
      executionIds: ["b"],
      nextCursor: "b",
    });
    await store.append(evt("c")); // a new execution after the cursor
    await store.deleteExecution("d");
    expect(await store.listExecutionsPage({ cursor: "b", limit: 10 })).toEqual({
      executionIds: ["c"],
    });
    // A full walk with no new executions does not re-sort per page.
    for (let i = 0; i < 50; i++) await store.append(evt(`x${String(i).padStart(2, "0")}`));
    const sort = Array.prototype.sort;
    let sorts = 0;
    Array.prototype.sort = function (this: unknown[], ...args) {
      sorts++;
      return sort.apply(this, args as [((a: unknown, b: unknown) => number)?]);
    };
    try {
      let cursor: string | undefined;
      do {
        const page = await store.listExecutionsPage({
          ...(cursor !== undefined && { cursor }),
          limit: 5,
        });
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    } finally {
      Array.prototype.sort = sort;
    }
    expect(sorts).toBe(1);
  });

  it("close() drops the sorted index with the log, so a reused store never pages ghosts", async () => {
    const store = new InMemoryAsyncEventStore();
    for (const id of ["a", "b"]) await store.append(evt(id));
    expect((await store.listExecutionsPage({ limit: 10 })).executionIds).toEqual(["a", "b"]);
    await store.close();
    expect(await store.listExecutionsPage({ limit: 10 })).toEqual({ executionIds: [] });
    await store.append(evt("c"));
    expect(await store.listExecutionsPage({ limit: 10 })).toEqual({ executionIds: ["c"] });
  });
});
