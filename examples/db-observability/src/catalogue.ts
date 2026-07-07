import { DataTable, MetricCard, ProgressBar, Timeline } from "@loom/blueprint-runtime";
import type { Widget } from "@loom/blueprint-runtime";

// ── The available widget catalogue ────────────────────────────────────────────
// The palette the dashboard is generated from. Each entry knows what telemetry it
// visualizes and how to build its bound Widget. The composer selects from this list
// at runtime based on the user's intent — the UI is assembled, not hand-authored.

export type Topic = "cpu" | "connections" | "replication" | "queries";

export interface CatalogueEntry {
  id: string;
  topic: Topic;
  summary: string; // human description of what this widget shows
  build: () => Widget;
}

export const WIDGET_CATALOGUE: CatalogueEntry[] = [
  {
    id: "cpu.metric",
    topic: "cpu",
    summary: "Current CPU utilization %",
    build: () =>
      MetricCard({
        title: "CPU utilization",
        binding: { projectionId: "cpu", path: "current" },
        unit: "%",
        format: "percent",
      }),
  },
  {
    id: "cpu.trend",
    topic: "cpu",
    summary: "CPU utilization over recent samples",
    build: () =>
      Timeline({ title: "CPU trend", binding: { projectionId: "cpu", path: "history" } }),
  },
  {
    id: "connections.saturation",
    topic: "connections",
    summary: "Active connections against the pool limit",
    build: () =>
      ProgressBar({
        title: "Connection pool",
        binding: { projectionId: "connections", path: "active" },
        max: 100,
      }),
  },
  {
    id: "connections.waiting",
    topic: "connections",
    summary: "Clients queued waiting for a connection",
    build: () =>
      MetricCard({
        title: "Waiting clients",
        binding: { projectionId: "connections", path: "waiting" },
      }),
  },
  {
    id: "replication.lag",
    topic: "replication",
    summary: "Replica apply lag in milliseconds",
    build: () =>
      MetricCard({
        title: "Replica lag",
        binding: { projectionId: "replication", path: "lagMs" },
        unit: "ms",
      }),
  },
  {
    id: "queries.slow",
    topic: "queries",
    summary: "Top CPU-consuming queries",
    build: () =>
      DataTable({
        title: "Slow queries",
        binding: { projectionId: "queries", path: "slow" },
        columns: ["statement", "cpuPct", "calls"],
      }),
  },
];

export function catalogueEntry(id: string): CatalogueEntry {
  const entry = WIDGET_CATALOGUE.find((w) => w.id === id);
  if (!entry) throw new Error(`no widget "${id}" in the catalogue`);
  return entry;
}
