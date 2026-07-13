import { internal, secret, sensitive } from "@loom/classify";
import { step$ } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EGRESS_REDACTED, scrubPathsByStep, scrubbingAdapter } from "./scrubbing";
import type { StepTelemetryInfo, TelemetryAdapter } from "./types";

const chargeStep = step$({
  id: "charge",
  inputSchema: z.object({ card: sensitive(z.string()), amount: z.number() }),
  outputSchema: z.object({
    receipt: internal(z.string()),
    token: secret(z.string()),
    ok: z.boolean(),
  }),
});

function stepInfo(over: Partial<StepTelemetryInfo>): StepTelemetryInfo {
  return {
    executionId: "e1",
    workflowId: "wf",
    stepId: "charge",
    attempt: 1,
    startedAt: 0,
    status: "running",
    ...over,
  };
}

describe("scrubPathsByStep (K10-R6)", () => {
  it("collects sensitive ∪ internal input/output paths; excludes secret + omits clean steps", () => {
    const clean = step$({
      id: "log",
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ line: z.string() }),
    });
    const byStep = scrubPathsByStep([chargeStep, clean]);
    expect(byStep.get("charge")).toEqual({
      input: ["card"], // sensitive input
      output: ["receipt"], // internal output; `token` (secret) is NOT scrubbed here — never egressed
    });
    expect(byStep.has("log")).toBe(false); // nothing marked → omitted (G2)
  });
});

describe("scrubbingAdapter (K10-R6)", () => {
  it("masks marked input/output fields before the inner adapter sees them", () => {
    const seen: StepTelemetryInfo[] = [];
    const inner: TelemetryAdapter = {
      onStepStart: (i) => seen.push(i),
      onStepComplete: (i) => seen.push(i),
    };
    const adapter = scrubbingAdapter(inner, scrubPathsByStep([chargeStep]));

    adapter.onStepStart?.(stepInfo({ input: { card: "4111-1111", amount: 42 } }));
    adapter.onStepComplete?.(stepInfo({ output: { receipt: "R-secret", token: "tok", ok: true } }));

    expect(seen[0]?.input).toEqual({ card: EGRESS_REDACTED, amount: 42 });
    // internal field masked; unmarked `ok` untouched; `token` still present in this info
    // (secret-class egress is prevented upstream by K10-R2, not re-masked here).
    expect(seen[1]?.output).toEqual({ receipt: EGRESS_REDACTED, token: "tok", ok: true });
  });

  it("does not mutate the caller's payload (structural copy)", () => {
    const inner: TelemetryAdapter = { onStepStart: vi.fn() };
    const adapter = scrubbingAdapter(inner, scrubPathsByStep([chargeStep]));
    const input = { card: "4111", amount: 1 };
    adapter.onStepStart?.(stepInfo({ input }));
    expect(input.card).toBe("4111"); // original object untouched
  });

  it("is a pass-through (returns the inner adapter) when nothing is marked (G2)", () => {
    const inner: TelemetryAdapter = { onStepStart: vi.fn() };
    expect(scrubbingAdapter(inner, new Map())).toBe(inner);
  });

  it("leaves flow-lifecycle callbacks intact", () => {
    const onFlowComplete = vi.fn();
    const adapter = scrubbingAdapter({ onFlowComplete }, scrubPathsByStep([chargeStep]));
    adapter.onFlowComplete?.({
      executionId: "e1",
      workflowId: "wf",
      startedAt: 0,
      status: "completed",
      stepCount: 1,
      suspendCount: 0,
    });
    expect(onFlowComplete).toHaveBeenCalledOnce();
  });
});
