import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { foldEvents } from "./foldEvents";

const EXEC = "exec-migrated";

function makeEvent(sequence: number, eventType: string, payload: unknown = {}): EventEnvelope {
  return {
    id: `${EXEC}-${sequence}`,
    workflowId: "wf-v1",
    executionId: EXEC,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

// K11.3 — EXECUTION_MIGRATED re-points the durable flow-code fingerprint (and,
// on a cross-flow migration, the resolution pointer) and appends an audit entry.
describe("EXECUTION_MIGRATED fold (K11.3)", () => {
  it("re-points _flowHash + _migratedTo and appends to _migrations", () => {
    const state = foldEvents([
      makeEvent(0, "EXECUTION_STARTED", { input: {}, flowHash: "fnv1a:aaaa" }),
      makeEvent(1, "EXECUTION_MIGRATED", {
        toFlowId: "wf-v1",
        toHash: "fnv1a:bbbb",
        fromHash: "fnv1a:aaaa",
        strategy: "replay-check",
      }),
    ]);

    expect(state.variables._flowHash).toBe("fnv1a:bbbb");
    expect(state.variables._migratedTo).toBe("wf-v1"); // unconditional resolution pointer
    expect(state.variables._migrations).toEqual([
      {
        toFlowId: "wf-v1",
        toHash: "fnv1a:bbbb",
        fromHash: "fnv1a:aaaa",
        strategy: "replay-check",
      },
    ]);
  });

  it("records _migratedTo when the target flow id differs (cross-flow migration)", () => {
    const state = foldEvents([
      makeEvent(0, "EXECUTION_STARTED", { input: {}, flowHash: "fnv1a:aaaa" }),
      makeEvent(1, "EXECUTION_MIGRATED", {
        toFlowId: "wf-v2",
        toHash: "fnv1a:cccc",
        strategy: "operator-ack",
      }),
    ]);

    expect(state.variables._migratedTo).toBe("wf-v2");
    expect(state.variables._flowHash).toBe("fnv1a:cccc");
  });

  it("is a pure audit + pointer fact — status untouched", () => {
    const state = foldEvents([
      makeEvent(0, "EXECUTION_STARTED", { input: {} }),
      makeEvent(1, "EXECUTION_SUSPENDED", { condition: { on: "Approval" } }),
      makeEvent(2, "EXECUTION_MIGRATED", { toFlowId: "wf-v1", toHash: "fnv1a:dddd" }),
    ]);
    expect(state.status).toBe("suspended");
  });
});
