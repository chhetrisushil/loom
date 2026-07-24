// ── A2UI protocol v1.0 wire messages ──────────────────────────────────────────
//
// The subset of the Google A2UI (Agent-to-UI) protocol this adapter
// speaks. A2UI is a *component-tree + data-model* protocol: the agent describes a
// UI declaratively (components drawn from a catalog, bound to a data model by
// JSON Pointer) and any compliant client renders it — no code is ever shipped.
//
// Every message is a discriminated union keyed by exactly one message type,
// carrying the protocol `version`:  { version: "v1.0", updateDataModel: {…} }.
//
// This adapter EMITS the egress subset — `createSurface`, `updateDataModel`,
// `deleteSurface` (and the `updateComponents` type is defined for completeness)
// — and INGESTS the client `action` plus the `callFunction` request/response
// leg: the agent asks the client to invoke a named catalog function and the
// client answers with a `functionResponse`. This is reconciled with Loom's
// append-only, replayable grain NOT as a blocking sync RPC in the log, but by
// carrying a *deterministic* `callId` (`executionId:stepId`) and letting the
// result re-enter as an ordinary recorded fact (a resume event, or a
// `STEP_COMPLETED` output) — see ADR 0070. Only the "rich" two-way *binding
// sync* (continuous data-model reconciliation) remains out of scope.

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

/**
 * Ask the client to invoke a named catalog function and answer with a
 * `functionResponse` carrying the same `callId`. The `callId` MUST be a
 * deterministic function of the calling step (e.g. `executionId:stepId`) so a
 * crash-recovered re-issue reuses it and the client can dedup — this is the K9
 * effect-delivery contract (idempotency key + at-least-once) projected onto the
 * A2UI transport. See ADR 0070.
 */
export interface CallFunctionPayload {
  surfaceId: string;
  /** Deterministic correlation/idempotency key (never random). */
  callId: string;
  /** The catalog function name to invoke on the client. */
  name: string;
  /** Arguments passed to the client function. */
  args?: unknown;
  /** Catalog `callableFrom` boundary the request originates within, if scoped. */
  callableFrom?: string;
}

export type A2UIServerMessage =
  | { version: string; createSurface: CreateSurfacePayload }
  | { version: string; updateComponents: UpdateComponentsPayload }
  | { version: string; updateDataModel: UpdateDataModelPayload }
  | { version: string; deleteSurface: DeleteSurfacePayload }
  | { version: string; callFunction: CallFunctionPayload };

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

/**
 * The client's answer to a `callFunction` request. Echoes the request's
 * `callId` for correlation and carries exactly one of `result` (success) or
 * `error` (the client function threw / was refused). The caller maps this to a
 * resume event (grain A) or resolves an awaiting effect (grain B).
 */
export interface FunctionResponsePayload {
  surfaceId: string;
  /** The `callId` of the `callFunction` request this answers. */
  callId: string;
  /** The function name that was invoked (mirrors the request). */
  name: string;
  /** The client function's return value, present on success. */
  result?: unknown;
  /** Present when the client function failed or was refused. */
  error?: unknown;
}

export type A2UIClientMessage =
  | { version: string; action: ActionPayload }
  | { version: string; functionResponse: FunctionResponsePayload }
  | { version: string; error: unknown };

// ── Narrowing helpers ──────────────────────────────────────────────────────────

export function isAction(
  msg: A2UIClientMessage
): msg is { version: string; action: ActionPayload } {
  return typeof msg === "object" && msg !== null && "action" in msg;
}

export function isFunctionResponse(
  msg: A2UIClientMessage
): msg is { version: string; functionResponse: FunctionResponsePayload } {
  return typeof msg === "object" && msg !== null && "functionResponse" in msg;
}
