import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { DuplicateEnvelopeIdError, DuplicateSequenceError } from "./writeConflicts";

// The reference store's write conflicts (#306, #309). The portable clauses live in
// `runEventStoreConformance` and run against every backend; what belongs HERE is the part
// the kit deliberately cannot state — cross-execution id uniqueness, which a single log
// enforces and a sharded topology cannot — plus the index maintenance that only a store
// owning its own id index has to get right.

function evt(executionId: string, sequence: number, id?: string): EventEnvelope {
  return {
    id: id ?? `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: 1000 + sequence,
    payload: { sequence },
  };
}

describe("InMemoryAsyncEventStore write conflicts", () => {
  it("rejects a re-used id ACROSS executions, like a single SQL log's PRIMARY KEY", async () => {
    // Stricter than the portable contract requires, and deliberately so: one in-memory
    // store is one log, exactly like one SQLite file or one Postgres database. The
    // conformance kit cannot assert this because ShardedEventStore is also a conforming
    // EventStore and cannot provide it.
    const store = new InMemoryAsyncEventStore();
    await store.append(evt("a", 0));
    await expect(store.append(evt("b", 0, "a-0"))).rejects.toThrow(DuplicateEnvelopeIdError);
    expect(await store.read("b")).toEqual([]);
  });

  it("reports a lost SEQUENCE race as a sequence conflict, not as an id conflict", async () => {
    // Ids are conventionally derived from `${executionId}-${sequence}`, so a lost slot race
    // trips BOTH constraints. The sequence is the actionable one — it says another writer
    // reached the slot — and reporting the id would describe a bug that isn't there.
    const store = new InMemoryAsyncEventStore();
    await store.append(evt("c", 0));
    await expect(store.append(evt("c", 0))).rejects.toThrow(DuplicateSequenceError);
  });

  it("frees ids on truncatePrefix, so a compacted range can be re-appended", async () => {
    const store = new InMemoryAsyncEventStore();
    for (let i = 0; i < 4; i++) await store.append(evt("d", i));
    await store.truncatePrefix("d", 2); // drops 1..2, keeps 0 (anchor) and 3
    expect((await store.read("d")).map((e) => e.sequence)).toEqual([0, 3]);
    // The ids of the compacted events must have gone with them — an index that outlives
    // its events refuses writes for reasons the caller can neither see nor fix.
    await expect(store.append(evt("d", 1))).resolves.toBeUndefined();
    expect((await store.read("d")).map((e) => e.sequence)).toEqual([0, 1, 3]);
  });

  it("frees ids on deleteExecution, so an erased execution can be re-created", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(evt("e", 0));
    await store.deleteExecution("e");
    await expect(store.append(evt("e", 0))).resolves.toBeUndefined();
    expect(await store.read("e")).toHaveLength(1);
  });

  it("keeps copyPrefix all-or-nothing when a re-stamped id collides", async () => {
    // copyPrefix re-stamps ids as `${toExecutionId}-${sequence}`, so forking into a target
    // that already holds events collides. The target must be left exactly as it was —
    // the same shape the SQL backends get from INSERT … SELECT aborting on the key.
    const store = new InMemoryAsyncEventStore();
    for (let i = 0; i < 3; i++) await store.append(evt("src", i));
    await store.append(evt("dst", 1));
    const before = await store.read("dst");

    await expect(store.copyPrefix("src", "dst", 2, { forkedFrom: "src" })).rejects.toThrow(
      DuplicateEnvelopeIdError
    );
    expect(await store.read("dst")).toEqual(before);
  });

  it("copies into a fresh target as before", async () => {
    const store = new InMemoryAsyncEventStore();
    for (let i = 0; i < 3; i++) await store.append(evt("src2", i));
    await store.copyPrefix("src2", "fork", 1, { forkedFrom: "src2" });
    const copied = await store.read("fork");
    expect(copied.map((e) => e.sequence)).toEqual([0, 1]);
    expect(copied.map((e) => e.id)).toEqual(["fork-0", "fork-1"]);
    // …and the copies claimed their ids: a later append re-using one is refused.
    await expect(store.append(evt("fork", 5, "fork-0"))).rejects.toThrow(DuplicateEnvelopeIdError);
  });
});
