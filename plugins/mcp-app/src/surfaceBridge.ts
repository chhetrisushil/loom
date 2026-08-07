// ── Surface → MCP Apps payload ───────────────────────────────────────────────
//
// The payload half of the binding. The static template (./template) renders a
// declarative A2UI component tree bound to a data model; this module produces
// that payload from a loom agent surface, so `structuredContent` carries DATA
// and never code.
//
// Reuse is the point: `ComponentInstance` and the catalog vocabulary already
// shipped for the A2UI adapter (ADR 0069/0070). MCP Apps is a second transport
// binding for them, so the two surfaces cannot drift into different UI models.

import { DEFAULT_SURFACE, SURFACE_PATCH, applySurfacePatches } from "@loom/agent-surface";
import type { SurfacePatchPayload, SurfaceState } from "@loom/agent-surface";
import { maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import type { ComponentInstance } from "@loom/plugin-a2ui";

/** What the template receives as `structuredContent`. */
export interface SurfacePayload {
  surfaceId: string;
  /** The component tree — exactly one node must have `id: "root"`. */
  components: ComponentInstance[];
  /** The data model components bind into by JSON Pointer. */
  dataModel: SurfaceState;
  /** The log sequence this payload folded up to — the cursor for the next read. */
  sequence: number;
}

export interface SurfacePayloadOptions {
  /** Which loom agent surface to project (default `DEFAULT_SURFACE` = "ui"). */
  surface?: string;
  /** The execution whose surface this is. */
  executionId: string;
  /** The surfaceId put on the wire; defaults to `${surface}:${executionId}`. */
  surfaceId?: string;
  /** The component tree. */
  components: ComponentInstance[];
  /**
   * K10-R6 egress redaction — surface dot-paths masked to `[redacted]` before any
   * value leaves for the View.
   *
   * REQUIRED, not defaulted. A payload built here crosses the trust boundary into
   * a rendered iframe; a redaction list that quietly defaults to empty is a
   * silent leak, and "we forgot to configure it" then looks identical to "there
   * is nothing to redact". Pass `[]` to assert explicitly that nothing needs
   * masking on this surface.
   */
  redact: readonly string[];
}

/**
 * Fold a loom event stream into the payload the surface-host template renders.
 *
 * Only `SURFACE_PATCH` events participate; everything else advances the sequence
 * cursor and is ignored, so the same stream can be replayed through this without
 * any coupling to the rest of the log.
 */
export function surfacePayload(
  events: readonly EventEnvelope[],
  options: SurfacePayloadOptions
): SurfacePayload {
  const surface = options.surface ?? DEFAULT_SURFACE;
  let state: SurfaceState = {};
  let sequence = 0;

  for (const event of events) {
    if (typeof event.sequence === "number") sequence = event.sequence;
    if (event.eventType !== SURFACE_PATCH) continue;
    const payload = event.payload as SurfacePatchPayload | undefined;
    if (payload === undefined) continue;
    if ((payload.surface ?? DEFAULT_SURFACE) !== surface) continue;
    state = applySurfacePatches(state, payload.patches);
  }

  return {
    surfaceId: options.surfaceId ?? `${surface}:${options.executionId}`,
    components: options.components,
    // Mask on the way out only — the fold above keeps true values so
    // increment/append/merge stay correct (the A2UISurfaceBridge discipline).
    dataModel:
      options.redact.length > 0 ? (maskPaths(state, options.redact) as SurfaceState) : state,
    sequence,
  };
}
