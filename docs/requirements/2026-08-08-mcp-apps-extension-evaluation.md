# MCP Apps (SEP-1865) — Placement Evaluation

- Date: 2026-08-08
- Status: **Evaluation complete → verdicts recorded in
  [ADR 0072](../adr/0072-mcp-apps-ui-extension-placement.md)**
- Method: the ADR 0051 discipline — a placement verdict (kernel / 1P plugin / 3P plugin /
  reject) per item, judged against the best existing loom mechanism, bias outward (P10).
  Every protocol claim below was read out of the dated specification, not recalled; every
  repo claim carries a file:line.
- Anchors: the A2UI egress adapter ([ADR 0069](../adr/0069-a2ui-egress-adapter.md)),
  `callFunction` bidirectional RPC ([ADR 0070](../adr/0070-a2ui-callfunction-bidirectional-rpc.md)),
  MCP dynamic dispatch ([ADR 0063](../adr/0063-mcp-dynamic-dispatch.md)),
  the content-store seam ([ADR 0046](../adr/0046-content-store-seam-thin-authoritative-log.md)),
  plugin packaging ([ADR 0043](../adr/0043-plugin-packaging-and-1p-3p-separation.md)),
  typed failure channels ([ADR 0060](../adr/0060-typed-failure-channels.md)).

## The question

MCP added an extension for interactive UI. Should loom support it, where does that support
live, and in what shape?

## 0. What the extension actually is

Read from the extension specification dated **2026-01-26**
(`modelcontextprotocol/ext-apps`, `specification/2026-01-26/apps.mdx`) and the
**2026-07-28** protocol release candidate. Stated plainly because four of its properties
decide the whole design:

- A server publishes a **static HTML resource** under the `ui://` scheme with MIME type
  `text/html;profile=mcp-app`, and links it from a tool via `_meta.ui.resourceUri`. The
  host fetches it, renders it in a sandboxed iframe, and bridges JSON-RPC over
  `postMessage`. Extension identifier: `io.modelcontextprotocol/ui`.
- **Pre-declaration is the security model.** Templates are declared ahead of tool
  execution precisely so hosts can prefetch, cache, and security-review them before
  anything runs. The host builds the iframe CSP from `_meta.ui.csp`
  (`connectDomains` / `resourceDomains` / `frameDomains` / `baseUriDomains`), defaulting
  to `default-src 'none'` when omitted, and **may further restrict but must not admit
  undeclared domains**.
- **Data flows to the view as host→view notifications**: `ui/notifications/tool-input`
  (once, complete arguments), `ui/notifications/tool-input-partial` (0..n, streaming),
  `ui/notifications/tool-result` (the standard `CallToolResult` — `content`,
  `structuredContent`, `_meta`), `ui/notifications/tool-cancelled`.
- **The view may call back**: `tools/call`, `resources/read`, plus `ui/open-link`,
  `ui/message`, `ui/request-display-mode`, `ui/update-model-context`. Tools carry
  `_meta.ui.visibility: Array<"model" | "app">`; the host **must reject** `tools/call`
  from an app for a tool lacking `"app"`.

### The four properties that constrain us

| Property | Evidence | Consequence for loom |
|---|---|---|
| **P-A. The template is static and pre-declared** | `ui://` resource read via `resources/read`; hosts prefetch/review before execution | Favourable. A fixed artifact is content-addressable and pinnable — exactly what ADR 0046 and `jsonSchemaHash` already handle. |
| **P-B. No server push after `tool-result`** | Spec provides no streaming, subscription, or repeated-result mechanism; the host sends `tool-result` when execution completes, and that is the end of the server→view channel | **The central impedance mismatch.** loom's agent-surface is a *streaming patch log*. |
| **P-C. Views are stateless and lifecycle-bound to one tool call** | No persistence/session/restoration in the spec; created during tool invocation, destroyed after `ui/resource-teardown` | loom executions are long-lived, suspendable, resumable, branchable. The view is the *short-lived* party. |
| **P-D. It ships code** | HTML+JS in the resource body | Cuts directly against the property that made ADR 0069 clean: A2UI ships **no** code. |

P-B and P-D are the two that must be *designed around*, not merely noted. Note that
P-B/P-D are a **different** mismatch from the one ADR 0069 solved (delta-vs-absolute
value semantics); nothing from that adapter carries over for free.

### Standardization status — churn is live, not hypothetical

