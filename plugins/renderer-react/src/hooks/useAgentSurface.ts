import type { AgentSurfaceRuntime, SurfaceState } from "@loom/agent-surface";
import { DEFAULT_SURFACE } from "@loom/agent-surface";
import { useEffect, useState } from "react";

// Subscribes a React component to an agent surface held by a standalone
// AgentSurfaceRuntime, re-rendering as patches arrive. For apps that render blueprints
// through a ProjectionRuntime, prefer registering `agentSurfaceProjection()` and
// binding widgets to `{ projectionId: "ui", path }` instead — no hook needed.
export function useAgentSurface(
  runtime: AgentSurfaceRuntime,
  executionId: string,
  surface: string = DEFAULT_SURFACE
): SurfaceState {
  const [state, setState] = useState<SurfaceState>(() =>
    runtime.getSurface(surface, executionId)
  );

  useEffect(() => {
    setState(runtime.getSurface(surface, executionId));
    return runtime.subscribe(surface, executionId, (next) => setState(next));
  }, [runtime, surface, executionId]);

  return state;
}
