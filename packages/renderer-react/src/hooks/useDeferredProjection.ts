import type { ProjectionRuntime } from "@loom/projection-runtime";
import { startTransition, useEffect, useState } from "react";

// ── useDeferredProjection ─────────────────────────────────────────────────────
//
// Like `useProjection`, but marks streamed projection updates as non-urgent React
// transitions. This LEVERAGES React's own fiber scheduler (it does the
// interruptible reconciliation) rather than adding a second scheduler on top —
// urgent work (user input, high-priority projections rendered with the eager
// `useProjection`) can interrupt a low-priority re-render mid-flight.
//
// Use ONLY for high-frequency, low-urgency projections (streaming text, live
// metrics). Keep urgent projections (an approval action's result) on the eager
// `useProjection` path to avoid showing stale UI (tearing) on interactions.
//
// Pairs well with `InMemoryProjectionRuntime({ coalesceNotifications: true })`:
// coalescing cuts the number of updates, and deferral cuts the priority of the
// ones that remain.
export function useDeferredProjection<TState>(
  projectionRuntime: ProjectionRuntime,
  projectionId: string,
  executionId: string
): TState {
  const [state, setState] = useState<TState>(() =>
    projectionRuntime.getState<TState>(projectionId, executionId)
  );

  useEffect(() => {
    // Initial (re)subscription read is urgent — reflect current state immediately.
    setState(projectionRuntime.getState<TState>(projectionId, executionId));
    const unsub = projectionRuntime.subscribe<TState>(projectionId, executionId, (newState) => {
      // Subsequent streamed updates are deferred so they never block urgent work.
      startTransition(() => setState(newState));
    });
    return unsub;
  }, [projectionRuntime, projectionId, executionId]);

  return state;
}
