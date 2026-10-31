import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { EVENT_SCHEMA_VERSION, flowEmitCount } from "./eventHandlers";
import { foldEvents } from "./foldEvents";

// ── 1.19.0 (ADR 0102) — the `_flowEmits` fold ──────────────────────────────────
//
// A flow-level emit may be stamped `metadata.flowEmit = <16-hex content digest>`; the
// fold counts stamped emits per digest (a 16-way trie of 16-slot arrays over the
// digest's last three hex digits, counts at the leaves) so a
// re-run knows how many emits of that content the log already holds. Generic over event
// TYPE (a domain event has no handler), keyed only on the stamp — an unstamped log folds
// exactly as before.

const D1 = "0123456789abcdef";
const D2 = "ffffffffffffffef"; // shares D1's first two trie levels ("f", "e"), then diverges
const D3 = "fedcba9876543210";

function ev(
  sequence: number,
  eventType: string,
  payload: unknown = {},
  metadata?: Record<string, unknown>
): EventEnvelope {
  return {
    id: `x-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

describe("_flowEmits fold (EVENT_SCHEMA 1.19.0, ADR 0102)", () => {
  it("declares 1.19.0 or later (1.20.0 is ADR 0104, 1.21.0 is ADR 0105, 1.22.0 is ADR 0107, 1.23.0 is Wave 2, 1.24.0 is ADR 0128, 1.25.0 is the ADR 0130 residuals)", () => {
    expect(EVENT_SCHEMA_VERSION).toBe("1.26.0");
  });

  it("counts stamped emits per digest, for ANY event type, in a trie over the last hex digits", () => {
    const state = foldEvents([
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "response.committed", { m: 1 }, { flowEmit: D1 }),
      ev(2, "SURFACE_PATCH", { patches: [] }, { flowEmit: D2, fence: 3 }),
      ev(3, "response.committed", { m: 1 }, { flowEmit: D1 }),
      ev(4, "x", {}, { flowEmit: D3 }),
    ]);
    const slots = (entries: Record<number, unknown>) =>
      Array.from({ length: 16 }, (_, i) => entries[i] ?? null);
    expect(state.variables._flowEmits).toEqual(
      slots({
        15: slots({ 14: slots({ 13: { [D1]: 2 }, 15: { [D2]: 1 } }) }),
        0: slots({ 1: slots({ 2: { [D3]: 1 } }) }),
      })
    );
    expect(flowEmitCount(state.variables, D1)).toBe(2);
    expect(flowEmitCount(state.variables, "aaaaaaaaaaaaaaaa")).toBe(0);
  });

  it("an unstamped log (legacy, or kernel facts only) never gains the key", () => {
    const state = foldEvents([
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "response.committed", {}),
      ev(2, "STEP_STARTED", { stepId: "s", input: {} }, { fence: 1 }),
      ev(3, "x", {}, { flowEmit: 0 }), // not a digest → not a stamp
      ev(4, "x", {}, { flowEmit: "__proto__" }),
    ]);
    expect("_flowEmits" in state.variables).toBe(false);
  });

  it("copy-on-write across passes: a live commit never mutates the prior state", () => {
    const vm = new ReplayVM([
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "a", {}, { flowEmit: D1 }),
    ]);
    const before = vm.getState().variables;
    const beforeCounts = structuredClone(before._flowEmits);
    vm.applyEvent(ev(2, "a", {}, { flowEmit: D1 }));
    vm.applyEvent(ev(3, "b", {}, { flowEmit: D3 }));
    expect(before._flowEmits).toEqual(beforeCounts);
    expect(vm.flowEmitCount(D1)).toBe(2);
    expect(vm.flowEmitCount(D3)).toBe(1);
  });

  it("fold(snapshot, suffix) === fold(events) — the counts ride a snapshot seed", () => {
    const events = [
      ev(0, "EXECUTION_STARTED", { input: {} }),
      ev(1, "a", {}, { flowEmit: D1 }),
      ev(2, "b", {}, { flowEmit: D2 }),
      ev(3, "a", {}, { flowEmit: D1 }),
      ev(4, "c", {}, { flowEmit: D3 }),
    ];
    const whole = foldEvents(events);
    const seeded = foldEvents(events.slice(0, 2));
    const snapshot = JSON.parse(JSON.stringify(seeded)); // a snapshot is stored data
    const resumed = foldEvents(events.slice(2), snapshot);
    expect(resumed.variables._flowEmits).toEqual(whole.variables._flowEmits);
    // Folding a tail onto a LIVE (non-cloned) seed never mutates the seed's maps.
    expect(foldEvents(events.slice(2), seeded).variables._flowEmits).toEqual(
      whole.variables._flowEmits
    );
    expect(flowEmitCount(seeded.variables, D1)).toBe(1);
    expect(flowEmitCount(seeded.variables, D3)).toBe(0);
  });
});
