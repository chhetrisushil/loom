import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── ADR 0057 — multi-gate suspend passthrough (W8 audit fix) ──────────────────
//
// Before 1.16.0 the fold kept only the LATEST resume payload and the context
// had a single-shot passthrough: on the second resume of a two-gate flow,
// gate 1 passed through with GATE 2's payload and gate 2 re-parked — a silent
// wrong-payload bug. The ordered `_resumePayloads` list fixes it: gate i
// consumes payload i.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;

function gatedFlow(
  gates: string[],
  seen: { payloads: unknown[] }
): RegisteredFlow<Record<string, unknown>, Record<string, unknown>> {
  const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    seen.payloads.length = 0; // a re-run observes the full ordered sequence
    for (const gate of gates) {
      const payload = await (ctx.suspend({ on: gate }) as Promise<unknown>).then(
        (p) => p,
        (err) => {
          throw err;
        }
      );
      seen.payloads.push(payload);
    }
    return { done: true };
  };
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "gates",
    name: "gates",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  return { definition, runner };
}

function boot() {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  return { runtime, eventStore };
}

describe("multi-gate suspend passthrough (ADR 0057)", () => {
  it("two sequential gates: each passthrough receives ITS OWN payload, in order", async () => {
    const { runtime } = boot();
    const seen = { payloads: [] as unknown[] };
    const flow = gatedFlow(["Gate1", "Gate2"], seen);
    runtime.registerFlow(flow.definition, flow.runner);

    const started = await runtime.start(flow, {}, { executionId: "two-gates" });
    await started.waitForSuspend();

    const afterFirst = await runtime.resume("two-gates", {
      eventType: "Gate1",
      payload: { gate: 1, decision: "approve" },
    });
    const mid = await afterFirst.waitForSuspend();
    expect(mid.suspendedOn?.on).toBe("Gate2"); // parked on the SECOND gate

    const done = await runtime.resume("two-gates", {
      eventType: "Gate2",
      payload: { gate: 2, decision: "ship" },
    });
    const state = await done.waitForCompletion();
    expect(state.status).toBe("completed");
    // The pre-fix bug: gate 1 received { gate: 2 } and the run re-parked forever.
    expect(seen.payloads).toEqual([
      { gate: 1, decision: "approve" },
      { gate: 2, decision: "ship" },
    ]);
  });

  it("three gates complete across three resumes with ordered payloads", async () => {
    const { runtime } = boot();
    const seen = { payloads: [] as unknown[] };
    const flow = gatedFlow(["A", "B", "C"], seen);
    runtime.registerFlow(flow.definition, flow.runner);

    const started = await runtime.start(flow, {}, { executionId: "three-gates" });
    await started.waitForSuspend();
    for (const [i, gate] of (["A", "B", "C"] as const).entries()) {
      const handle = await runtime.resume("three-gates", {
        eventType: gate,
        payload: { seq: i },
      });
      if (gate === "C") {
        expect((await handle.waitForCompletion()).status).toBe("completed");
      } else {
        expect((await handle.waitForSuspend()).suspendedOn?.on).toBe(gate === "A" ? "B" : "C");
      }
    }
    expect(seen.payloads).toEqual([{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
  });

  it("legacy fallback: a pre-1.16 folded state (single _resumePayload) still resumes a one-gate flow", async () => {
    // Hand-crafted history that a pre-1.16 kernel could have written: the fold
    // of these events has _resumePayload (latest key) — and 1.16 folds the list
    // from the same events, so replay stays correct either way. The load-bearing
    // assertion is single-gate behavior: byte-identical to before.
    const { runtime, eventStore } = boot();
    const seen = { payloads: [] as unknown[] };
    const flow = gatedFlow(["Only"], seen);
    runtime.registerFlow(flow.definition, flow.runner);

    const history = [
      { eventType: "EXECUTION_STARTED", payload: { input: {} } },
      { eventType: "EXECUTION_SUSPENDED", payload: { condition: { on: "Only" } } },
    ];
    for (const [sequence, e] of history.entries()) {
      await eventStore.append({
        id: `legacy-${sequence}`,
        workflowId: "gates",
        executionId: "legacy-1",
        eventType: e.eventType,
        sequence,
        timestamp: 1_000 + sequence,
        payload: e.payload,
      });
    }
    const done = await runtime.resume("legacy-1", { eventType: "Only", payload: { ok: true } });
    expect((await done.waitForCompletion()).status).toBe("completed");
    expect(seen.payloads).toEqual([{ ok: true }]);
  });
});
