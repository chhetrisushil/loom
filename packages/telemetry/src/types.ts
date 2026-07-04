export interface FlowTelemetryInfo {
  executionId: string;
  workflowId: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "suspended";
  stepCount: number;
  suspendCount: number;
}

export interface StepTelemetryInfo {
  executionId: string;
  workflowId: string;
  stepId: string;
  attempt: number;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  status: "running" | "completed" | "failed" | "retrying";
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

/**
 * Implement any subset of these methods to observe Loom workflow execution.
 *
 * OTel adapter sketch (bring your own @opentelemetry/api):
 * ```ts
 * const spans = new Map<string, Span>();
 * const adapter: TelemetryAdapter = {
 *   onFlowStart:    ({ executionId, workflowId }) =>
 *     spans.set(executionId, tracer.startSpan(`flow.${workflowId}`)),
 *   onFlowComplete: ({ executionId, durationMs }) => {
 *     const s = spans.get(executionId);
 *     s?.setAttribute('duration_ms', durationMs ?? 0);
 *     s?.end();
 *   },
 *   onStepStart:    ({ executionId, stepId }) =>
 *     spans.set(`${executionId}:${stepId}`, tracer.startSpan(stepId, { childOf: spans.get(executionId) })),
 *   onStepComplete: ({ executionId, stepId }) =>
 *     spans.get(`${executionId}:${stepId}`)?.end(),
 * };
 * ```
 */
export interface TelemetryAdapter {
  onFlowStart?(info: FlowTelemetryInfo): void;
  onFlowComplete?(info: FlowTelemetryInfo): void;
  onFlowFail?(info: FlowTelemetryInfo): void;
  onFlowSuspend?(info: FlowTelemetryInfo): void;
  onFlowResume?(info: FlowTelemetryInfo): void;
  onStepStart?(info: StepTelemetryInfo): void;
  onStepComplete?(info: StepTelemetryInfo): void;
  onStepFail?(info: StepTelemetryInfo): void;
  onStepRetry?(info: StepTelemetryInfo): void;
}
