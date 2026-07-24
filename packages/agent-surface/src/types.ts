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

export interface SurfacePatchPayload {
  // Which surface this batch targets. Absent means DEFAULT_SURFACE.
  surface?: string;
  patches: SurfacePatch[];
}

// The client-side UI state tree an agent mutates via patches.
export type SurfaceState = Record<string, unknown>;
