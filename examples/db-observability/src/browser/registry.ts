import { RendererRegistry, defaultRegistry } from "@loom/renderer-react";
import type { WidgetRenderer } from "@loom/renderer-react";
import {
  DataTableRenderer,
  MetricCardRenderer,
  ProgressBarRenderer,
  StatusBadgeRenderer,
  TimelineRenderer,
} from "./renderers";

/**
 * The visual registry: our chart renderers registered under the STANDARD widget-kind
 * names, merged OVER renderer-react's built-ins (entries in `custom` win). So the same
 * blueprint the composer emits renders as charts here — no catalogue change needed.
 * BlueprintRenderer uses `registry ?? defaultRegistry`, so the merge must be explicit.
 */
export function buildRegistry(): RendererRegistry<WidgetRenderer> {
  const custom = new RendererRegistry<WidgetRenderer>()
    .register("MetricCard", MetricCardRenderer)
    .register("Timeline", TimelineRenderer)
    .register("ProgressBar", ProgressBarRenderer)
    .register("DataTable", DataTableRenderer)
    .register("StatusBadge", StatusBadgeRenderer);
  return defaultRegistry.merge(custom);
}
