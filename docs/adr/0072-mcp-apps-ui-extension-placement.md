# ADR 0072 — MCP Apps (SEP-1865): ingress fidelity now, `ui://` egress gated on an MCP server

- Status: **Draft** (2026-08-08)
- Date: 2026-08-08
- Evaluates: [MCP Apps placement evaluation](../requirements/2026-08-08-mcp-apps-extension-evaluation.md)
- Builds on: the A2UI egress adapter ([ADR 0069](0069-a2ui-egress-adapter.md)),
  `callFunction` bidirectional RPC ([ADR 0070](0070-a2ui-callfunction-bidirectional-rpc.md)),
  MCP dynamic dispatch ([ADR 0063](0063-mcp-dynamic-dispatch.md)),
  the content-store seam ([ADR 0046](0046-content-store-seam-thin-authoritative-log.md)),
  typed failure channels ([ADR 0060](0060-typed-failure-channels.md)),
  plugin packaging & 1P/3P separation ([ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md)),
  the deferred-evidence-gate discipline ([ADR 0065](0065-group-commit-deferred-evidence-gate.md)).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged
  (1.1.0); EVENT_SCHEMA unchanged** — no new syscall, no new kernel event type, no fold
  change. Everything below is a wire binding, a read-model, or a content-store artifact.

## Context

MCP gained an extension for interactive UI: **MCP Apps**, extension identifier
`io.modelcontextprotocol/ui`, specification dated **2026-01-26**. A server publishes a
static HTML resource under the `ui://` scheme (`text/html;profile=mcp-app`), links it from
a tool via `_meta.ui.resourceUri`, and a host renders it in a sandboxed iframe bridged by
JSON-RPC over `postMessage`. Tool arguments and results reach the view as host→view
notifications (`ui/notifications/tool-input`, `-partial`, `-result`, `-cancelled`); the
view calls back with `tools/call`, `resources/read`, `ui/open-link`, `ui/message`,
`ui/request-display-mode`, `ui/update-model-context`.

It is an **official extension, not core spec**, and the 2026-07-28 release candidate then
restructured the protocol underneath it — stateless operation, `initialize` and
`Mcp-Session-Id` removed, Tasks demoted from core to extension. Churn is live.

Four properties of the extension decide the design (full derivation in the evaluation §0):

- **P-A** the template is static and pre-declared — pre-declaration *is* the security model;
- **P-B** there is **no server push** after `ui/notifications/tool-result`;
- **P-C** views are stateless and lifecycle-bound to a single tool call;
- **P-D** it ships **code**, where A2UI deliberately ships none.

## Decisions

### D1 — Nothing enters the kernel

Every element maps onto machinery that already shipped:

| Element | Existing mechanism |
|---|---|
| static `ui://` template | `@loom/plugin-content` — `contentAddress`, `ContentStore`, `pinByEventKinds` (ADR 0046/0059) |
| template pin + drift detection | the ADR 0063 discipline — hash, pin at plan time, verify at serve time, fail typed via an ADR 0060 channel (`templateDrift`) |
| tool input / result | existing `STEP_STARTED` / `STEP_COMPLETED` payloads |
| view→agent calls | the two grains of ADR 0070 — suspend/resume gate, or delegated effect with deterministic `callId` |
| dispatch/usage indexing | domain events the fold skips (the ADR 0063 D4 precedent) |
| surface patch cursor | `readRangeOf` / `EventStore.readRange` (`packages/event-runtime`), read-model shape of `@loom/live-query` |

**KERNEL_ABI stays 1.1.0; EVENT_SCHEMA unchanged.** No `MCP_APP_*` event family — governed
event types are for kernel semantics, not wire bindings.

### D2 — Reject the host role in this repo

loom does **not** implement an MCP Apps host: sandboxed iframe construction, CSP synthesis
from `_meta.ui.csp`, permissions policy, the recommended double-iframe sandbox proxy,
theming, display-mode negotiation, container dimensions. That is a browser-application
concern in which a mistake is an XSS or exfiltration hole, and loom-the-kernel has no
browser. It belongs to the embedding application or `plugins/renderer-react`; packaged, it
is **3P** in `../loom-plugins` (ADR 0043).

