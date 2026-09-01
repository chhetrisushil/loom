import { RendererRegistry } from "@loom/blueprint-runtime";
import type { WidgetRendererProps } from "@loom/blueprint-runtime";
import type React from "react";
import { AlertCardRenderer } from "./renderers/AlertCardRenderer";
import { ApprovalCardRenderer } from "./renderers/ApprovalCardRenderer";
import { DataTableRenderer } from "./renderers/DataTableRenderer";
import { MetricCardRenderer } from "./renderers/MetricCardRenderer";
import { ProgressBarRenderer } from "./renderers/ProgressBarRenderer";
import { StatusBadgeRenderer } from "./renderers/StatusBadgeRenderer";
import { StreamingTextRenderer } from "./renderers/StreamingTextRenderer";
import { TimelineRenderer } from "./renderers/TimelineRenderer";

// React-specific renderer type: a React function component that receives the
// framework-agnostic WidgetRendererProps defined in @loom/blueprint-runtime.
export type WidgetRenderer = React.FC<WidgetRendererProps>;

// Pre-populated registry of the built-in Loom widget renderers for React.
// Consumers can extend it or create a fresh RendererRegistry<WidgetRenderer>
// and register only what they need.
//
// It must cover EVERY kind in `builtinCatalog` — a vocabulary entry with no
// renderer here reaches the viewer as a placeholder string, per viewer, at render
// time, and nothing else in the system reports it. `coverage.test.tsx` fails the
// build instead.
export const defaultRegistry = new RendererRegistry<WidgetRenderer>()
  .register("MetricCard", MetricCardRenderer)
  .register("Timeline", TimelineRenderer)
  .register("ApprovalCard", ApprovalCardRenderer)
  .register("StatusBadge", StatusBadgeRenderer)
  .register("StreamingText", StreamingTextRenderer)
  .register("ProgressBar", ProgressBarRenderer)
  .register("DataTable", DataTableRenderer)
  .register("AlertCard", AlertCardRenderer);

// Re-export so callers can do: import { RendererRegistry } from "@loom/plugin-renderer-react"
export { RendererRegistry };
// Re-export the framework-agnostic props type under its original name for
// backwards compatibility (it previously lived here).
export type { WidgetRendererProps };
// WidgetAction was previously exported from this module too.
export type { WidgetAction } from "@loom/blueprint-runtime";
