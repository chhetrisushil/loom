import { useEffect, useState } from "react";
import type { ProjectionRuntime } from "@loom/projection-runtime";

export function useProjection<TState>(
  projectionRuntime: ProjectionRuntime,
  projectionId: string,
  executionId: string
): TState {
  const [state, setState] = useState<TState>(() =>
    projectionRuntime.getState<TState>(projectionId, executionId)
  );

  useEffect(() => {
    setState(projectionRuntime.getState<TState>(projectionId, executionId));
    const unsub = projectionRuntime.subscribe<TState>(
      projectionId,
      executionId,
      (newState) => setState(newState)
    );
    return unsub;
  }, [projectionRuntime, projectionId, executionId]);

  return state;
}
