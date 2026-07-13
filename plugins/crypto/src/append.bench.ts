import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { bench, describe } from "vitest";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { InMemoryKeyStore } from "./keystore";

// K10-R7 / ADR-0022 A4 — the append-path benchmark the ADR promised. Three shapes on the
// SAME payload so the cost of field-level encryption is visible and G2 is provable:
//   1. unwired      — a plain store.append (no wrapper at all).
//   2. marked-empty — the EncryptingEventStore with an EMPTY sensitive map: a single
//                     per-event-type map lookup then a straight pass-through, no crypto (G2 —
//                     within noise of unwired, ~1.3x, not the 20x+ of the encrypted path).
//   3. marked       — one field encrypted per append (the actual opt-in cost).

function ev(sequence: number): EventEnvelope {
  return {
    id: `e-${sequence}`,
    workflowId: "wf",
    executionId: "x",
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: sequence,
    payload: { stepId: "s", output: { ssn: "123-45-6789", ok: true, note: "unmarked" } },
  };
}

const SENSITIVE = { STEP_COMPLETED: ["output.ssn"] };

describe("EncryptingEventStore.append — marked vs unmarked vs unwired", () => {
  bench("unwired (plain store.append)", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(ev(0));
  });

  bench("wrapped, empty sensitive map (G2 — must match unwired)", async () => {
    const store = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
      sensitive: {},
    });
    await store.append(ev(0));
  });

  bench("wrapped, one field encrypted (opt-in cost)", async () => {
    const store = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
      sensitive: SENSITIVE,
    });
    await store.append(ev(0));
  });
});