MCP Apps is an **official extension, not core spec**, seven months old at the time of
writing. The 2026-07-28 release candidate then restructured the ground underneath it:
the protocol went **stateless** — `initialize` handshake and the `Mcp-Session-Id` header
both removed — and Tasks moved from experimental core feature to extension. A new
feature-lifecycle policy (Active → Deprecated → Removed, twelve-month minimum windows)
now governs that evolution, which bounds the blast radius but confirms it is ongoing.

This is the exact risk profile ADR 0069 priced in for A2UI ("A2UI is young (v1.0, Dec
2025). Housing it in a swappable, versioned plugin — not the kernel — keeps the churn
blast radius at the edge"). The same bet applies, with more force.

## 1. The two directions are not symmetric

"Support MCP Apps" conflates two roles with opposite economics. They must be judged
separately.

### Direction A — loom as MCP Apps **server** (producer)

loom exposes its own flows as MCP tools whose results carry a `ui://` app, so Claude,
ChatGPT, VS Code, and any other MCP host render a loom-driven UI. This is the A2A-server
story (`plugins/a2a/src/A2AServer.ts`) told for a much larger ecosystem, and it is where
essentially all the value sits.

**It is blocked on a prerequisite nobody has named: loom has no MCP server.**
`@loom/plugin-mcp` is client-only — `McpClient` issues `tools/list`
(`plugins/mcp/src/McpClient.ts:89`) and `tools/call`
(`plugins/mcp/src/McpClient.ts:107`) outbound, and there is no inbound counterpart
anywhere in the repo. loom speaks A2A as a server and nothing else.

So the honest framing of Direction A is: **become an MCP server, then add a thin UI
layer.** MCP Apps is perhaps a fifth of that work. The server is justifiable on its own
merits; the UI extension rides along. Judging "should we support MCP Apps" without
surfacing this understates the cost by an order of magnitude and misattributes the value.

### Direction B — loom as MCP Apps **host** (consumer)

A loom flow calls a third-party MCP tool that returns a UI app, and something renders it.

The host role is: sandboxed iframe construction, CSP synthesis from `_meta.ui.csp`,
permissions policy (`camera`/`microphone`/`geolocation`/`clipboardWrite`), the
recommended double-iframe sandbox-proxy architecture, theming via CSS custom properties,
display-mode negotiation (`inline`/`fullscreen`/`pip`), and container-dimension
management. That is a browser-application concern in which a mistake is an XSS or
exfiltration hole — and loom-the-kernel has no browser.

**Verdict: reject the host role in this repo.** It belongs to the embedding application
or `plugins/renderer-react`; if someone wants it packaged, it is 3P in `../loom-plugins`
(ADR 0043).

But a much smaller piece of Direction B *is* loom's job and is worth doing on its own
merits — see §2.

## 2. Two ingress defects block any UI work, and are worth fixing regardless

Both are in `plugins/mcp/src/McpClient.ts`.

**D1 — `callTool` destroys the payload MCP Apps depends on.** Lines 111–119 filter
content to `type === "text"`, join the text, and `JSON.parse` it. This **discards
`structuredContent`, `_meta`, and every non-text content block** — and the declared
response type confirms it is by construction, not oversight: line 106 types the RPC
result as `{ content: Array<{ type: string; text?: string }> }`, leaving no slot for
`structuredContent` or `_meta` to survive in. `_meta.ui` is precisely
the field that links a tool to its UI resource, and `structuredContent` is precisely what
the host forwards to the view via `ui/notifications/tool-result`. As written, a
UI-bearing tool result is flattened into a string before loom ever sees that a UI exists.
No MCP Apps support of any kind is reachable through this method.

The defect is broader than UI: any MCP server returning structured or image content today
is already being silently lossy-flattened.

**D2 — the client is pinned to a superseded protocol version.** `connect()` sends
`protocolVersion: "2024-11-05"` (`McpClient.ts:82`) and threads `mcp-session-id`
(`McpClient.ts:50`, `:65`, `:127`) — both of which the 2026-07-28 stateless RC removes.
This is **not broken today**: the new feature-lifecycle policy guarantees a twelve-month
window, and servers will accept the old version throughout. It is accrued drift with a
known deadline, not an outage.

Neither defect needs an ADR. Both are prerequisites for anything below.

## 3. The design decision that matters: transport binding, not codegen

Given Direction A is eventually taken, there are two ways to produce the `ui://`
resource, and the choice is not close.

### Rejected — generate per-flow HTML

loom emits bespoke HTML/JS per app (per blueprint, per surface, per agent output). This
fails on four counts:

1. **Replay determinism.** The UI becomes *code* that lives outside the log. Two replays
   of one execution can render differently, and nothing detects it.
2. **It defeats the extension's own security model (P-A).** Templates exist to be
   pre-declared, prefetched, and reviewed. A template minted per execution can be none of
   those.
