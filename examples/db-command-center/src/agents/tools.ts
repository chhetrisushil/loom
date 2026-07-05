import { tool$ } from "@loom/core";
import { z } from "zod";

// ── Mock database-fleet tools ─────────────────────────────────────────────────
//
// The concrete effects a domain agent can call. In production these would be an
// MCP server, a Prometheus client, a cloud-provider SDK, etc.; here they return
// deterministic data so the demo is fully offline. Each is a tool$ definition
// (so it can be attached to an agent$ and offered to the model) plus a plain
// implementation the EffectRuntime runs.

export const MetricsTool = tool$({
  id: "db-metrics",
  name: "Fetch DB Metrics",
  description: "Fetch current CPU, memory and connection-pool metrics for a database target",
  kind: "tool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({
    cpuPct: z.number(),
    memPct: z.number(),
    poolUsed: z.number(),
    poolMax: z.number(),
    qps: z.number(),
  }),
});

export const ReplicaStatusTool = tool$({
  id: "replica-status",
  name: "Fetch Replica Status",
  description: "Fetch read-replica count and replication lag for a database target",
  kind: "tool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({
    replicas: z.number(),
    lagMs: z.number(),
    walQueue: z.number(),
    writeQps: z.number(),
  }),
});

export const RestartPoolTool = tool$({
  id: "restart-pool",
  name: "Recycle Connection Pool",
  description: "Gracefully recycle the connection pool and raise its ceiling",
  kind: "tool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ summary: z.string(), newCpuPct: z.number() }),
});

export const ScaleReplicasTool = tool$({
  id: "scale-replicas",
  name: "Scale Read Replicas",
  description: "Add read-replica capacity to drain the WAL apply backlog",
  kind: "tool",
  inputSchema: z.object({ target: z.string(), addReplicas: z.number() }),
  outputSchema: z.object({ summary: z.string(), newLagMs: z.number() }),
});

// ── Implementations ───────────────────────────────────────────────────────────
// Deterministic mock data keyed off the target name.

export function fetchMetrics(_target: string): {
  cpuPct: number;
  memPct: number;
  poolUsed: number;
  poolMax: number;
  qps: number;
} {
  return { cpuPct: 91, memPct: 68, poolUsed: 200, poolMax: 200, qps: 4200 };
}

export function fetchReplicaStatus(_target: string): {
  replicas: number;
  lagMs: number;
  walQueue: number;
  writeQps: number;
} {
  return { replicas: 2, lagMs: 4200, walQueue: 18000, writeQps: 3100 };
}

export function restartPool(target: string): { summary: string; newCpuPct: number } {
  return {
    summary: `Recycled the connection pool on ${target} and raised the ceiling 200 → 400. CPU settling to ~34%.`,
    newCpuPct: 34,
  };
}

export function scaleReplicas(
  target: string,
  addReplicas: number
): { summary: string; newLagMs: number } {
  return {
    summary: `Provisioned ${addReplicas} additional read replica(s) on ${target}; WAL backlog draining, lag falling to ~180ms.`,
    newLagMs: 180,
  };
}

// A small delay used to simulate genuinely long-running agent work.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
