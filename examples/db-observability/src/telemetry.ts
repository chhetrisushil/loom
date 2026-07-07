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
function replace<T>(id: string, initialState: T): Projection<T> {
  return {
    id,
    initialState,
    handlers: { SAMPLE: (_state: T, event: EventEnvelope) => event.payload as T },
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

/** Read the current telemetry as a plain snapshot (for the composer's reasoning). */
export function readTelemetry(pr: ProjectionRuntime, executionId: string): TelemetrySnapshot {
  return {
    cpu: pr.getState<CpuState>("cpu", executionId),
    connections: pr.getState<ConnectionsState>("connections", executionId),
    replication: pr.getState<ReplicationState>("replication", executionId),
    queries: pr.getState<QueriesState>("queries", executionId),
  };
}
