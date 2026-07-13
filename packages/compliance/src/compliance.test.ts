import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { SubjectIndex } from "./SubjectIndex";
import { exportSubject } from "./exportSubject";

// Subject lives in EXECUTION_STARTED input.userId; other events name no subject.
const subjectOf = (e: EventEnvelope): string | undefined =>
  e.eventType === "EXECUTION_STARTED"
    ? (e.payload as { input?: { userId?: string } }).input?.userId
    : undefined;

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

describe("SubjectIndex (T3)", () => {
  it("maps subjects to executions and back, deduped per execution", () => {
    const idx = new SubjectIndex(subjectOf);
    idx.handleEvent(ev("x1", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }));
    idx.handleEvent(ev("x1", 1, "STEP_COMPLETED", { stepId: "s", output: {} })); // no re-resolve
    idx.handleEvent(ev("x2", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }));
    idx.handleEvent(ev("x3", 0, "EXECUTION_STARTED", { input: { userId: "bob" } }));

    expect(idx.executionsOf("ann")).toEqual(["x1", "x2"]);
    expect(idx.executionsOf("bob")).toEqual(["x3"]);
    expect(idx.executionsOf("nobody")).toEqual([]);
    expect(idx.subjectOfExecution("x1")).toBe("ann");
    expect(idx.subjects()).toEqual(["ann", "bob"]);
    expect(idx.size).toBe(2);
    expect(idx.has("ann")).toBe(true);
  });

  it("fromEvents rebuilds an identical index from the log (P2)", () => {
    const events = [
      ev("x1", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }),
      ev("x2", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }),
    ];
    const live = new SubjectIndex(subjectOf);
    for (const e of events) live.handleEvent(e);
    const rebuilt = SubjectIndex.fromEvents(events, subjectOf);
    expect(rebuilt.executionsOf("ann")).toEqual(live.executionsOf("ann"));
  });

  it("ignores events that name no subject", () => {
    const idx = new SubjectIndex(subjectOf);
    idx.handleEvent(ev("x1", 0, "EXECUTION_STARTED", { input: {} }));
    expect(idx.size).toBe(0);
  });
});

describe("exportSubject (T3-R2/R3 — access + portability)", () => {
  it("assembles every execution's folded state + raw log for a subject", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(ev("x1", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }));
    await store.append(ev("x2", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }));
    await store.append(ev("x3", 0, "EXECUTION_STARTED", { input: { userId: "bob" } }));
    const index = SubjectIndex.fromEvents(
      [
        ev("x1", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }),
        ev("x2", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }),
        ev("x3", 0, "EXECUTION_STARTED", { input: { userId: "bob" } }),
      ],
      subjectOf
    );

    const out = await exportSubject("ann", { index, eventStore: store });
    expect(out.subjectId).toBe("ann");
    expect(out.executions.map((e) => e.executionId)).toEqual(["x1", "x2"]);
    expect(out.executions[0]?.events).toHaveLength(1); // raw log included by default
    expect(out.executions[0]?.state.executionId).toBe("x1");

    // Access-only view (no raw events).
    const accessOnly = await exportSubject("ann", {
      index,
      eventStore: store,
      includeEvents: false,
    });
    expect(accessOnly.executions[0]?.events).toBeUndefined();
  });

  it("returns an empty export for an unknown subject (not an error)", async () => {
    const store = new InMemoryAsyncEventStore();
    const index = new SubjectIndex(subjectOf);
    expect(await exportSubject("ghost", { index, eventStore: store })).toEqual({
      subjectId: "ghost",
      executions: [],
    });
  });

  it("skips an execution whose log was deleted by retention", async () => {
    const store = new InMemoryAsyncEventStore();
    // Index knows x1, but the store has no events for it (deleted).
    const index = SubjectIndex.fromEvents(
      [ev("x1", 0, "EXECUTION_STARTED", { input: { userId: "ann" } })],
      subjectOf
    );
    const out = await exportSubject("ann", { index, eventStore: store });
    expect(out.executions).toEqual([]);
  });
});
