import type { EventEnvelope } from "@loom/core";

// ── Shared client/server wire protocol ────────────────────────────────────────
//
// Pure types + route constants imported by BOTH the Node server and the browser
// client. The EventEnvelope import is type-only, so nothing runtime crosses into
// the client bundle.

// This example runs a single active mission at a time under a fixed id (the
// server holds one Orchestrator). Starting a new goal resets its surfaces.
export const MISSION_ID = "mission-1";

export const API = {
  missions: "/api/missions",
  stream: (id: string): string => `/api/missions/${id}/stream`,
  approve: (id: string): string => `/api/missions/${id}/approve`,
};

export interface StartRequest {
  goal: string;
}
export interface StartResponse {
  missionId: string;
}
export interface ApproveRequest {
  approved: boolean;
}

// Frames pushed to the client over the SSE stream.
// - "snapshot": a serializeProjections(...) string for the mission+telemetry
//   surfaces, sent once on connect so a (re)joining client seeds instantly.
// - "patch": a single A2UI_PATCH EventEnvelope to fold into the client's
//   projection runtime for a granular, near-real-time update.
export type ServerFrame =
  | { kind: "snapshot"; snapshot: string }
  | { kind: "patch"; envelope: EventEnvelope };
