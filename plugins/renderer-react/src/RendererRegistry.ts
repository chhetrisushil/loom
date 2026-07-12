import { RendererRegistry } from "@loom/blueprint-runtime";
import type { WidgetRendererProps } from "@loom/blueprint-runtime";
import type React from "react";
import { ApprovalCardRenderer } from "./renderers/ApprovalCardRenderer";
import { MetricCardRenderer } from "./renderers/MetricCardRenderer";
import { StatusBadgeRenderer } from "./renderers/StatusBadgeRenderer";
import { StreamingTextRenderer } from "./renderers/StreamingTextRenderer";
import { TimelineRenderer } from "./renderers/TimelineRenderer";

// React-specific renderer type: a React function component that receives the
// framework-agnostic WidgetRendererProps defined in @loom/blueprint-runtime.
export type WidgetRenderer = React.FC<WidgetRendererProps>;

// Pre-populated registry of the built-in Loom widget renderers for React.
// Consumers can extend it or create a fresh RendererRegistry<WidgetRenderer>
// and register only what they need.
export const defaultRegistry = new RendererRegistry<WidgetRenderer>()
  .register("MetricCard", MetricCardRenderer)
  .register("Timeline", TimelineRenderer)
  .register("ApprovalCard", ApprovalCardRenderer)
  .register("StatusBadge", StatusBadgeRenderer)
  .register("StreamingText", StreamingTextRenderer);

// Re-export so callers can do: import { RendererRegistry } from "@loom/plugin-renderer-react"
export { RendererRegistry };
// Re-export the framework-agnostic props type under its original name for
// backwards compatibility (it previously lived here).
export type { WidgetRendererProps };
// WidgetAction was previously exported from this module too.
export type { WidgetAction } from "@loom/blueprint-runtime";
