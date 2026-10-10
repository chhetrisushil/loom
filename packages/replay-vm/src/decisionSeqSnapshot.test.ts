import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { foldEvents, normalizeSnapshotState } from "./foldEvents";

// ADR 0128 — `_decisions[id].seq` through a checkpoint: snapshot-at-k + tail == the full fold, for
// every k, with the snapshot's keys reordered and JSON round-tripped (what Postgres jsonb does).

const INITIAL = { executionId: "x", workflowId: "wf", workflowVersion: "1.0.0" };

function ev(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `x-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}
const dec = (sequence: number, decisionId: string, choice = decisionId) =>
  ev(sequence, "DECISION_RECORDED", { decisionId, choice });

const reorder = <T>(v: T): T => {
  const copy = JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  const d = (copy.variables as Record<string, Record<string, unknown>> | undefined)?._decisions;
  if (d !== undefined) {
    const rev = Object.fromEntries(Object.entries(d).reverse());
    (copy.variables as Record<string, unknown>)._decisions = rev;
  }
  return copy as T;
};

const seqs = (s: { variables: Record<string, unknown> }) =>
  Object.fromEntries(
    Object.entries((s.variables._decisions ?? {}) as Record<string, { seq?: number }>).map(
      ([k, v]) => [k, v.seq]
    )
  );

describe("_decisions seq through a checkpoint (ADR 0128)", () => {
  // a repeat across the boundary ("b" at 3 and 6), array-index-like ids
  const log = [
    ev(0, "EXECUTION_STARTED", {}),
    dec(1, "b"),
    dec(2, "10"),
    dec(3, "2"),
    dec(4, "a"),
    dec(5, "b", "again"),
    dec(6, "0"),
    dec(7, "2", "again"),
  ];

  it("snapshot at every k (keys reordered, JSON round-tripped) + tail == the full fold", () => {
    const full = foldEvents(log, INITIAL);
    expect(seqs(full)).toEqual({ b: 1, "10": 2, "2": 3, a: 4, "0": 6 });
    for (let k = 1; k <= log.length; k++) {
      const snap = reorder(foldEvents(log.slice(0, k), INITIAL));
      const resumed = foldEvents(log.slice(k), snap);
      expect(seqs(resumed), `k=${k}`).toEqual(seqs(full));
      expect(resumed.variables._decisions, `k=${k}`).toEqual(full.variables._decisions);
    }
  });

  it("a repeat of a LEGACY entry (no seq) stays without one", () => {
    const legacy = {
      ...foldEvents([ev(0, "EXECUTION_STARTED", {})], INITIAL),
      variables: { _decisions: { old: { choice: "old" } } },
    } as ReturnType<typeof foldEvents>;
    const next = foldEvents([dec(5, "old", "again"), dec(6, "new")], legacy);
    const d = next.variables._decisions as Record<string, { choice: string; seq?: number }>;
    expect(d.old?.choice).toBe("again");
    expect(Object.hasOwn(d.old as object, "seq")).toBe(false);
    expect(d.new?.seq).toBe(6);
    // the snapshot the caller held is untouched
    expect(legacy.variables._decisions).toEqual({ old: { choice: "old" } });
  });

  it("normalizeSnapshotState returns a legacy snapshot as the same object, unmutated", () => {
    const legacy = {
      ...foldEvents([ev(0, "EXECUTION_STARTED", {})], INITIAL),
      variables: { _decisions: { old: { choice: "old" } } },
    } as ReturnType<typeof foldEvents>;
    const before = JSON.stringify(legacy);
    expect(normalizeSnapshotState(legacy)).toBe(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
  });
});
