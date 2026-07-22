// ── A2UI protocol v1.0 wire messages ──────────────────────────────────────────
//
// The subset of the Google A2UI (Agent-to-UI) protocol this egress adapter
// speaks. A2UI is a *component-tree + data-model* protocol: the agent describes a
// UI declaratively (components drawn from a catalog, bound to a data model by
// JSON Pointer) and any compliant client renders it — no code is ever shipped.
//
// Every message is a discriminated union keyed by exactly one message type,
// carrying the protocol `version`:  { version: "v1.0", updateDataModel: {…} }.
//
// This adapter EMITS the egress subset — `createSurface`, `updateDataModel`,
// `deleteSurface` (and the `updateComponents` type is defined for completeness)
// — and INGESTS the client `action`. The bidirectional-RPC surface
// (`callFunction` / `actionResponse` / two-way binding sync) is deliberately out
// of scope: it fights Loom's append-only, replayable event grain. See the plugin
// README / ADR for that decision.

export const A2UI_VERSION = "v1.0";

// ── Components ─────────────────────────────────────────────────────────────────

// A single node in the A2UI adjacency-list component tree. Relationships are by
// ID reference (`child` / `children`), never nesting; exactly one node must have
// `id: "root"`. Type-specific props (e.g. a Text's `text`) sit alongside `id` and
// `component`; a prop may be a literal or a data binding (`{ path }`).
export interface ComponentInstance {
  id: string;
  component: string;
  [prop: string]: unknown;
}

// ── Server → client messages ───────────────────────────────────────────────────

export interface CreateSurfacePayload {
  surfaceId: string;
  catalogId: string;
  components?: ComponentInstance[];
  /** Initial data model (the client binds components into this by JSON Pointer). */
  dataModel?: unknown;
  /** Catalog-defined surface metadata (e.g. agentDisplayName). */
  surfaceProperties?: Record<string, unknown>;
}

export interface UpdateComponentsPayload {
  surfaceId: string;
  components: ComponentInstance[];
}

export interface UpdateDataModelPayload {
  surfaceId: string;
  /** RFC 6901 JSON Pointer; "" addresses the whole data model. */
  path: string;
  /** New value at `path`. `null` removes the key (A2UI upsert semantics). */
  contents: unknown;
}

export interface DeleteSurfacePayload {
  surfaceId: string;
}

export type A2UIServerMessage =
  | { version: string; createSurface: CreateSurfacePayload }
  | { version: string; updateComponents: UpdateComponentsPayload }
  | { version: string; updateDataModel: UpdateDataModelPayload }
  | { version: string; deleteSurface: DeleteSurfacePayload };

// ── Client → server messages ───────────────────────────────────────────────────

export interface ActionPayload {
  surfaceId: string;
  /** The action name declared on the component the user activated. */
  action: string;
  /** Optional data-model snapshot the client attaches (A2UI `sendDataModel`). */
  dataModel?: unknown;
  /** Optional per-action context (e.g. the row a list button was pressed in). */
  context?: Record<string, unknown>;
}

export type A2UIClientMessage =
  | { version: string; action: ActionPayload }
  | { version: string; functionResponse: unknown }
  | { version: string; error: unknown };

// ── Narrowing helpers ──────────────────────────────────────────────────────────

export function isAction(
  msg: A2UIClientMessage
): msg is { version: string; action: ActionPayload } {
  return typeof msg === "object" && msg !== null && "action" in msg;
}
