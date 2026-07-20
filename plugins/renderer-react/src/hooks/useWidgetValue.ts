import type { Widget } from "@loom/blueprint-runtime";
import { resolvePath, resolveWidgetValue } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { useCallback, useRef, useSyncExternalStore } from "react";

// ── useWidgetValue ────────────────────────────────────────────────────────────
//
// Tear-free, path-granular subscription for a single widget. Subscribes to the
// widget's bound projection but only triggers a re-render when the widget's own
// slice (binding.path) actually changes — so a projection update re-renders only
// the widgets whose values changed, not the whole blueprint.
//
// Uses useSyncExternalStore (always-urgent, tear-free). For high-frequency
// streaming widgets that should yield to urgent work, use useDeferredWidgetValue
// instead — startTransition cannot be layered on useSyncExternalStore.
export function useWidgetValue<T = unknown>(
  runtime: ProjectionRuntime,
  widget: Widget,
  executionId: string,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const projectionId = widget.binding?.projectionId;
  const path = widget.binding?.path;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // A widget with no binding never changes — subscribe to nothing.
      if (projectionId === undefined) return () => {};
      // Slice-scoped: the runtime wakes us only when THIS widget's bound slice
      // changes, so an unrelated slice's update on the same projection no longer
      // schedules React work at all. Deps are stable primitives (projectionId, path),
      // so the subscription is not torn down and rebuilt on every parent render.
      return runtime.subscribeSelector(
        projectionId,
        executionId,
        (state) => resolvePath(state, path ?? ""),
        () => onStoreChange(),
        isEqual as (a: unknown, b: unknown) => boolean
      );
    },
    [runtime, projectionId, executionId, path, isEqual]
  );

  // Cache the last resolved slice so equal values return a STABLE reference —
  // required by useSyncExternalStore to avoid an infinite render loop, and what
  // gives us path-level granularity (a sibling-slice change leaves this === and
  // produces no re-render even though `subscribe` fired).
  const cache = useRef<{ has: boolean; value: T }>({ has: false, value: undefined as T });

  const getSnapshot = useCallback((): T => {
    const map = new Map<string, unknown>();
    if (projectionId !== undefined) {
      map.set(projectionId, runtime.getState(projectionId, executionId));
    }
    const next = resolveWidgetValue(widget, map) as T;
    if (cache.current.has && isEqual(cache.current.value, next)) {
      return cache.current.value;
    }
    cache.current = { has: true, value: next };
    return next;
  }, [runtime, widget, executionId, projectionId, isEqual]);

  // Same snapshot for server/seeded render — LoomProvider seeds state
  // synchronously, so getState already returns the seeded value (no flash).
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
