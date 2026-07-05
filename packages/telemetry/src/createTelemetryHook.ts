import type { EventEnvelope } from "@loom/core";
import type { FlowTelemetryInfo, StepTelemetryInfo, TelemetryAdapter } from "./types";

export function createTelemetryHook(adapter: TelemetryAdapter): (event: EventEnvelope) => void {
  const flowState = new Map<string, FlowTelemetryInfo>();
  const stepStarts = new Map<string, number>();
  const stepAttempts = new Map<string, number>();

  return (event: EventEnvelope): void => {
    const { executionId, workflowId, eventType, timestamp, payload } = event;

    switch (eventType) {
      case "EXECUTION_STARTED": {
        const info: FlowTelemetryInfo = {
          executionId,
          workflowId,
          startedAt: timestamp,
          status: "running",
          stepCount: 0,
          suspendCount: 0,
        };
        flowState.set(executionId, info);
        adapter.onFlowStart?.({ ...info });
        break;
      }

      case "EXECUTION_COMPLETED": {
        const info = flowState.get(executionId);
        if (!info) break;
        const updated: FlowTelemetryInfo = {
          ...info,
          status: "completed",
          completedAt: timestamp,
          durationMs: timestamp - info.startedAt,
        };
        flowState.set(executionId, updated);
        adapter.onFlowComplete?.({ ...updated });
        break;
      }

      case "EXECUTION_FAILED": {
        const info = flowState.get(executionId);
        if (!info) break;
        const updated: FlowTelemetryInfo = {
          ...info,
          status: "failed",
          completedAt: timestamp,
          durationMs: timestamp - info.startedAt,
        };
        flowState.set(executionId, updated);
        adapter.onFlowFail?.({ ...updated });
        break;
      }

      case "EXECUTION_SUSPENDED": {
        const info = flowState.get(executionId);
        if (!info) break;
        const updated: FlowTelemetryInfo = {
          ...info,
          status: "suspended",
          completedAt: timestamp,
          durationMs: timestamp - info.startedAt,
          suspendCount: info.suspendCount + 1,
        };
        flowState.set(executionId, updated);
        adapter.onFlowSuspend?.({ ...updated });
        break;
      }

      case "EXECUTION_RESUMED": {
        const info = flowState.get(executionId);
        if (!info) break;
        const { completedAt: _c, durationMs: _d, ...rest } = info;
        const updated: FlowTelemetryInfo = { ...rest, status: "running" };
        flowState.set(executionId, updated);
        adapter.onFlowResume?.({ ...updated });
        break;
      }

      case "STEP_STARTED": {
        const p = payload as { stepId: string; input?: unknown };
        const key = `${executionId}:${p.stepId}`;
        stepStarts.set(key, timestamp);
        const attempt = (stepAttempts.get(key) ?? 0) + 1;
        stepAttempts.set(key, attempt);

        const flowInfo = flowState.get(executionId);
        if (flowInfo && attempt === 1) {
          flowInfo.stepCount += 1;
        }

        const info: StepTelemetryInfo = {
          executionId,
          workflowId,
          stepId: p.stepId,
          attempt,
          startedAt: timestamp,
          status: "running",
          ...(p.input !== undefined && { input: p.input }),
        };
        adapter.onStepStart?.({ ...info });
        break;
      }

      case "STEP_COMPLETED": {
        const p = payload as { stepId: string; output?: unknown };
        const key = `${executionId}:${p.stepId}`;
        const startedAt = stepStarts.get(key) ?? timestamp;
        const attempt = stepAttempts.get(key) ?? 1;
        const info: StepTelemetryInfo = {
          executionId,
          workflowId,
          stepId: p.stepId,
          attempt,
          startedAt,
          completedAt: timestamp,
          durationMs: timestamp - startedAt,
          status: "completed",
          ...(p.output !== undefined && { output: p.output }),
        };
        adapter.onStepComplete?.({ ...info });
        stepStarts.delete(key);
        break;
      }

      case "STEP_FAILED": {
        const p = payload as { stepId: string; error?: unknown };
        const key = `${executionId}:${p.stepId}`;
        const startedAt = stepStarts.get(key) ?? timestamp;
        const attempt = stepAttempts.get(key) ?? 1;
        const info: StepTelemetryInfo = {
          executionId,
          workflowId,
          stepId: p.stepId,
          attempt,
          startedAt,
          completedAt: timestamp,
          durationMs: timestamp - startedAt,
          status: "failed",
          ...(p.error !== undefined && { error: p.error }),
        };
        adapter.onStepFail?.({ ...info });
        stepStarts.delete(key);
        break;
      }

      case "STEP_RETRYING": {
        const p = payload as { stepId: string; attempt: number };
        const key = `${executionId}:${p.stepId}`;
        const startedAt = stepStarts.get(key) ?? timestamp;
        const info: StepTelemetryInfo = {
          executionId,
          workflowId,
          stepId: p.stepId,
          attempt: p.attempt,
          startedAt,
          status: "retrying",
        };
        adapter.onStepRetry?.({ ...info });
        break;
      }

      default:
        break;
    }
  };
}