### D3 — Fix MCP ingress fidelity now, unconditionally

Two defects in `plugins/mcp/src/McpClient.ts` block every path below and are worth fixing
on their own merits:

- **D3a** — `callTool` (lines 111–119) filters content to `type === "text"`, joins, and
  `JSON.parse`s it, **discarding `structuredContent`, `_meta`, and all non-text content
  blocks**. The declared response type is the corroborating evidence: line 106 types the
  RPC result as `{ content: Array<{ type: string; text?: string }> }` — there is no slot
  for `structuredContent` or `_meta` to survive in. `_meta.ui` is the field that links a
  tool to its UI resource;
  `structuredContent` is what a host forwards to a view. As written, a UI-bearing result is
  flattened to a string before loom can observe that a UI exists. The defect is broader
  than UI: any structured or image content from any MCP server is already silently lossy.
- **D3b** — `connect()` pins `protocolVersion: "2024-11-05"` (line 82) and threads
  `mcp-session-id` (lines 50, 65, 127), both removed by the stateless RC. **Not broken
  today** — the new Active → Deprecated → Removed policy guarantees a twelve-month window —
  but it is accrued drift with a known deadline.

Neither needs its own ADR. Ingress then gains **UI-resource awareness**: carry the resource
URI and content hash through the log with provenance so an application *can* render.
Carry, do not render.

### D4 — If and when loom serves: one static template, not generated HTML

**Rejected: per-flow HTML generation.** It breaks replay determinism (the UI becomes code
outside the log, and two replays of one execution may render differently with nothing
detecting it), defeats the extension's own pre-declaration security model (P-A), is not
auditable, and turns loom into a browser codegen system — an adjacent form of what ADR 0044
already declined.

**Accepted: one generic, content-pinned surface-host template.** A single static HTML app
serves as the `ui://` resource; its only job is to render a declarative payload delivered
as `structuredContent` and route user actions back as `tools/call`.

This neutralizes P-D rather than accommodating it: **MCP Apps becomes a second transport
binding for a surface protocol loom already ships, not a second UI protocol to maintain.**
No code is generated per app, so the "agent ships no code" property that made ADR 0069
clean is retained — the code is one fixed, versioned, reviewable build artifact.

The payload is the **existing A2UI catalog model**, unchanged: `A2UICatalog` +
`ComponentInstance` (`plugins/a2ui/src/catalog.ts`, `messages.ts`) — an adjacency-list
component tree from a named catalog (`loom.core.v1`), bound by JSON Pointer. The template
is a catalog renderer. The rendered UI is therefore a pure function of **(pinned template
hash, logged `structuredContent`)**, both of which are in the log.

### D5 — Close P-B with one app-visibility cursor tool

