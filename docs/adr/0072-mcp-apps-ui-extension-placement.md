# ADR 0072 — MCP Apps (SEP-1865): ingress fidelity now, `ui://` egress gated on an MCP server

- Status: **Accepted — implemented** (2026-08-08). The D7 evidence gate was closed by explicit
  direction to build the server; Steps 0–2 shipped together with the effect-mode boundary
  ([ADR 0073](0073-effect-mode-journaled-vs-ambient.md)) that D5's cursor tool depends on.
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

It is an **official extension, not core spec**, and the 2026-07-28 revision then restructured
the protocol underneath it — stateless operation, `initialize` and `Mcp-Session-Id` removed,
Tasks demoted from core to extension. Churn is live.

> **Correction (2026-08-08, during implementation).** This ADR and its evaluation both describe
> 2026-07-28 as a *release candidate*, which was true of the announcement post. The
> specification's versioning page now lists **2026-07-28 as Current**. Two refinements follow,
> neither of which changes a verdict: version negotiation is per-request
> (`_meta["io.modelcontextprotocol/protocolVersion"]` plus the `MCP-Protocol-Version` header on
> Streamable HTTP) rather than handshake-only, and the last handshake-based revision is
> `2025-11-25`. D3b is implemented against that reality.

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

## Implementation record (2026-08-08)

Shipped as specified, with three findings worth recording because two of them changed the code
and one changed the shape of D5.

**A fourth ingress defect, found while implementing D3a.** `callTool` also ignored `isError`.
MCP reports tool failures *in band* — a successful JSON-RPC response carrying `isError: true` —
so the old client returned a failure's text as if it were a value, and every MCP tool error
became a plausible-looking success. `callTool` now throws; `callToolResult` exposes the flag
for callers that branch.

**D5 needed ADR 0073 to be correct rather than conventional.** The cursor tool is declared
`mode: "ambient"`, and that declaration is what lets a serving surface route it — without it,
`createMcpServer` would need a hardcoded list of "tools that must not be journaled", which is
the hand-wiring the declaration exists to remove. The journaled/ambient boundary also became the
server's app-call rule: an app-originated call to a `journaled` tool is **denied by default**
(`authorizeAppJournaledCall`), which is D6's "distinct principal" requirement in its enforceable
form.

**One pin, one hashing implementation.** The first cut hashed the template with a bare
`fnv1a64` on the egress side while ingress hashed with a `text:`-tagged scheme — so a pin
captured at plan time did not equal what a reader recomputed, and the pin silently stopped
detecting drift. Caught by a round-trip test, fixed by having `surfaceHostPin` delegate to the
ingress side's `hashResourceBody`. This is ADR 0063 D1's warning arriving on schedule: "two
canonicalizations that mostly agree is how registry-driven repair becomes unreliable."

**Audience has no in-band signal.** The extension puts visibility enforcement on the *host*,
which is the only party that knows whether a `tools/call` came from the model or a View. A
server therefore cannot derive audience from the request alone, so `audienceOf` is
deployment-supplied (a distinct path, port, or credential) and defaults to `"model"` — absent an
explicit boundary, app-only tools stay unreachable rather than silently open. An
audience-invisible tool is reported as *unknown* rather than forbidden, since a "you may not
call that" reply confirms the tool exists.

Delivered: `McpServer` + `servedEffect` in `@loom/plugin-mcp`; `@loom/plugin-mcp-app` with the
static template, its pin, the payload builder, and the cursor tool. Spec capabilities
`mcp-server`, `mcp-apps-ui-egress`, `effect-mode-boundary` (L2). Workspace green — 70 build
tasks, 123 test tasks.

## Follow-up (2026-08-08) — completing D5, and decision provenance

The question "does a long-suspended resume need staleness checking?" exposed that **D5 was only
half-built**, and the honest answer to the question itself is *no new kernel support*.

**What the kernel already refuses.** `resume()` is stricter than it looks: K11 resolves the flow
*code* (current, pinned-by-hash, migrated, or loud refusal), K11.5 resumes with the recorded
migrated `_input`, K12.2 rejects a forged approval, K8.2 keeps cancel terminal. Stale *code*,
*input shape*, and *authority* are covered. Nothing was added.

**What it structurally cannot know.** The execution knows the sequence at which **it** suspended.
It does not know the sequence **the human was looking at**. Across a gate held open for days
while the surface keeps advancing those are different numbers, and only the second says whether
the decision was informed. That is a provenance gap, not a kernel gap.

**Resolution — evidence, not policy.** The View echoes `seenSequence` (the cursor it had folded)
on every action; `isStale(action, currentSequence, tolerance?)` is the predicate. Whether a given
lag *invalidates* a decision is domain-specific, so the framework deliberately supplies the
number and stops. The natural way to act on it is an ADR 0060 typed channel (`staleDecision`),
making staleness a recorded, replay-substituted, branchable outcome rather than an exception.
Absent provenance counts as **stale**: an action with no `seenSequence` is indistinguishable from
one made against arbitrarily old data, and defaulting unknown to "fresh" would make the check
vacuous for exactly the clients that need it most.

**Two defects in the original Step 2, now fixed.**

1. *The template never polled.* It rendered once from `ui/notifications/tool-result` and never
   called `loom.surface.since` at all. The cursor tool was built and tested server-side and D5's
   claim was true of the server — but the client half was missing, so the gap D5 exists to close
   was not actually closed end to end. The View now polls its own cursor and stops on teardown.
2. *The template discarded `sequence`.* `adopt()` read `components`/`dataModel`/`surfaceId` and
   dropped the rest, so the provenance the payload already carried was thrown away.

**A correctness fix to the cursor's contract.** The first cut folded from `fromSequence` and left
the View to merge. That is wrong: a tail fold produces a partial state that only *looks* like a
state — a nested patch yields `{a:{b:1}}`, which a shallow merge splices over the whole of `a`,
and a `remove` op is indistinguishable from a key the tail simply never touched. The cursor now
returns either `{ changed: false }` or a **complete** model. The cheap tail read is kept purely
for change *detection*, so the common no-change poll stays cheap while every payload that does
come back is authoritative.

## Notes on what was rejected and why it mattered

P-D ("it ships code") looked like the fatal objection — it is the exact property whose
absence made the A2UI adapter clean — and proved the cheapest to neutralize: one static
catalog-renderer template converts a code-shipping protocol into a data-shipping one (D4).

The objection that survives is **P-B**, and it survives as polling (D5). That is a real,
permanent cost of the current extension revision, recorded rather than designed around, and
the reason this ADR gates rather than accepts.
