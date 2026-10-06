import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { createTelemetryHook } from "./createTelemetryHook";
import type { TelemetryAdapter } from "./types";

let seq = 0;
function ev(
  eventType: string,
  payload: unknown = {},
  executionId = "x",
  metadata?: Record<string, unknown>
): EventEnvelope {
  seq += 1;
  return {
    id: `e-${seq}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence: seq,
    timestamp: seq,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

describe("createTelemetryHook — per-execution state cleanup (leak fix)", () => {
  it("forgets an execution on terminal so a stray later event is a no-op", () => {
    seq = 0;
    const adapter: TelemetryAdapter = { onFlowResume: vi.fn(), onFlowComplete: vi.fn() };
    const hook = createTelemetryHook(adapter);

    hook(ev("EXECUTION_STARTED"));
    hook(ev("EXECUTION_COMPLETED"));
    // flowState was deleted on COMPLETED → a spurious RESUMED finds no entry and does nothing.
    hook(ev("EXECUTION_RESUMED"));

    expect(adapter.onFlowComplete).toHaveBeenCalledOnce();
    expect(adapter.onFlowResume).not.toHaveBeenCalled();
  });

  it("a kernel-stamped EXECUTION_CONTINUED is terminal too: the per-execution state is freed", () => {
    seq = 0;
    const adapter: TelemetryAdapter = { onFlowResume: vi.fn() };
    const onStepStart = vi.fn();
    const hook = createTelemetryHook({ ...adapter, onStepStart });
    hook(ev("EXECUTION_STARTED"));
    hook(ev("STEP_STARTED", { stepId: "a" }));
    hook(ev("EXECUTION_CONTINUED", { successorId: "x~1" }, "x", { kernel: true }));
    hook(ev("EXECUTION_RESUMED"));
    expect(adapter.onFlowResume).not.toHaveBeenCalled(); // flowState freed
    hook(ev("EXECUTION_STARTED"));
    hook(ev("STEP_STARTED", { stepId: "a" }));
    expect(onStepStart).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1 })); // step map freed
  });

  it("an UNSTAMPED app event named EXECUTION_CONTINUED frees nothing", () => {
    seq = 0;
    const adapter: TelemetryAdapter = { onFlowResume: vi.fn() };
    const hook = createTelemetryHook(adapter);
    hook(ev("EXECUTION_STARTED"));
    hook(ev("EXECUTION_CONTINUED", { successorId: "x~1" }));
    hook(ev("EXECUTION_RESUMED"));
    expect(adapter.onFlowResume).toHaveBeenCalledOnce();
  });

  it("still tracks a normal suspend→resume (state kept across suspension)", () => {
    seq = 0;
    const adapter: TelemetryAdapter = { onFlowResume: vi.fn() };
    const hook = createTelemetryHook(adapter);
    hook(ev("EXECUTION_STARTED"));
    hook(ev("EXECUTION_SUSPENDED", { condition: { on: "x" } }));
    hook(ev("EXECUTION_RESUMED"));
    expect(adapter.onFlowResume).toHaveBeenCalledOnce();
  });

  it("clears step attempt state on terminal step events", () => {
    seq = 0;
    const onStepStart = vi.fn();
    const hook = createTelemetryHook({ onStepStart });
    hook(ev("EXECUTION_STARTED"));
    hook(ev("STEP_STARTED", { stepId: "a" }));
    hook(ev("STEP_COMPLETED", { stepId: "a" }));
    // A brand-new run of the same step id starts at attempt 1 (attempt state was cleared).
    hook(ev("STEP_STARTED", { stepId: "a" }));
    expect(onStepStart).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1 }));
  });
});
