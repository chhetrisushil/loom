import { RendererRegistry, defaultRegistry } from "@loom/renderer-react";
import type { WidgetRenderer } from "@loom/renderer-react";
import {
  AgentFleetRenderer,
  AgentTaskListRenderer,
  ConsoleLogRenderer,
  GaugeRenderer,
  LatencyChartRenderer,
  PhaseBannerRenderer,
  PlanFlowRenderer,
  RiskApprovalRenderer,
  SparklineRenderer,
} from "./renderers";

// ── Registry: bind each custom widget kind to its React renderer ───────────────
//
// Start from Loom's built-in renderer set (MetricCard, StatusBadge, …) and merge
// in the app's custom kinds. The BlueprintRenderer looks a widget's renderer up
// by its `kind` string here — so a blueprint can freely mix built-in and custom
// widgets, and the fiber renderer works with both unchanged.
export function buildRegistry(): RendererRegistry<WidgetRenderer> {
  const custom = new RendererRegistry<WidgetRenderer>()
    .register("AgentTaskList", AgentTaskListRenderer)
    .register("PlanFlow", PlanFlowRenderer)
    .register("RiskApproval", RiskApprovalRenderer)
    .register("PhaseBanner", PhaseBannerRenderer)
    .register("Gauge", GaugeRenderer)
    .register("Sparkline", SparklineRenderer)
    .register("AgentFleet", AgentFleetRenderer)
    .register("ConsoleLog", ConsoleLogRenderer)
    .register("LatencyChart", LatencyChartRenderer);

  // Entries in `custom` win on any conflict; built-ins remain available.
  return defaultRegistry.merge(custom);
}
