import type { EventEnvelope } from "@loom/core";
import type { Projection } from "@loom/projection-runtime";
import { DEFAULT_SURFACE, SURFACE_PATCH } from "./types";
import type { PatchProvenance, SurfacePatchPayload } from "./types";

// ── Who placed what, as a projection over the log ─────────────────────────────
//
// Surface patches are ordered events, so "which patch last wrote this path" is a
// fold — not a second store, and not a field on the state tree. Keeping it a
// separate projection is what stops provenance from leaking into the data model
// the client binds to.
//
// A patch with no `by` records nothing. Unattributed is a normal state, and
// synthesising an author for it would be worse than leaving the question
// unanswered.

/** One recorded placement. */
export interface PathProvenance extends PatchProvenance {
  /** The event sequence at which this path was last written. */
  sequence: number;
  /** The patch operation that wrote it. */
  op: string;
}

/** Path (dot-notation, "" = root) → who last wrote it. */
export type ProvenanceState = Record<string, PathProvenance>;

/**
 * Folds `SURFACE_PATCH` provenance for one surface.
 *
 * Register it alongside `agentSurfaceProjection(surfaceId)` under a distinct id:
 *
 *   projectionRuntime.register(agentSurfaceProjection("ui"));
 *   projectionRuntime.register(surfaceProvenanceProjection("ui", "ui:provenance"));
 */
export function surfaceProvenanceProjection(
  surfaceId: string = DEFAULT_SURFACE,
  projectionId = `${surfaceId}:provenance`
): Projection<ProvenanceState> {
  return {
    id: projectionId,
    initialState: {},
    handlers: {
      [SURFACE_PATCH]: (state: ProvenanceState, event: EventEnvelope): ProvenanceState => {
        const payload = event.payload as SurfacePatchPayload;
        if ((payload.surface ?? DEFAULT_SURFACE) !== surfaceId) return state;
        if (!payload.by) return state;

        const next: ProvenanceState = { ...state };
        for (const patch of payload.patches) {
          next[patch.path] = {
            ...payload.by,
            sequence: event.sequence,
            op: patch.op,
          };
        }
        return next;
      },
    },
  };
}

/**
 * The provenance governing `path` — the exact entry if one exists, otherwise the
 * nearest recorded ancestor.
 *
 * The fallback is the point. A composer that sets a whole panel in one patch
 * records provenance for the panel, not for every leaf inside it; asking "who
 * placed this widget" then has to walk up to the placement that actually
 * happened. Returns undefined when nothing on the path was ever attributed.
 */
export function provenanceOf(state: ProvenanceState, path: string): PathProvenance | undefined {
  if (Object.hasOwn(state, path)) return state[path];
  const parts = path.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join(".");
    if (Object.hasOwn(state, ancestor)) return state[ancestor];
  }
  return Object.hasOwn(state, "") ? state[""] : undefined;
}