3. **Auditability.** Generated markup is not reviewable in the way a fixed artifact is.
4. **Scope.** It makes loom a browser codegen system, which it is not and which ADR 0044
   ("no compiler plugin API") already declined in an adjacent form.

### Accepted — one static, content-pinned surface-host template

Ship **one** generic HTML app as the `ui://` resource. Its only job: render a declarative
payload delivered as `structuredContent`, and route user actions back as `tools/call`.

This is the load-bearing insight, and it turns P-D from a problem into a non-issue:
**MCP Apps becomes a second transport binding for a surface protocol that already
shipped, not a second UI protocol to maintain.** No code is generated per app, so loom
retains the "the agent ships no code" property that made the A2UI adapter clean — the
code is one fixed, versioned, auditable build artifact.

Three consequences follow directly, each landing on machinery that already exists:

- **The A2UI catalog is the payload, unchanged.** `A2UICatalog` and `ComponentInstance`
  (`plugins/a2ui/src/catalog.ts`, `plugins/a2ui/src/messages.ts`) are already
  "declarative UI as data": an adjacency-list component tree drawn from a named catalog
  (`loom.core.v1`), bound to a data model by JSON Pointer. That is exactly what belongs
  in `structuredContent`. The template is a catalog renderer; the catalog work is reused
  wholesale rather than re-derived.
- **Pin the template exactly as ADR 0063 pins tool schemas.** Store the template in
  `@loom/plugin-content` (`contentAddress`, `ContentStore`, `pinByEventKinds`); hash it
  with `jsonSchemaHash`'s sibling discipline — pin at plan time, verify at serve time,
  fail typed (`templateDrift`) through an ADR 0060 channel. A replay that renders a
  *different* UI than the original run is a silent correctness bug; this is precisely the
  machinery that prevents it, and it is already built and tested.
- **Replay-safety becomes a property, not a hope.** The rendered UI is a pure function of
  (pinned template hash, logged `structuredContent`). Both halves are in the log.

## 4. Closing P-B: the streaming gap

Because there is no server push (P-B), a long-running loom execution cannot stream
surface patches into a rendered view. The only seam the spec offers is **view-initiated
`tools/call`, repeatable**, combined with `_meta.ui.visibility: ["app"]` to hide the tool
from the model's tool list.

**Proposal.** Expose a single app-visibility cursor tool —
`loom.surface.since(surfaceId, fromSeq)` — returning the `SURFACE_PATCH` events after a
sequence number. This maps directly onto `readRangeOf` / `EventStore.readRange`
(`packages/event-runtime`), and is the same read-model shape as `@loom/live-query`
(`snapshot` / `subscribe` over `loadState` + `EventStore.subscribe`). No new event type,
no fold change, no syscall.

The view polls a cursor over the durable log; loom hands back the patch stream it already
produces. It is strictly worse than SSE — that is the extension's limitation, not
loom's, and it is contained behind exactly one tool. If a future revision of the
extension adds server push, the same cursor becomes the push source with no change to the
payload contract.

**P-C (stateless, short-lived views) needs no work.** It is the favourable direction of
the mismatch: loom's execution is the durable party and the view is disposable, so a
re-rendered view simply re-reads the cursor from 0 or from a snapshot. This is the same
late-joining-client handshake `A2UISurfaceBridge.snapshot()` already implements
(`plugins/a2ui/src/A2UISurfaceBridge.ts`).

## 5. Security analysis — decide up front, not retrofitted

| # | Concern | Disposition |
|---|---|---|
| S1 | **Egress redaction.** Surface state shipped as `structuredContent` crosses the trust boundary. | Mandatory, not optional. `A2UISurfaceBridge` already models this correctly (K10-R6 `maskPaths`; internal fold keeps true values so `increment`/`append`/`merge` stay correct). Any MCP Apps bridge inherits it, and `redact` should be **required by configuration** rather than defaulting to empty — a default-empty redaction list is a silent leak. |
| S2 | **View-initiated `tools/call` is an authorization event, not a continuation.** The caller is the user's UI, not the flow. | It must run under a **distinct principal with its own grants**, never inheriting the execution's authority. `@loom/capability` (`CapabilityInvokeAuthorizer`), execution-authz (ADR 0039), and the K2 GrantTable / `EFFECT_DENIED` path already model exactly this. The mistake to avoid is letting the view borrow the flow's principal. |
| S3 | **`ui/update-model-context` is a prompt-injection surface.** It lets untrusted view content overwrite the agent's context for future turns, with overwrite semantics. | If loom ever ingests it, the content must be **tainted by classification** (`@loom/classify`) and never merged into a system prompt. Cheap to decide now and impossible to retrofit onto an immutable log — the same argument ADR 0063 D3 made about principals. |
| S4 | **`visibility` must be enforced server-side.** The spec obliges hosts to reject app-originated calls to tools lacking `"app"`. | If loom serves, it enforces the mirror. Otherwise the §4 polling seam becomes a bypass around the model's tool boundary — an app-visibility tool that any caller can reach is not a boundary. |
| S5 | **The view's `result` is untrusted input.** | Same rule ADR 0070 already recorded for `functionResponse`: validate against the declared schema before acting on anything sensitive. Nothing new is required; the discipline transfers. |

