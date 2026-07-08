import type { EventEnvelope } from "@loom/core";
import type { ExecutionFrame, ExecutionState } from "@loom/core";

type Handler = (state: ExecutionState, event: EventEnvelope) => ExecutionState;

// Copy-on-write a single frame: a shallow spread of the frames container (S key
// references, untouched frames shared) plus the one new frame — O(S) refs + 1
// allocation, instead of deep-cloning all S frames on every step event. Safe
// because handlers never mutate a frame in place; they always write a new object.
function withFrame(
  frames: Record<string, ExecutionFrame>,
  stepId: string,
  frame: ExecutionFrame
): Record<string, ExecutionFrame> {
  return { ...frames, [stepId]: frame };
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
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "running",
      attempts: (existing?.attempts ?? 0) + 1,
      startedAt: event.timestamp,
      ...(payload.input !== undefined && { input: payload.input }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_COMPLETED: (state, event) => {
    const payload = event.payload as { stepId: string; output?: unknown };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "completed",
      attempts: existing?.attempts ?? 1,
      completedAt: event.timestamp,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.output !== undefined && { output: payload.output }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_FAILED: (state, event) => {
    const payload = event.payload as { stepId: string; error?: unknown };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "failed",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.error !== undefined && { error: payload.error }),
    };
    return {
      ...state,
      status: "failed",
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_CANCELLED: (state, event) => {
    // Marks the in-flight step as cancelled WITHOUT touching execution status —
    // the surrounding EXECUTION_CANCELLED event owns the execution-level status,
    // and this must not overwrite it back to a failure/other state.
    const payload = event.payload as { stepId: string };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "cancelled",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_RETRYING: (state, event) => {
    const payload = event.payload as { stepId: string; attempt: number };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "pending",
      attempts: payload.attempt,
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return {
      ...state,
      frames: withFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  PARALLEL_STARTED: (state, event) => {
    const payload = event.payload as { stepIds: string[] };
    // One fresh container, then write each new frame into it (the container is
    // not shared, so in-place writes are safe).
    const frames = { ...state.frames };
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

  // Loom 2.0 (P9) — a durable record of an advisory/optimizer choice. Stored in a
  // reserved `_decisions` map keyed by decisionId so replay serves the recorded
  // choice instead of re-consulting the optimizer, keeping the fold pure (P2).
  DECISION_RECORDED: (state, event) => {
    const payload = event.payload as {
      decisionId: string;
      choice: unknown;
      rationale?: unknown;
      source?: string;
    };
    const existing = (state.variables._decisions as Record<string, unknown> | undefined) ?? {};
    return {
      ...state,
      variables: {
        ...state.variables,
        _decisions: {
          ...existing,
          [payload.decisionId]: {
            choice: payload.choice,
            ...(payload.rationale !== undefined && { rationale: payload.rationale }),
            ...(payload.source !== undefined && { source: payload.source }),
          },
        },
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K2) — a capability denial: the EffectRuntime refused an ungranted
  // effect. Recorded as a durable audit fact in a reserved `_denials` list (the
  // step itself still fails via the STEP_FAILED that follows). Pure audit — it does
  // not change frame/execution status.
  EFFECT_DENIED: (state, event) => {
    const payload = event.payload as { toolId: string; stepId?: string; reason?: string };
    const existing = (state.variables._denials as unknown[] | undefined) ?? [];
    return {
      ...state,
      variables: {
        ...state.variables,
        _denials: [
          ...existing,
          {
            toolId: payload.toolId,
            ...(payload.stepId !== undefined && { stepId: payload.stepId }),
            ...(payload.reason !== undefined && { reason: payload.reason }),
          },
        ],
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K3) — accumulate metered resource usage (tokens / cost / wall-time)
  // into a reserved `_resources` running total. Emitted by accounting middleware
  // when an effect actually runs, so the total is deterministic on replay.
  RESOURCE_METERED: (state, event) => {
    const p = event.payload as { tokens?: number; costUsd?: number; ms?: number };
    const r = (state.variables._resources as
      | { tokens: number; costUsd: number; ms: number; count: number; exceeded?: boolean }
      | undefined) ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
    return {
      ...state,
      variables: {
        ...state.variables,
        _resources: {
          tokens: r.tokens + (p.tokens ?? 0),
          costUsd: r.costUsd + (p.costUsd ?? 0),
          ms: r.ms + (p.ms ?? 0),
          count: r.count + 1,
          ...(r.exceeded === true && { exceeded: true }),
        },
      },
      updatedAt: event.timestamp,
    };
  },

  // A quota admission-control denial: the execution exceeded its budget, so the
  // effect was refused. Marks `_resources.exceeded` (the STEP_FAILED that follows
  // fails the step). Pure audit.
  QUOTA_EXCEEDED: (state, event) => {
    const p = event.payload as { reason?: string };
    const r = (state.variables._resources as
      | { tokens: number; costUsd: number; ms: number; count: number; exceeded?: boolean }
      | undefined) ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
    return {
      ...state,
      variables: {
        ...state.variables,
        _resources: { ...r, exceeded: true, ...(p.reason !== undefined && { reason: p.reason }) },
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

// ── Event-schema ABI governance (Loom 2.0 K5) ────────────────────────────────
//
// The event log is the kernel's on-disk ABI: state is `fold(events)`, and stored
// logs must replay across deploys (this is what `@loom/deploy-sim` guards at the
// flow level). This names and versions the *set of event types the fold understands*.
// Governance: adding an event type is additive (bump MINOR, update the pinned list);
// removing or repurposing one changes how historical logs fold and is a MAJOR break
// that must be deliberate — the conformance test pins `knownEventTypes()`.
export const EVENT_SCHEMA_VERSION = "1.0.0";

export function knownEventTypes(): string[] {
  return Object.keys(handlers).sort();
}
