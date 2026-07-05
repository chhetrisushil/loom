import type { Widget } from "@loom/blueprint-runtime";
import { resolveWidgetValue } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { startTransition, useEffect, useState } from "react";

// Module-level (stable) selector so it never needs to be an effect dependency.
function selectSlice<T>(runtime: ProjectionRuntime, widget: Widget, executionId: string): T {
  const projectionId = widget.binding?.projectionId;
  const map = new Map<string, unknown>();
  if (projectionId !== undefined) {
    map.set(projectionId, runtime.getState(projectionId, executionId));
  }
  return resolveWidgetValue(widget, map) as T;
}

// ── useDeferredWidgetValue ────────────────────────────────────────────────────
//
// Path-granular like useWidgetValue, but streams subsequent updates as non-urgent
// React transitions (startTransition) so a high-frequency widget (e.g. token-by-
// token StreamingText) never blocks urgent work. This LEVERAGES React's own fiber
// scheduler — it does the interruptible reconciliation; we only mark intent.
//
// Trade-off (same as useDeferredProjection): deferred updates can momentarily tear
// relative to eager widgets. Use ONLY for high-frequency, low-urgency widgets.
// startTransition cannot be used with useSyncExternalStore, so this is a separate
// useState-based implementation with its own path-selection + equality guard
// (Object.is on the resolved slice).
export function useDeferredWidgetValue<T = unknown>(
  runtime: ProjectionRuntime,
  widget: Widget,
  executionId: string
): T {
  const projectionId = widget.binding?.projectionId;
  const [value, setValue] = useState<T>(() => selectSlice<T>(runtime, widget, executionId));

  useEffect(() => {
    // Urgent initial read on (re)subscribe.
    setValue(selectSlice<T>(runtime, widget, executionId));
    if (projectionId === undefined) return;
    return runtime.subscribe(projectionId, executionId, () => {
      const next = selectSlice<T>(runtime, widget, executionId);
      startTransition(() => {
        setValue((prev) => (Object.is(prev, next) ? prev : next));
      });
    });
  }, [runtime, widget, projectionId, executionId]);

  return value;
}
