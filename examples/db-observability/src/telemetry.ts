import type { EventEnvelope } from "@loom/core";
import type { Projection, ProjectionRuntime } from "@loom/projection-runtime";

// ── Telemetry read-models ─────────────────────────────────────────────────────
// The live signals the dashboard binds to. Each is a Loom projection folded from
// telemetry events; here we seed a deterministic "DB under CPU stress" scenario.

export interface CpuState {
  current: number;
  status: string;
  history: number[];
}
export interface ConnectionsState {
  active: number;
  waiting: number;
  limit: number;
  status: string;
}
export interface ReplicationState {
  lagMs: number;
  trend: string;
  replicas: number;
}
export interface SlowQuery {
  statement: string;
  cpuPct: number;
  calls: number;
}
export interface QueriesState {
  slow: SlowQuery[];
  total: number;
}

/** What the composer writes so widgets can bind to the agent's answer text. */
export interface AnswerState {
  question: string;
  topic: string;
  what: string;
  why: string;
}

export interface TelemetrySnapshot {
  cpu: CpuState;
  connections: ConnectionsState;
  replication: ReplicationState;
  queries: QueriesState;
}

// A generic "replace state from the event payload" fold — enough for a demo where we
// seed a scenario; a real deployment would fold incremental METRIC_SAMPLED events.
// Each projection listens on its own `<id>.sample` event so a live update can target
// one projection (handleEvent applies an event to EVERY projection with a handler for
// that type).
function replace<T>(id: string, initialState: T): Projection<T> {
  return {
    id,
    initialState,
    handlers: { [`${id}.sample`]: (_state: T, event: EventEnvelope) => event.payload as T },
  };
}

export const cpuProjection = replace<CpuState>("cpu", {
  current: 0,
  status: "nominal",
  history: [],
});
export const connectionsProjection = replace<ConnectionsState>("connections", {
  active: 0,
  waiting: 0,
  limit: 100,
  status: "nominal",
});
export const replicationProjection = replace<ReplicationState>("replication", {
  lagMs: 0,
  trend: "stable",
  replicas: 2,
});
export const queriesProjection = replace<QueriesState>("queries", { slow: [], total: 0 });
export const answerProjection = replace<AnswerState>("answer", {
  question: "",
  topic: "",
  what: "",
  why: "",
});

export const TELEMETRY_PROJECTIONS = [
  cpuProjection,
  connectionsProjection,
  replicationProjection,
  queriesProjection,
] as unknown as Array<Projection<unknown>>;

/** Seed the deterministic scenario: a primary saturating CPU under pool exhaustion. */
export function seedScenario(pr: ProjectionRuntime, executionId: string): void {
  pr.seedState("cpu", executionId, {
    current: 91,
    status: "saturated",
    history: [42, 55, 68, 79, 91],
  } satisfies CpuState);
  pr.seedState("connections", executionId, {
    active: 98,
    waiting: 12,
    limit: 100,
    status: "critical",
  } satisfies ConnectionsState);
  pr.seedState("replication", executionId, {
    lagMs: 320,
    trend: "rising",
    replicas: 2,
  } satisfies ReplicationState);
  pr.seedState("queries", executionId, {
    slow: [
      { statement: "SELECT * FROM orders o JOIN line_items li ON …", cpuPct: 61, calls: 1240 },
      { statement: "UPDATE inventory SET qty = qty - $1 WHERE …", cpuPct: 18, calls: 880 },
    ],
    total: 3800,
  } satisfies QueriesState);
}

/**
 * Apply the output of a durable hydration run (projectionId → reshaped state)
 * to the projections the widgets bind to. The states arrive from the
 * fanout$ → mcpInvoke$ → sandboxEval$ interpreter flow (src/hydration.ts).
 */
export function applyHydratedStates(
  pr: ProjectionRuntime,
  executionId: string,
  states: Record<string, unknown>
): void {
  for (const [projectionId, state] of Object.entries(states)) {
    pr.seedState(projectionId, executionId, state);
  }
}

/** Read the current telemetry as a plain snapshot (for the composer's reasoning). */
export function readTelemetry(pr: ProjectionRuntime, executionId: string): TelemetrySnapshot {
  return {
    cpu: pr.getState<CpuState>("cpu", executionId),
    connections: pr.getState<ConnectionsState>("connections", executionId),
    replication: pr.getState<ReplicationState>("replication", executionId),
    queries: pr.getState<QueriesState>("queries", executionId),
  };
}

// ── Live telemetry (browser "Live" toggle) ────────────────────────────────────
// Deterministic oscillation (sine of a tick, NOT Math.random) so the gauge/area
// animate. handleEvent fires subscribers → bound widgets re-render.
let seq = 1;
export function sampleEvent(
  projectionId: string,
  executionId: string,
  payload: unknown
): EventEnvelope {
  return {
    id: `${projectionId}-${seq}`,
    workflowId: "observability",
    executionId,
    eventType: `${projectionId}.sample`,
    sequence: seq++,
    timestamp: 0,
    payload,
  };
}

export function nextCpuSample(prev: CpuState, tick: number): CpuState {
  const current = Math.round(88 + Math.sin(tick / 2) * 6); // 82–94, deterministic
  return {
    current,
    status: current >= 85 ? "saturated" : "elevated",
    history: [...prev.history.slice(-11), current],
  };
}

export function nextConnectionsSample(prev: ConnectionsState, tick: number): ConnectionsState {
  const active = Math.min(prev.limit, Math.round(94 + Math.sin(tick / 2 + 1) * 5)); // 89–99
  return {
    ...prev,
    active,
    waiting: Math.max(0, active - 88),
    status: active >= 95 ? "critical" : "warning",
  };
}
