import { maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import type { Projection } from "@loom/projection-runtime";
import { applySurfacePatches } from "./applyPatch";
import { DEFAULT_SURFACE, SURFACE_PATCH } from "./types";
import type { SurfacePatchPayload, SurfaceState } from "./types";

/** Options for a surface projection. */
export interface SurfaceProjectionOptions {
  /**
   * K10-R6 — surface dot-paths whose values must never leave the trust boundary (masked to
   * `[redacted]` in the folded surface, so anything reading it — `getSurface`/`getState`, a
   * client renderer — never sees them). Surface patches are app-authored (not step-schema-bound,
   * so classification markers don't reach them), so the sensitive surface paths are declared
   * explicitly here. Omit for no masking (a pass-through, G2).
   */
  redact?: readonly string[];
}

// Bridges the agent-surface protocol into an existing ProjectionRuntime. Register
// the returned projection and surface patches fold into a projection whose id is
// the surface id — so widgets bind to surface state with the ordinary
// `{ projectionId: "ui", path: "…" }` binding and the React BlueprintRenderer
// works with no changes.
//
//   projectionRuntime.register(agentSurfaceProjection());          // id "ui"
//   projectionRuntime.register(agentSurfaceProjection("sidebar")); // id "sidebar"
//   projectionRuntime.register(agentSurfaceProjection("ui", { redact: ["user.ssn"] }));
export function agentSurfaceProjection(
  surfaceId: string = DEFAULT_SURFACE,
  options: SurfaceProjectionOptions = {}
): Projection<SurfaceState> {
  const redact = options.redact ?? [];
  return {
    id: surfaceId,
    initialState: {},
    handlers: {
      [SURFACE_PATCH]: (state: SurfaceState, event: EventEnvelope): SurfaceState => {
        const payload = event.payload as SurfacePatchPayload;
        const targetSurface = payload.surface ?? DEFAULT_SURFACE;
        // Ignore patches addressed to a different surface.
        if (targetSurface !== surfaceId) return state;
        const next = applySurfacePatches(state, payload.patches);
        // Mask declared paths on the folded surface — the redacted value never reaches a
        // reader. Idempotent per fold (re-masking a `[redacted]` value is a no-op).
        return redact.length > 0 ? (maskPaths(next, redact) as SurfaceState) : next;
      },
    },
  };
}
