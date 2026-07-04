import type { EventEnvelope } from "@loom/core";
import type { Projection } from "@loom/projection-runtime";
import { applyA2UIPatches } from "./applyPatch";
import { A2UI_PATCH, DEFAULT_SURFACE } from "./types";
import type { A2UIPatchPayload, A2UISurfaceState } from "./types";

// Bridges the A2UI protocol into an existing ProjectionRuntime. Register the
// returned projection and A2UI patches fold into a projection whose id is the
// surface id — so widgets bind to A2UI state with the ordinary
// `{ projectionId: "ui", path: "…" }` binding and the React BlueprintRenderer
// works with no changes.
//
//   projectionRuntime.register(a2uiSurfaceProjection());          // id "ui"
//   projectionRuntime.register(a2uiSurfaceProjection("sidebar")); // id "sidebar"
export function a2uiSurfaceProjection(
  surfaceId: string = DEFAULT_SURFACE
): Projection<A2UISurfaceState> {
  return {
    id: surfaceId,
    initialState: {},
    handlers: {
      [A2UI_PATCH]: (state: A2UISurfaceState, event: EventEnvelope): A2UISurfaceState => {
        const payload = event.payload as A2UIPatchPayload;
        const targetSurface = payload.surface ?? DEFAULT_SURFACE;
        // Ignore patches addressed to a different surface.
        if (targetSurface !== surfaceId) return state;
        return applyA2UIPatches(state, payload.patches);
      },
    },
  };
}
