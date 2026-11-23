import type { EventEnvelope } from "@loomwork/core";
import { describe, expect, it } from "vitest";
import { build, flow } from "./__tests__/r2Harness";

// ADR 0152 R13 (I-2): the reopen bootstrap batch bypasses the journal; for a TRACKED run it must record its channel events too.

const T = (origin: string, value: unknown = 1) => ({ __loomTainted: { origin }, value });
const STAMP = { maxOrigins: 8, maxScanNodes: 1000 };

describe("landReopenBootstrap records seen origins for a tracked run", () => {
  it("a reopen of a tracked, failed run records every channel event of its batch (an untracked run records nothing)", async () => {
    for (const tracked of [true, false]) {
      const h = build({});
      const f = flow("fixed", async () => ({ done: true }));
      h.rt.registerFlow(f.definition, f.runner);
      const e = `reopen-${tracked}`;
      const env = (
        sequence: number,
        eventType: string,
        payload: unknown,
        metadata?: Record<string, unknown>
      ): EventEnvelope => ({
        id: `${e}-${sequence}`,
        workflowId: "fixed",
        executionId: e,
        eventType,
        sequence,
        timestamp: 1000 + sequence,
        payload,
        ...(metadata && { metadata }),
      });
      await h.eventStore.append(
        env(
          0,
          "EXECUTION_STARTED",
          { input: {}, ...(tracked && { seenOriginsLimits: STAMP }) },
          tracked ? { origins: [] } : undefined
        )
      );
      await h.eventStore.append(env(1, "EXECUTION_FAILED", { error: "boom" }));
      const run = await h.rt.resumeAs(
        e,
        "fixed",
        { eventType: "RETRY", payload: T("peer:evil") },
        { strategy: "operator-ack" }
      );
      await run.waitForCompletion();
      const log = await h.eventStore.read(e);
      // the batch the reopen wrote itself (bypassing the journal): migrated + resumed, both channel events
      const batch = log.filter(
        (x) => x.eventType === "EXECUTION_MIGRATED" || x.eventType === "EXECUTION_RESUMED"
      );
      expect(batch.map((x) => x.eventType)).toEqual(["EXECUTION_MIGRATED", "EXECUTION_RESUMED"]);
      for (const x of batch) {
        if (tracked) expect(x.metadata?.origins).toEqual([]);
        else expect(x.metadata?.origins).toBeUndefined();
      }
    }
  });
});

describe("ExecutionJournal.envelopeAt scans against the state it is given (the reopen batch's scratch fold)", () => {
  it("a tracked state records the migrated input's origins; later entries see the earlier ones", async () => {
    const { ExecutionJournal } = await import("./ExecutionJournal");
    const { foldEvents } = await import("@loomwork/replay-vm");
    const id = { executionId: "e", workflowId: "f" };
    const start = ExecutionJournal.bootstrapEnvelope(id, "EXECUTION_STARTED", {
      input: {},
      seenOriginsLimits: STAMP,
    });
    let before = foldEvents([start]);
    const mig = ExecutionJournal.envelopeAt(
      id,
      1,
      "EXECUTION_MIGRATED",
      { toFlowId: "g", migratedInput: { x: T("peer:m") } },
      { before }
    );
    expect(mig.metadata).toEqual({ origins: ["peer:m"] });
    before = foldEvents([mig], before);
    const mc = (sequence: number) =>
      ExecutionJournal.envelopeAt(
        id,
        sequence,
        "MESSAGE_CONSUMED",
        { waitId: "w", topic: "t", messageId: "m1", inboxSeq: 0, payload: T("lineage:A") },
        { before, metadata: { kernel: true } }
      );
    const first = mc(2);
    expect(first.metadata).toMatchObject({ origins: ["inbox:t", "lineage:A"] });
    before = foldEvents([first], before);
    // the duplicate delivered nothing: only the scratch fold of the earlier entry can know that
    expect(mc(3).metadata).toMatchObject({ origins: [] });
    // without `before` (the old call) nothing is recorded: the gap R13 closes by passing it
    expect(
      ExecutionJournal.envelopeAt(id, 1, "EXECUTION_MIGRATED", { toFlowId: "g" }).metadata
    ).toBeUndefined();
  });
});
