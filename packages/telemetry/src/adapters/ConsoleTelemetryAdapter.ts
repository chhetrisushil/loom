import type { FlowTelemetryInfo, StepTelemetryInfo, TelemetryAdapter } from "../types";

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export const ConsoleTelemetryAdapter: TelemetryAdapter = {
  onFlowStart: ({ executionId, workflowId }: FlowTelemetryInfo) =>
    console.log(`[loom] ${pad("FLOW_START", 14)} exec=${executionId}  workflow=${workflowId}`),

  onFlowComplete: ({ executionId, workflowId, durationMs, stepCount }: FlowTelemetryInfo) =>
    console.log(
      `[loom] ${pad("FLOW_DONE", 14)} exec=${executionId}  workflow=${workflowId}  ` +
        `duration=${durationMs ?? "?"}ms  steps=${stepCount}`
    ),

  onFlowFail: ({ executionId, workflowId, durationMs }: FlowTelemetryInfo) =>
    console.warn(
      `[loom] ${pad("FLOW_FAILED", 14)} exec=${executionId}  workflow=${workflowId}  ` +
        `duration=${durationMs ?? "?"}ms`
    ),

  onFlowSuspend: ({ executionId, workflowId, durationMs, suspendCount }: FlowTelemetryInfo) =>
    console.log(
      `[loom] ${pad("FLOW_SUSPEND", 14)} exec=${executionId}  workflow=${workflowId}  ` +
        `duration=${durationMs ?? "?"}ms  suspend#=${suspendCount}`
    ),

  onFlowResume: ({ executionId, workflowId }: FlowTelemetryInfo) =>
    console.log(`[loom] ${pad("FLOW_RESUME", 14)} exec=${executionId}  workflow=${workflowId}`),

  onStepStart: ({ executionId, stepId, attempt }: StepTelemetryInfo) =>
    console.log(
      `[loom] ${pad("STEP_START", 14)} exec=${executionId}  step=${stepId}  attempt=${attempt}`
    ),

  onStepComplete: ({ executionId, stepId, durationMs, attempt }: StepTelemetryInfo) =>
    console.log(
      `[loom] ${pad("STEP_DONE", 14)} exec=${executionId}  step=${stepId}  ` +
        `duration=${durationMs ?? "?"}ms  attempt=${attempt}`
    ),

  onStepFail: ({ executionId, stepId, error }: StepTelemetryInfo) =>
    console.warn(
      `[loom] ${pad("STEP_FAILED", 14)} exec=${executionId}  step=${stepId}  error=${String(error)}`
    ),

  onStepRetry: ({ executionId, stepId, attempt }: StepTelemetryInfo) =>
    console.log(
      `[loom] ${pad("STEP_RETRY", 14)} exec=${executionId}  step=${stepId}  attempt=${attempt}`
    ),
};
