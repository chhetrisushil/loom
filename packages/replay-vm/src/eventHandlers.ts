import type { EventEnvelope } from "@loom/core";
import type { ExecutionFrame, ExecutionState } from "@loom/core";

type Handler = (state: ExecutionState, event: EventEnvelope) => ExecutionState;

function cloneFrames(frames: Record<string, ExecutionFrame>): Record<string, ExecutionFrame> {
  const result: Record<string, ExecutionFrame> = {};
  for (const [k, v] of Object.entries(frames)) {
    result[k] = { ...v };
  }
  return result;
}

const handlers: Record<string, Handler> = {
  EXECUTION_STARTED: (state, event) => {
    const payload = event.payload as { input?: unknown };
    return {
      ...state,
      status: "running",
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
      ...(payload.input !== undefined && {
        variables: { ...state.variables, _input: payload.input },
      }),
    };
  },

  STEP_STARTED: (state, event) => {
    const payload = event.payload as { stepId: string; input?: unknown };
    const frames = cloneFrames(state.frames);
    frames[payload.stepId] = {
      stepId: payload.stepId,
      status: "running",
      attempts: (frames[payload.stepId]?.attempts ?? 0) + 1,
      startedAt: event.timestamp,
      ...(payload.input !== undefined && { input: payload.input }),
    };
    return { ...state, frames, updatedAt: event.timestamp };
  },

  STEP_COMPLETED: (state, event) => {
    const payload = event.payload as { stepId: string; output?: unknown };
    const frames = cloneFrames(state.frames);
    const existing = frames[payload.stepId];
    frames[payload.stepId] = {
      stepId: payload.stepId,
      status: "completed",
      attempts: existing?.attempts ?? 1,
      completedAt: event.timestamp,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.output !== undefined && { output: payload.output }),
    };
    return { ...state, frames, updatedAt: event.timestamp };
  },

  STEP_FAILED: (state, event) => {
    const payload = event.payload as { stepId: string; error?: unknown };
    const frames = cloneFrames(state.frames);
    const existing = frames[payload.stepId];
    frames[payload.stepId] = {
      stepId: payload.stepId,
      status: "failed",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.error !== undefined && { error: payload.error }),
    };
    return { ...state, status: "failed", frames, updatedAt: event.timestamp };
  },

  STEP_CANCELLED: (state, event) => {
    // Marks the in-flight step as cancelled WITHOUT touching execution status —
    // the surrounding EXECUTION_CANCELLED event owns the execution-level status,
    // and this must not overwrite it back to a failure/other state.
    const payload = event.payload as { stepId: string };
    const frames = cloneFrames(state.frames);
    const existing = frames[payload.stepId];
    frames[payload.stepId] = {
      stepId: payload.stepId,
      status: "cancelled",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return { ...state, frames, updatedAt: event.timestamp };
  },

  STEP_RETRYING: (state, event) => {
    const payload = event.payload as { stepId: string; attempt: number };
    const frames = cloneFrames(state.frames);
    const existing = frames[payload.stepId];
    frames[payload.stepId] = {
      stepId: payload.stepId,
      status: "pending",
      attempts: payload.attempt,
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return { ...state, frames, updatedAt: event.timestamp };
  },

  PARALLEL_STARTED: (state, event) => {
    const payload = event.payload as { stepIds: string[] };
    const frames = cloneFrames(state.frames);
    for (const stepId of payload.stepIds) {
      frames[stepId] = {
        stepId,
        status: "pending",
        attempts: 0,
        startedAt: event.timestamp,
      };
    }
    return { ...state, frames, updatedAt: event.timestamp };
  },

  PARALLEL_COMPLETED: (state, event) => {
    return { ...state, updatedAt: event.timestamp };
  },

  EXECUTION_SUSPENDED: (state, event) => {
    const payload = event.payload as {
      condition: { on: string; timeout?: number; correlationKey?: string };
    };
    return {
      ...state,
      status: "suspended",
      suspendedOn: payload.condition,
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_RESUMED: (state, event) => {
    const { suspendedOn: _removed, ...rest } = state;
    return {
      ...rest,
      status: "running",
      variables: {
        ...state.variables,
        ...(event.payload !== undefined && { _resumePayload: event.payload }),
      },
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_COMPLETED: (state, event) => {
    const payload = event.payload as { output?: unknown };
    return {
      ...state,
      status: "completed",
      ...(payload.output !== undefined && {
        variables: { ...state.variables, _output: payload.output },
      }),
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_FAILED: (state, event) => {
    const payload = event.payload as { error?: unknown };
    return {
      ...state,
      status: "failed",
      ...(payload.error !== undefined && {
        variables: { ...state.variables, _error: payload.error },
      }),
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_CANCELLED: (state, event) => {
    const payload = event.payload as { reason?: unknown };
    return {
      ...state,
      status: "cancelled",
      ...(payload.reason !== undefined && {
        variables: { ...state.variables, _cancelReason: payload.reason },
      }),
      updatedAt: event.timestamp,
    };
  },
};

export function getHandler(eventType: string): Handler | undefined {
  return handlers[eventType];
}
