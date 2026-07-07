import type { Topic } from "./catalogue";
import type { TelemetrySnapshot } from "./telemetry";

// ── Topic models ──────────────────────────────────────────────────────────────
// For each topic: the keywords that route to it, the WHAT widget (the direct answer
// to the question), the WHY widgets (the supporting/causal context), and the two
// narrative strings the agent produces from live telemetry. This is the causal map
// that turns a raw metric into an explanation.

export interface TopicModel {
  label: string;
  keywords: string[];
  primaryWidget: string; // catalogue id — the WHAT
  whyWidgets: string[]; // catalogue ids — the WHY
  answer: (s: TelemetrySnapshot) => string;
  explanation: (s: TelemetrySnapshot) => string;
}

const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 100));

export const TOPIC_MODELS: Record<Topic, TopicModel> = {
  cpu: {
    label: "CPU utilization",
    keywords: ["cpu", "utilization", "utilisation", "processor", "load", "compute"],
    primaryWidget: "cpu.metric",
    whyWidgets: ["connections.saturation", "queries.slow", "cpu.trend"],
    answer: (s) => `CPU utilization is ${s.cpu.current}% — ${s.cpu.status}.`,
    explanation: (s) =>
      `The connection pool is ${s.connections.active}/${s.connections.limit} (${pct(s.connections.active, s.connections.limit)}% saturated) with ${s.connections.waiting} clients queued; queued queries spin on lock acquisition, pinning the scheduler. The heaviest offender burns ${s.queries.slow[0]?.cpuPct ?? 0}% of CPU: ${s.queries.slow[0]?.statement ?? "n/a"}.`,
  },
  connections: {
    label: "Connection saturation",
    keywords: ["connection", "connections", "pool", "saturation", "clients", "sessions"],
    primaryWidget: "connections.saturation",
    whyWidgets: ["connections.waiting", "queries.slow", "cpu.metric"],
    answer: (s) =>
      `Connections are ${s.connections.active}/${s.connections.limit} (${pct(s.connections.active, s.connections.limit)}% saturated) — ${s.connections.status}.`,
    explanation: (s) =>
      `${s.connections.waiting} clients are waiting for a free slot. Long-running slow queries (top: ${s.queries.slow[0]?.statement ?? "n/a"}) hold connections open, and the resulting lock contention is also driving CPU to ${s.cpu.current}%.`,
  },
  replication: {
    label: "Replication lag",
    keywords: ["replica", "replicas", "replication", "lag", "standby", "follower"],
    primaryWidget: "replication.lag",
    whyWidgets: ["cpu.metric", "queries.slow"],
    answer: (s) => `Replica lag is ${s.replication.lagMs}ms and ${s.replication.trend}.`,
    explanation: (s) =>
      `The primary's write throughput is outpacing what ${s.replication.replicas} replicas can apply; CPU saturation (${s.cpu.current}%) slows WAL apply and extends the backlog.`,
  },
  queries: {
    label: "Slow queries",
    keywords: ["query", "queries", "slow", "statement", "sql", "index", "scan"],
    primaryWidget: "queries.slow",
    whyWidgets: ["cpu.metric", "connections.saturation"],
    answer: (s) =>
      `${s.queries.slow.length} slow queries dominate load; the worst uses ${s.queries.slow[0]?.cpuPct ?? 0}% of CPU.`,
    explanation: (s) =>
      `These statements hold connections (${s.connections.active}/${s.connections.limit}) and burn CPU (${s.cpu.current}%), which in turn raises replica lag.`,
  },
};
