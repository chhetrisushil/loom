import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { foldEvents } from "./foldEvents";

// ── DE-4 (1.17.0) — STEP_FAILED {channel, payload} fold ──────────────────────
//
// Additive per the K5 payload-extension rule: a typed STEP_FAILED folds
// errorChannel/errorPayload into the frame (what the execute seam substitutes
// from); a channel-less STEP_FAILED folds a frame deep-equal to pre-1.17.

function envelope(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `e-${sequence}`,
    executionId: "x-1",
    workflowId: "w-1",
    eventType,
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}

const started = envelope(0, "EXECUTION_STARTED", { input: {} });
const stepStarted = envelope(1, "STEP_STARTED", { stepId: "s1", input: { a: 1 } });

describe("typed STEP_FAILED fold (DE-4, EVENT_SCHEMA 1.17.0)", () => {
  it("folds channel/payload into frame errorChannel/errorPayload", () => {
    const state = foldEvents([
      started,
      stepStarted,
      envelope(2, "STEP_FAILED", {
        stepId: "s1",
        error: "TypedFailure: drift",
        channel: "schemaDrift",
        payload: { observedHash: "h1" },
      }),
    ]);
    expect(state.frames.s1).toMatchObject({
      status: "failed",
      error: "TypedFailure: drift",
      errorChannel: "schemaDrift",
      errorPayload: { observedHash: "h1" },
    });
  });

  it("channel-less STEP_FAILED folds a frame deep-equal to the legacy shape (G2)", () => {
    const legacyEvents = [
      started,
      stepStarted,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "Error: boom" }),
    ];
    const state = foldEvents(legacyEvents);
    expect(state.frames.s1).toEqual({
      stepId: "s1",
      status: "failed",
      attempts: 1,
      startedAt: 1_001,
      firstStartedAt: 1_001,
      firstSeq: 1, // ADR 0113 D3: the log's first-start order rides every frame
      // ADR 0138: no `input` once the frame settles
      error: "Error: boom",
    });
    expect(state.frames.s1).not.toHaveProperty("errorChannel");
  });

  it("ReplayVM.getTypedFailure: defined only for declared-channel failures", () => {
    const typed = new ReplayVM([
      started,
      stepStarted,
      envelope(2, "STEP_FAILED", {
        stepId: "s1",
        error: "TypedFailure: drift",
        channel: "schemaDrift",
        payload: { observedHash: "h1" },
      }),
    ]);
    expect(typed.getTypedFailure("s1")).toEqual({
      channel: "schemaDrift",
      payload: { observedHash: "h1" },
      error: "TypedFailure: drift",
    });

    const untyped = new ReplayVM([
      started,
      stepStarted,
      envelope(2, "STEP_FAILED", { stepId: "s1", error: "Error: boom" }),
    ]);
    expect(untyped.hasFailed("s1")).toBe(true);
    expect(untyped.getTypedFailure("s1")).toBeUndefined();

    // A completed step is never a typed failure.
    const completed = new ReplayVM([
      started,
      stepStarted,
      envelope(2, "STEP_COMPLETED", { stepId: "s1", output: { ok: true } }),
    ]);
    expect(completed.getTypedFailure("s1")).toBeUndefined();
  });
});
