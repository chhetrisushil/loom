import { MetricCard, blueprint$, grid, stack } from "@loom/blueprint-runtime";
import { AgentFleet, Gauge, LatencyChart, Sparkline } from "../widgets/customWidgets";

// ── Observability blueprint ───────────────────────────────────────────────────
//
// Bound to the "telemetry" surface. Mixes a built-in MetricCard with custom
// (BYOC) Gauge / Sparkline / AgentFleet / LatencyChart widgets. The LatencyChart
// lazy-loads its implementation, so it exercises the fiber `suspense` capability;
// the Sparkline/Gauge update as diagnosis and remediation change the metrics.
export const ObservabilityBlueprint = blueprint$({
  id: "observability",
  title: "Observability",
  layout: stack({
    gap: 14,
    children: [
      grid({
        columns: 3,
        gap: 14,
        children: [
          Gauge({ projectionId: "telemetry", path: "metrics.cpuPct" }, "CPU Utilization", {
            unit: "%",
            max: 100,
            goodBelow: 70,
          }),
          Gauge({ projectionId: "telemetry", path: "metrics.memPct" }, "Memory", {
            unit: "%",
            max: 100,
            goodBelow: 80,
          }),
          // A built-in widget alongside the custom ones — same registry, same renderer path.
          MetricCard({
            title: "Replica Lag",
            binding: { projectionId: "telemetry", path: "metrics.lagMs" },
            unit: "ms",
          }),
        ],
      }),
      grid({
        columns: 2,
        gap: 14,
        children: [
          Sparkline({ projectionId: "telemetry", path: "history.cpu" }, "CPU History", {
            unit: "%",
          }),
          LatencyChart({ projectionId: "telemetry", path: "history.lag" }, "Replica Lag (ms)"),
        ],
      }),
      AgentFleet({ projectionId: "telemetry", path: "fleet" }, "Long-Running Agent Fleet"),
    ],
  }),
  projections: ["telemetry"],
});
