// ── A2UI protocol constants ──────────────────────────────────────────────────

// The single event type that carries every A2UI update. Because updates travel
// as ordinary Loom events, they are durable, ordered, and replayable — the UI
// surface is fully reconstructable from the event log.
export const A2UI_PATCH = "A2UI_PATCH";

// Default surface id. A "surface" is one addressable UI state tree; most apps
// use exactly one, but an agent can drive several (e.g. "ui", "sidebar").
export const DEFAULT_SURFACE = "ui";

// ── Patch operations ─────────────────────────────────────────────────────────

// A2UIPatch is the protocol's unit of change — a single, declarative mutation of
// the surface state, addressed by a dot-notation path ("" = the root).
export type A2UIPatch =
  | { op: "set"; path: string; value: unknown }
  | { op: "merge"; path: string; value: Record<string, unknown> }
  | { op: "append"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "increment"; path: string; by?: number };

export interface A2UIPatchPayload {
  // Which surface this batch targets. Absent means DEFAULT_SURFACE.
  surface?: string;
  patches: A2UIPatch[];
}

// The client-side UI state tree an agent mutates via patches.
export type A2UISurfaceState = Record<string, unknown>;