S1 and S4 are the two that are cheap now and expensive later, because both concern what
leaves the boundary and both would ship as defaults.

## 6. Verdict table

| Item | Verdict | Placement | Rationale |
|---|---|---|---|
| Kernel change of any kind | **reject** | — | Every element maps to shipped machinery: static template → content store (ADR 0046/0059); template pin/drift → `jsonSchemaHash` + typed channel (ADR 0063/0060); view→agent calls → the two grains of ADR 0070; dispatch indexing → domain events the fold skips (ADR 0063 D4); patch cursor → `readRange` + read-model. **KERNEL_ABI stays 1.1.0; EVENT_SCHEMA unchanged.** |
| New `MCP_APP_*` event types | **reject** | — | Domain events the fold skips, per the ADR 0063 D4 precedent. Governed event types are for kernel semantics. |
| MCP Apps **host** (iframe/CSP/postMessage) | **reject** | app layer, or 3P `../loom-plugins` | Browser-security concern; loom-the-kernel has no browser (§1 Direction B). |
| Per-flow HTML generation | **reject** | — | Breaks replay determinism and the extension's pre-declaration security model (§3). |
| Two-way binding sync | **reject** | — | Already out of scope for A2UI (ADR 0069/0070); MCP Apps does not even offer the push channel to implement it (P-B). |
| D1 — preserve `structuredContent` / `_meta` / non-text content | **accept, do now** | `@loom/plugin-mcp` | Prerequisite for everything; independently a live lossy-flattening defect (§2). |
| D2 — protocol-version drift | **accept, track** | `@loom/plugin-mcp` | Known twelve-month deadline, not an outage (§2). |
| Ingress UI-resource awareness (carry, don't render) | **accept** | `@loom/plugin-mcp` | Carry the resource URI + content hash with provenance so an app *can* render. |
| `ui://` egress + surface-host template | **accept, gated** | new 1P plugin | The real deliverable; gated on §7. |
| MCP **server** | **accept, gated** | 1P | The actual prerequisite and the actual value (§1 Direction A). |

**Net kernel growth: zero syscalls, zero event types, zero fold changes.**

## 7. Sequencing and the evidence gate

**Step 0 — fix `McpClient` (now, unconditional).** D1 and D2. Small, self-justifying, no
ADR needed, and no UI work is reachable without it.

**Step 1 — ingress awareness in `@loom/plugin-mcp`.** Carry a UI-bearing tool result
through the log with provenance (resource URI + content hash). Carry, do not render.

**Step 2 — MCP server + `ui://` egress, evidence-gated.** Gate on a concrete consumer,
per this repo's standing second-consumer discipline (ADR 0065, and the gate ADR 0069 set
for `callFunction` — which ADR 0070 later satisfied rather than assumed). The extension
is seven months old and the RC just restructured the protocol underneath it; promoting on
speculation is exactly what the deferral discipline exists to prevent.

### The caveat on this recommendation

Step 2's value is mostly the **MCP server**, not MCP Apps. If the project is not prepared
to own an MCP server, the correct answer is Steps 0–1 and wait — a UI extension with no
server to attach it to is not a deliverable, and building the UI half first would invert
the dependency for no gain.

## 8. Closing note

The instructive result here is that the *stated* request ("support MCP Apps") and the
*actual* work ("be an MCP server") differ by roughly a factor of five in cost and point at
different justifications. The UI extension itself is genuinely cheap — one static
template, one cursor tool, and a payload contract loom already ships in
`@loom/plugin-a2ui`. What is not cheap is the server it must attach to, and that decision
deserves to be made on its own merits rather than smuggled in behind a UI feature.

Second, P-D ("it ships code") looked like the fatal objection and turned out to be the
cheapest to neutralize: one static catalog-renderer template converts a code-shipping
protocol into a data-shipping one. The objection that survives is P-B, and it survives as
polling — an acceptable, contained cost, but an honest one to record rather than
engineer around.
