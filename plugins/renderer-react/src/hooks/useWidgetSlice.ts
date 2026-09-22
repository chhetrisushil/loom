import type { BindingStatus, Widget } from "@loom/blueprint-runtime";
import { resolveWidgetStatus, resolveWidgetValue } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { useCallback, useRef, useSyncExternalStore } from "react";

// ── useWidgetSlice ───────────────────────────────────────────────────────────
//
// Sibling to useWidgetValue: the same tear-free, path-granular subscription,
// but selects `{ value, status }` together so a fiber widget re-renders when
// EITHER its bound value OR its declared status channel changes, and neither
// alone forces an extra render of the other.
//
// isEqual compares `value` by Object.is and `status` by its observable fields
// (`state`, `seq`, `finding.message`) rather than by reference — resolveWidgetStatus
// returns whatever object lives at the status path, so two reads of an unchanged
// status may not be the same reference even though nothing meaningful changed.
export interface WidgetSlice {
  value: unknown;
  status?: BindingStatus;
}

function isEqualSlice(a: WidgetSlice, b: WidgetSlice): boolean {
  return (
    Object.is(a.value, b.value) &&
    a.status?.state === b.status?.state &&
    a.status?.seq === b.status?.seq &&
    a.status?.finding?.message === b.status?.finding?.message
  );
}

function sliceOf(widget: Widget, projectionId: string | undefined, state: unknown): WidgetSlice {
  const map = new Map<string, unknown>();
  if (projectionId !== undefined) {
    map.set(projectionId, state);
  }
  const value = resolveWidgetValue(widget, map);
  const status = resolveWidgetStatus(widget, map);
  return { value, ...(status !== undefined && { status }) };
}

export function useWidgetSlice(
  runtime: ProjectionRuntime,
  widget: Widget,
  executionId: string
): WidgetSlice {
  const projectionId = widget.binding?.projectionId;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // A widget with no binding never changes — subscribe to nothing.
      if (projectionId === undefined) return () => {};
      return runtime.subscribeSelector(
        projectionId,
        executionId,
        (state) => sliceOf(widget, projectionId, state),
        () => onStoreChange(),
        isEqualSlice as (a: unknown, b: unknown) => boolean
      );
    },
    [runtime, projectionId, executionId, widget]
  );

  // Cache the last resolved slice so an unchanged slice returns a STABLE
  // reference — required by useSyncExternalStore, and what gives this
  // hook its granularity (an unrelated change leaves this === and produces
  // no re-render even though `subscribe` fired).
  const cache = useRef<{ has: boolean; value: WidgetSlice }>({
    has: false,
    value: { value: undefined },
  });

  const getSnapshot = useCallback((): WidgetSlice => {
    const state =
      projectionId !== undefined ? runtime.getState(projectionId, executionId) : undefined;
    const next = sliceOf(widget, projectionId, state);
    if (cache.current.has && isEqualSlice(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [runtime, widget, executionId, projectionId]);

  // Same snapshot for server/seeded render — LoomProvider seeds state
  // synchronously, so getState already returns the seeded value (no flash).
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
