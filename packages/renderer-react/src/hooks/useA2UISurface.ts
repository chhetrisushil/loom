import type { A2UIRuntime, A2UISurfaceState } from "@loom/a2ui";
import { DEFAULT_SURFACE } from "@loom/a2ui";
import { useEffect, useState } from "react";

// Subscribes a React component to an A2UI surface held by a standalone
// A2UIRuntime, re-rendering as patches arrive. For apps that render blueprints
// through a ProjectionRuntime, prefer registering `a2uiSurfaceProjection()` and
// binding widgets to `{ projectionId: "ui", path }` instead — no hook needed.
export function useA2UISurface(
  runtime: A2UIRuntime,
  executionId: string,
  surface: string = DEFAULT_SURFACE
): A2UISurfaceState {
  const [state, setState] = useState<A2UISurfaceState>(() =>
    runtime.getSurface(surface, executionId)
  );

  useEffect(() => {
    setState(runtime.getSurface(surface, executionId));
    return runtime.subscribe(surface, executionId, (next) => setState(next));
  }, [runtime, surface, executionId]);

  return state;
}
