# ADR 0069 — Agent-surface rename + A2UI egress adapter

- Status: Accepted (2026-07-22)
- Date: 2026-07-22
- Builds on: plugin packaging & 1P/3P separation ([ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md)),
  K10-R6 egress redaction (`@loom/classify` `maskPaths`).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA unchanged** — the adapter is a read-side projection + wire binding; it introduces no new
  kernel event type.

## Context

The `@loom/a2ui` package was named for the Google **A2UI (Agent-to-UI) protocol** but did not implement
it. It was a homegrown, event-sourced *data-model patch* protocol (`A2UI_PATCH` events carrying
`set`/`merge`/`append`/`remove`/`increment` deltas addressed by dot-path). That is a fine, Loom-native
mechanism — but it diverges from A2UI on every structural axis: A2UI is a component-tree + data-model
protocol with a component **catalog** (JSON Schema), **JSON-Pointer** bindings, a message envelope
(`createSurface`/`updateComponents`/`updateDataModel`/`deleteSurface`), and a **bidirectional** RPC
surface (`callFunction`/`actionResponse`, two-way input binding). A2UI explicitly has *no* patch/delta
framework — `updateDataModel` replaces the value at a path.

Keeping the `a2ui` name on the homegrown protocol was a naming claim we didn't honor, and it blocked
building a genuine adapter under that name.

## Decision

Two changes:

1. **Rename** `@loom/a2ui` → `@loom/agent-surface` (package, public symbols, and the `SURFACE_PATCH`
   event type; `defineConfig` flag `a2ui` → `agentSurface`). This is Loom's native surface mechanism and
   keeps its event-sourced, replayable design unchanged.

2. **Add `@loom/plugin-a2ui`** — a real, spec-aligned A2UI **egress** adapter, as a **1P plugin**
   (composition-time contributor, kernel untouched). It projects a Loom agent surface onto the A2UI wire
   protocol v1.0 so any A2UI-compliant client can render a Loom-driven UI.

### Scope: egress + inbound actions only

The adapter's `A2UISurfaceBridge` (one instance per execution's surface):

- emits `createSurface` (component tree + catalog + initial data model), `updateDataModel`, and
  `deleteSurface`;
- **translates Loom's delta ops into A2UI's absolute value-replacement** — it folds the surface locally
  (reusing `@loom/agent-surface`'s `applySurfacePatches`) and emits the concrete post-patch value at each
  touched JSON Pointer. `remove` → `contents: null` (A2UI upsert-to-null). *This is the one real
  impedance point, and it is resolved here, in the adapter, not in the kernel.*
- applies **K10-R6 egress redaction** on the way out (internal fold keeps true values so
  `increment`/`append`/`merge` stay correct);
- ingests the client `action` message, normalized for the caller to turn into a Loom inbound event.

Ships one curated default **catalog** (`Text`/`Column`/`Row`/`List`/`Badge`/`Button`) plus `defineCatalog`
for BYO. A catalog is mandatory in A2UI (`createSurface` names a `catalogId`), so this is not optional.

### Deferred (rejected for the MVP)

The A2UI **bidirectional RPC** surface — `callFunction`-with-response, `actionResponse`,
two-way-binding sync — and the rich catalog half (client `functions`, validation `checks`,
`callableFrom`). These require a synchronous request/response correlation layer that fights Loom's
append-only, replayable event grain. They are edge-of-system concerns; promote only when a concrete
consumer needs them (the "second consumer" evidence gate).

> **Update:** `callFunction`/`functionResponse` and the catalog `functions` vocabulary were promoted in
> [ADR 0070](0070-a2ui-callfunction-bidirectional-rpc.md) once that gate was met — reconciled with the
> replay grain by the client's *result* re-entering as a recorded fact (not a sync RPC in the log), keyed
> by a deterministic `callId`. Continuous two-way binding sync remains out of scope.

## Consequences

- The adapter is **transport-agnostic**: it produces/consumes A2UI *messages*, so any binding (the app's
  SSE broadcaster, WebSocket, A2A/MCP) can carry them; testable fully offline.
- A2UI is young (v1.0, Dec 2025). Housing it in a swappable, versioned plugin — not the kernel — keeps the
  churn blast radius at the edge.
- Loom keeps **one** internal UI protocol (`agent-surface`); A2UI is purely an optional egress projection.

## Rollout (addendum, 2026-07-22)

The decision above shipped in full and was rolled out across the ecosystem:

- **Playground** — the `apps/playground` event stream ("SSE broadcaster") is now wired through an
  `A2UISurfaceBridge`; a live **A2UI** tab shows the emitted wire messages beside the native surface
  patches, and the **Approve** button routes through `ingestAction` (the inbound leg), demonstrating the
  full round-trip end-to-end.
- **Documentation** — the living guides (`api-reference`, `user-guide`, `architecture`, `usage`,
  `data-classification`, …) were updated: native-protocol references renamed to `agent-surface`
  (`SURFACE_PATCH`, `SurfaceEmitter`, `agentSurfaceProjection`, config flag `agentSurface`), and a new
  `@loom/plugin-a2ui` API section plus a "how to use" walkthrough were added. Historical records (ADRs,
  requirements, presentation decks) were intentionally left unchanged as point-in-time artifacts.
- **Downstream repos** — `@loom/a2ui` → `@loom/agent-surface` was migrated in the sibling repos that
  consumed it (`genUI`, `aetherOS`, `loom-examples`), each as its own PR (typecheck/tests green). Their
  own local naming (e.g. genUI's `surface/a2ui.ts`, the `a2ui-dashboard` example folder) was kept — only
  the broken package/symbol references were migrated.
