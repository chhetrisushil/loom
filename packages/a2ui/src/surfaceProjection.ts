import { maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import type { Projection } from "@loom/projection-runtime";
import { applyA2UIPatches } from "./applyPatch";
import { A2UI_PATCH, DEFAULT_SURFACE } from "./types";
import type { A2UIPatchPayload, A2UISurfaceState } from "./types";

/** Options for a surface projection. */
export interface SurfaceProjectionOptions {
  /**
   * K10-R6 — surface dot-paths whose values must never leave the trust boundary (masked to
   * `[redacted]` in the folded surface, so anything reading it — `getSurface`/`getState`, a
   * client renderer — never sees them). A2UI patches are app-authored (not step-schema-bound,
   * so classification markers don't reach them), so the sensitive surface paths are declared
   * explicitly here. Omit for no masking (a pass-through, G2).
   */
  redact?: readonly string[];
}

// Bridges the A2UI protocol into an existing ProjectionRuntime. Register the
// returned projection and A2UI patches fold into a projection whose id is the
// surface id — so widgets bind to A2UI state with the ordinary
// `{ projectionId: "ui", path: "…" }` binding and the React BlueprintRenderer
// works with no changes.
//
//   projectionRuntime.register(a2uiSurfaceProjection());          // id "ui"
//   projectionRuntime.register(a2uiSurfaceProjection("sidebar")); // id "sidebar"
//   projectionRuntime.register(a2uiSurfaceProjection("ui", { redact: ["user.ssn"] }));
export function a2uiSurfaceProjection(
  surfaceId: string = DEFAULT_SURFACE,
  options: SurfaceProjectionOptions = {}
): Projection<A2UISurfaceState> {
  const redact = options.redact ?? [];
  return {
    id: surfaceId,
    initialState: {},
    handlers: {
      [A2UI_PATCH]: (state: A2UISurfaceState, event: EventEnvelope): A2UISurfaceState => {
        const payload = event.payload as A2UIPatchPayload;
        const targetSurface = payload.surface ?? DEFAULT_SURFACE;
        // Ignore patches addressed to a different surface.
        if (targetSurface !== surfaceId) return state;
        const next = applyA2UIPatches(state, payload.patches);
        // Mask declared paths on the folded surface — the redacted value never reaches a
        // reader. Idempotent per fold (re-masking a `[redacted]` value is a no-op).
        return redact.length > 0 ? (maskPaths(next, redact) as A2UISurfaceState) : next;
      },
    },
  };
}
