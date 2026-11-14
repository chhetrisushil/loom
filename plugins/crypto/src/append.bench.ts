import type { EventEnvelope } from "@loomwork/core";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { bench, describe } from "vitest";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { InMemoryKeyStore } from "./keystore";

// K10-R7 / ADR-0022 A4 — the append-path benchmark the ADR promised. Three shapes on the
// SAME payload so the cost of field-level encryption is visible and G2 is provable:
//   1. unwired      — a plain store.append (no wrapper at all).
//   2. marked-empty — the EncryptingEventStore with an EMPTY sensitive map: a per-event-type
//                     map lookup then a straight pass-through, no crypto (G2).
//   3. marked       — one field encrypted per append (the actual opt-in cost).
//
// Each store is built ONCE, outside the measured function. Building one per iteration times the
// wrapper's constructor, which an app pays once at boot, and read as ~7x for the empty map when
// the append itself costs ~1.1x. Sequences roll onto a new execution so no log grows long.

function ev(prefix: string, n: number): EventEnvelope {
  const executionId = `${prefix}-${Math.floor(n / 256)}`;
  const sequence = n % 256;
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: sequence,
    payload: { stepId: "s", output: { ssn: "123-45-6789", ok: true, note: "unmarked" } },
  };
}

const SENSITIVE = { STEP_COMPLETED: ["output.ssn"] };

describe("EncryptingEventStore.append — marked vs unmarked vs unwired", () => {
  const unwired = new InMemoryAsyncEventStore();
  let unwiredCount = 0;
  bench("unwired (plain store.append)", async () => {
    await unwired.append(ev("unwired", unwiredCount++));
  });

  const empty = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
    sensitive: {},
  });
  let emptyCount = 0;
  bench("wrapped, empty sensitive map (G2 — must match unwired)", async () => {
    await empty.append(ev("empty", emptyCount++));
  });

  const marked = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
    sensitive: SENSITIVE,
  });
  let markedCount = 0;
  bench("wrapped, one field encrypted (opt-in cost)", async () => {
    await marked.append(ev("marked", markedCount++));
  });
});
