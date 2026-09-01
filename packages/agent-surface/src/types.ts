// ── Agent-surface protocol constants ─────────────────────────────────────────
//
// This is Loom's *native*, event-sourced surface protocol — an agent drives a UI
// state tree by emitting durable patch events. It is deliberately NOT the Google
// A2UI wire protocol (component catalogs, JSON-Pointer bindings, bidirectional
// RPC); for interop with external A2UI clients see the `@loom/plugin-a2ui`
// adapter, which projects these surfaces onto the A2UI wire format.

// The single event type that carries every surface update. Because updates travel
// as ordinary Loom events, they are durable, ordered, and replayable — the UI
// surface is fully reconstructable from the event log.
export const SURFACE_PATCH = "SURFACE_PATCH";

// Default surface id. A "surface" is one addressable UI state tree; most apps
// use exactly one, but an agent can drive several (e.g. "ui", "sidebar").
export const DEFAULT_SURFACE = "ui";

// ── Patch operations ─────────────────────────────────────────────────────────

// SurfacePatch is the protocol's unit of change — a single, declarative mutation
// of the surface state, addressed by a dot-notation path ("" = the root).
export type SurfacePatch =
  | { op: "set"; path: string; value: unknown }
  | { op: "merge"; path: string; value: Record<string, unknown> }
  | { op: "append"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "increment"; path: string; by?: number };

/**
 * Who placed a patch — the provenance of one change to the surface.
 *
 * "Why is this panel here" is only answerable if something recorded the answer at
 * the moment it was placed, and there was nowhere to record it: `ctx.emit` takes
 * no metadata, so the only place provenance could go was INSIDE the patched
 * value, where it pollutes the very data model the client binds to.
 *
 * It rides the payload instead. `SURFACE_PATCH` is a userspace domain event — the
 * fold skips it — so this is additive by construction: EVENT_SCHEMA is untouched,
 * and a log written without it folds identically.
 *
 * It is deliberately NOT forwarded to clients. The A2UI bridge reads `patches`
 * only, so an internal agent id never reaches a viewer.
 */
export interface PatchProvenance {
  /** The author: an agent id, a model identifier, a user id. */
  by: string;
  /** Free-form detail — a model version, an evidence ref, a tool call id. */
  note?: string;
}

export interface SurfacePatchPayload {
  // Which surface this batch targets. Absent means DEFAULT_SURFACE.
  surface?: string;
  patches: SurfacePatch[];
  /** Who placed these patches. Absent means unattributed, which is a normal state. */
  by?: PatchProvenance;
}

// The client-side UI state tree an agent mutates via patches.
export type SurfaceState = Record<string, unknown>;
