import { tainted } from "@loomwork/classify";
import { describe, expect, it } from "vitest";
import { foldEvents } from "./foldEvents";
import { stampSeenOrigins } from "./seenOriginsRecord";

// ADR 0152 R11: the journal's stamp step. A caller-supplied `origins` / `originsOverflow` never reaches the log.
const STAMP = { maxOrigins: 64, maxScanNodes: 10_000 };
const T = (origin: string, value: unknown = 1) => tainted(value, origin);
const tracked = () =>
  foldEvents([
    {
      id: "x-0",
      workflowId: "wf",
      executionId: "x",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {}, seenOriginsLimits: STAMP },
      metadata: { origins: [] },
    },
  ]);

describe("stampSeenOrigins", () => {
  it("strips a caller-supplied origins / originsOverflow on a CHANNEL event, tracked or not", () => {
    const forged = { origins: ["forged"], originsOverflow: true, fence: 3 };
    // an untracked run's channel event: stripped, nothing recorded
    expect(stampSeenOrigins(undefined, "STEP_COMPLETED", {}, forged)).toEqual({ fence: 3 });
    const st = tracked();
    expect(stampSeenOrigins(st, "STEP_COMPLETED", { output: "clean" }, forged)).toEqual({
      fence: 3,
      origins: [],
    });
    expect(stampSeenOrigins(st, "STEP_COMPLETED", { output: T("real") }, forged)).toEqual({
      fence: 3,
      origins: ["real"],
    });
  });
  it("M-C: application metadata on a NON-channel event (or a run that never opted in) is byte-untouched", () => {
    const app = { origins: ["app-owned"], originsOverflow: false, other: 1 };
    // untracked run, non-channel event: the very same object, the value preserved
    expect(stampSeenOrigins(undefined, "APP_EVENT", { v: 1 }, app)).toBe(app);
    // tracked run, non-channel event: also untouched (the fold ignores a record on a non-channel event anyway)
    expect(stampSeenOrigins(tracked(), "STEP_STARTED", { stepId: "a" }, app)).toBe(app);
    expect(app.origins).toEqual(["app-owned"]);
  });
  it("returns the same metadata object when there is nothing to record (untracked run, non-channel event)", () => {
    const m = { kernel: true };
    expect(
      stampSeenOrigins(undefined, "EXECUTION_STARTED", { input: T("a") }, undefined)
    ).toBeUndefined();
    expect(stampSeenOrigins(tracked(), "APP_EVENT", { v: T("a") }, m)).toBe(m);
  });
});