Because there is no server push, a long-running execution cannot stream surface patches
into a rendered view. The only seam the spec offers is repeatable view-initiated
`tools/call` plus `_meta.ui.visibility: ["app"]` (which the host must honour by excluding
the tool from the model's tool list).

Expose exactly one such tool — `loom.surface.since(surfaceId, fromSeq)` — returning
`SURFACE_PATCH` events after a sequence number, over `readRangeOf` /
`EventStore.readRange`. No new event type, no fold change, no syscall.

This is polling, and it is strictly worse than SSE. That is the extension's limitation,
not loom's; it is contained behind one tool, and if a future revision adds server push the
same cursor becomes the push source with no change to the payload contract. Recorded here
rather than engineered around.

**P-C requires no work** — it is the favourable direction of the mismatch. loom's execution
is the durable party and the view is disposable, so a re-rendered view re-reads the cursor
from 0 or from a snapshot. This is the late-joining-client handshake
`A2UISurfaceBridge.snapshot()` already implements.

### D6 — Security posture, fixed now rather than retrofitted

- **Egress redaction is mandatory, not defaulted.** Surface state shipped as
  `structuredContent` crosses the trust boundary. `A2UISurfaceBridge` already models this
  correctly (K10-R6 `maskPaths`, with the internal fold keeping true values so
  `increment`/`append`/`merge` stay correct). A `redact` list that defaults to empty is a
  silent leak; it is **required by configuration**.
- **A view-initiated `tools/call` is an authorization event, not a continuation.** The
  caller is the user's UI, not the flow. It runs under a **distinct principal with its own
  grants** and never inherits the execution's authority — `@loom/capability`
  (`CapabilityInvokeAuthorizer`), execution-authz (ADR 0039), and the K2 GrantTable /
  `EFFECT_DENIED` path already model exactly this.
- **`ui/update-model-context` is a prompt-injection surface** — untrusted view content
  overwriting the agent's context for future turns, with overwrite semantics. If loom ever
  ingests it, the content is **tainted by classification** (`@loom/classify`) and never
  merged into a system prompt. Cheap now, impossible to retrofit onto an immutable log —
  the argument ADR 0063 D3 made about principals.
- **`visibility` is enforced server-side.** The spec obliges hosts to reject app-originated
  calls to tools lacking `"app"`; a serving loom enforces the mirror, or the D5 cursor
  becomes a bypass around the model's tool boundary.
- **The view's result is untrusted input** — validated against its declared schema before
  acting on anything sensitive, exactly as ADR 0070 already records for `functionResponse`.

### D7 — The server is the prerequisite, and it is the gate

**loom has no MCP server.** `@loom/plugin-mcp` is client-only: `tools/list`
(`McpClient.ts:89`) and `tools/call` (`McpClient.ts:107`) outbound, with no inbound
counterpart anywhere in the repo. loom speaks A2A as a server (`plugins/a2a/src/A2AServer.ts`)
and nothing else.

So D4/D5/D6 are **deferred behind an evidence gate**: a concrete consumer, per the standing
second-consumer discipline (ADR 0065; and the gate ADR 0069 set for `callFunction`, which
ADR 0070 later *satisfied* rather than assumed). The extension is seven months old and the
RC just restructured the protocol underneath it — promoting on speculation is what the
deferral discipline exists to prevent.

When the gate is met, the work lands as a **1P plugin** (ADR 0043: an adapter that exists
because of a specific external system is a plugin), keeping the churn blast radius at the
edge — the same bet ADR 0069 made on A2UI.

## Consequences

- **Steps 0–1 (D3) proceed immediately** and are independently valuable: they fix live
  lossy-flattening of structured MCP tool results, whether or not any UI work follows.
- **The kernel is untouched** on every path — zero syscalls, zero event types, zero fold
  changes. The MCP Apps surface is a wire binding plus a read-model plus a content-store
  artifact, which is the whole point of the P10 verdict.
- **`@loom/plugin-a2ui`'s catalog becomes load-bearing twice.** The component/catalog
  vocabulary shipped for A2UI is reused verbatim as the MCP Apps payload, so the two
  bindings share one declarative surface model rather than diverging. A future third
  binding inherits it.
- **The cost is honestly attributed.** The stated request ("support MCP Apps") and the
  actual work ("be an MCP server") differ by roughly a factor of five and rest on different
  justifications. The UI extension is genuinely cheap — one static template, one cursor
  tool, and a payload contract already shipped. The server it must attach to is not, and
  that decision is made on its own merits rather than smuggled in behind a UI feature.
- **If the project declines to own an MCP server, the correct outcome is Steps 0–1 and
  stop.** A UI extension with no server to attach it to is not a deliverable, and building
  the UI half first inverts the dependency for no gain.

## Notes on what was rejected and why it mattered

P-D ("it ships code") looked like the fatal objection — it is the exact property whose
absence made the A2UI adapter clean — and proved the cheapest to neutralize: one static
catalog-renderer template converts a code-shipping protocol into a data-shipping one (D4).

The objection that survives is **P-B**, and it survives as polling (D5). That is a real,
permanent cost of the current extension revision, recorded rather than designed around, and
the reason this ADR gates rather than accepts.
