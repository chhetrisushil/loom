# Focus Handoff — placement evaluation (loom, loom-ui, genUI)

- Status: **Verdicts recorded. Kernel change: none. loom 1P: none. loom-ui: one necessary generic seam
  (node emphasis in the renderers) and three optional helpers. Everything else is genUI application
  work.** Nothing is built; this document records placements, corrections and an order.
- Evaluates: [Focus Handoff](2026-10-07-focus-handoff.md), two maintainer white papers. The first argues
  for *focus handoff*: a share that carries the sender's attention (a few flagged elements, an optional
  time window, one line of text) and is rendered as emphasis by the recipient's runtime, with replies
  going back to the originating chat. The second applies it to GenUI on loom and loom-ui.
- Checked against: loom `main` at 386dff4 (`KERNEL_ABI` 1.3.0, `EVENT_SCHEMA` 1.23.0), the sibling
  `loom-ui` repo at `main` bc05278, and `genUI` at `main` b43dcd0. Paths are loom paths unless prefixed
  `loom-ui/` or `genUI/`.
- Rule applied: the maintainer asked for loom and loom-ui to change **only when absolutely necessary**;
  anything that can live in the application layer is placed there. loom placements follow the
  kernel / 1P / 3P triage and the second-consumer rule ([ADR 0083](../adr/0083-second-consumer-rule.md)).
  loom-ui placements follow its own rules: it stays generic (no consumer names, `--lu-*` tokens), every
  capability ships with a reference example, and a missing capability grows the framework rather than
  being worked around in a consumer.

## 1. Verdict

The idea is sound and the generic paper's scope discipline (no threads, no intent taxonomy, no second
approval path, replies stay in chat, measure first) is right. The GenUI paper, however, places three of its
mechanisms on machinery that does not behave as described, and each of those changes the design:

1. **`focus.created` cannot go on the producing run's log.** A finished run accepts only
   `recordOutcome` (ADR 0116). A general late append would be a kernel change with a single consumer.
   The focus belongs next to the share, in genUI.
2. **"Resume the original run" would act with the sender's authority.** Since
   [ADR 0111](../adr/0111-durable-principal.md), effects always run as the run's recorded owner,
   whoever resumes it. "Permissions follow the recipient" is achieved by forking the run (a fork acts as
   the forker by default) or starting a new run, never by resuming.
3. **"Hydrate from the logged tool results" has no data to read.** GenUI hydration is transient by design
   ([ADR 0066](../adr/0066-transient-effect-invocation-facade.md)); `invokeTransient` writes nothing.
   The record of what a viewer saw is loom-ui's per-viewer `SeenLog`.

A fourth correction changes the loom-ui shape: an `emphasize` *operation* cannot keep the sender's content
hash, because every operation mints a new version. A focus is a **view-time overlay** outside the
Experience.

With those corrections, loom needs nothing and loom-ui needs one renderer seam.

## 2. Corrections to the papers

| Paper claim | What the code does | Consequence |
|---|---|---|
| A focus is appended to the producing run's log as `focus.created` | A completed, failed, cancelled or continued run accepts only `OUTCOME_RECORDED` via `runtime.recordOutcome` (reward-shaped, authorized as `annotate`, owner scope, ADR 0116). `ctx.emit` works only inside a live run; `send` is refused on a finished run. Writing the `EventStore` directly bypasses authorization and fencing. | Not without a kernel change, which would fail ADR 0083 (one consumer). Store the focus with the share in genUI. |
| The recipient resumes the original run; the agent acts as the recipient | ADR 0111 D2: on every entry path the effect principal is rehydrated from sequence 0. The resumer is only the lifecycle caller, judged by the `ExecutionAuthorizer`. | Resuming would hand the recipient the sender's authority. Use `fork` (defaults to the forker; `actAs: "owner"` needs a separate, default-deny op) or a new run with `parent` lineage. |
| Flagged nodes can be hydrated from the logged tool results | Hydration is transient (`invokeTransient`, ADR 0066; streaming deltas, ADR 0119, are ephemeral). Only durable step outputs (`STEP_COMPLETED`) and `DECISION_RECORDED` model calls are in the log. | Run-replay hydration is not available for GenUI surfaces. "What the sender saw" lives in loom-ui's `SeenLog` (U12). |
| `emphasize` joins the mutation vocabulary and the recipient still sees the sender's hash | The operations in `loom-ui/packages/core/src/operations.ts` each record a new version; the hash covers every node field (`experienceArtifact`, `loom-ui/packages/core/src/log.ts`). | A view-time overlay, not an operation and not an IR field. |
| DE-9 strips nodes per viewer | DE-9 exists (`@loom/classify` on tool contracts; DE-series evaluation, ADR 0063 usage) and loom-ui enforces `Sensitivity` per viewer, but genUI calls `compile()` with **no viewer** (`genUI/apps/server/app/services/experience.ts`). | genUI has no per-viewer visibility today; the paper's visibility section has nothing to act on until a viewer is wired. |
| A stripped node is absent | `compile` replaces a restricted node with a `Note` placeholder ("Restricted") that keeps its id and grid cell; a container whose children are all restricted collapses (policy A). | Existence is already visible. "Never name the missing one" is a rule for the banner and count, not something the renderer gives. |
| Slack addresses nodes by `block_id` | `genUI/apps/server/app/slack/blocks.ts` builds Block Kit from the legacy `DashboardPayload`; no `block_id`, one `action_id` (`genui_open_live`). | Slack needs node-addressed blocks first, on the legacy path that genUI slices 6.2/6.3 rework. |
| MCP App views are leaf nodes | genUI's MCP App serves the whole dashboard as one payload (`widgets[]`). | A focus there is a payload field, not a node reference. |
| Blueprints change through mutations merged rebase-before-promote | loom-ui has a base-version check (`stale-base-version`) and compare-and-set heads; there is no rebase. `mergeExperiences` is a genUI 6.2 design item, not built. | No rebase to reuse; not needed for focus (§3). |
| Loom primitives `guard$`, `ui$`, `rotate$`; a "recorded, not replayed" class for MCP App views; an "IX replay inspector" | `guard$` and `ui$` do not exist (`ctx.ui` left the kernel, ADR 0114); `rotate$` was deferred (ADR 0052) and `continueAsNew` shipped instead (ADR 0109). The real mechanism is journaled vs ambient effects (ADR 0073, with ADR 0072). `@loom/replay-inspector` exists (ADR 0071) and is read-only. | Vocabulary only. |
| Approval bound to (blueprint hash, presubmit hash) | True, as genUI governance: the approval gate binds `(versionHash, reportHash)` (`genUI/apps/server/app/flows/approval-gate/flow.ts`). | The paper's refusal to build an "approval annotation" stands. |

## 3. What already exists and answers the papers' open questions

- **Stable node identity across versions.** Node ids are minted once and never reused; a planner returns
  operations, never a new tree, and its conformance kit refuses remove-then-reinsert of an id. A focus
  anchored to `(versionHash, node id)` stays exact for that version forever (artifacts are immutable and
  content-addressed) and survives every revise for nodes that still exist.
- **Node lineage** (open question 1). `describeChange(prev, next, { viewer })` in
  `loom-ui/packages/core/src/change.ts` reports `identity.dropped` / `identity.added` over viewer-visible
  ids, and `Lineage.explain` gives a per-node ledger. "Which flagged nodes survive into the current version
  for this viewer" is a few lines over it. Regeneration does not need a rebase.
- **Per-view time window.** `HydrationController.setParams({ from, to }, { handle })` in
  `loom-ui/packages/hydration/src/controller.ts` re-asks only the handles whose question changed, with no
  blueprint change and no new hash. Limits: the step's arguments must be marked `overridable`, and a data
  handle shared by several nodes moves for all of them. genUI already has a dashboard-wide picker
  (`genUI/apps/server/app/compose/timeRange.ts`).
- **What a viewer saw.** `SeenLog` (`loom-ui/packages/lineage/src/seen.ts`) records per (experience,
  viewer) the class-stamped values a viewer was shown, and `read` redacts against the *reader's* viewer
  and `ReadPolicy`. Serving the sender's record to the recipient would therefore expose only what the
  recipient is cleared for.
- **Visibility queries.** `inspectExperience` (`loom-ui/packages/core/src/change.ts`) plus `mayView`
  (`loom-ui/packages/core/src/viewer.ts`) yield a fail-closed visible count.
- **Agent context.** `AgentInput.context` (`packages/agent/src/types.ts`) is rendered into the prompt by
  `agentLoop$`; an inbox message (ADR 0110) is the alternative for a parked run. Both deliver the focus as
  data; a sent payload is tainted (ADR 0085), so it can steer the agent but cannot become instructions.
- **Content addressing.** The `ContentStore` SPI (`plugins/content/src/ContentStore.ts`, ADR 0046) gives an
  idempotent `put` by hash, the same pattern `putExperience` uses, if genUI wants a content-addressed
  `Focus` record.
- **Notifications.** None in loom or its plugins. This matches the papers' refusal to host the
  conversation.

## 4. Placement

| Piece | Placement | Reason |
|---|---|---|
| `Focus` record `{ versionHash, nodes ≤ 5, window?, note?, author, origin? }` | **genUI** — beside `share_links` (`genUI/apps/server/app/store/shares.ts`), which already pins a `checkpointId` | App data about a share; no loom component reads it. |
| Durable "fact about the run" | **genUI** — its own table or stream keyed by run id and version hash | A late append to a finished run is a kernel change with one consumer. |
| Recipient continues the investigation | **genUI** — `fork` as the recipient, or a new run with `parent`; focus as `AgentInput.context` | Supported today; keeps "permissions follow the recipient" true under ADR 0111. |
| Emphasis / subdued rendering | **loom-ui (necessary)** — §5 | The renderer owns the DOM; styling it from outside is a workaround. |
| Surviving flagged nodes for a viewer and version | **genUI** over `describeChange`; optional loom-ui helper later | A few lines; no new capability. |
| "N flagged, M visible to you" | **genUI** over `inspectExperience` + `mayView`; optional loom-ui helper later | Unknown and restricted ids must count the same so the count leaks nothing. |
| Time window on flagged nodes | **genUI** via `setParams` per flagged handle | Supported today. |
| Hydrate from what the sender saw | **Deferred.** If built: loom-ui, a documented "read another viewer's `SeenLog`, redacted for the reader" path; genUI authorizes who may read whose log | Needs erasure handling: the sender's `eraseViewer` destroys the key, so the snapshot must degrade to "no longer available". |
| Note classification | **genUI** | There is no text classifier anywhere; sensitivity is declared, never inferred. Fail-closed rule: the note takes the strictest class among the flagged nodes and is shown only to viewers cleared for it. |
| Share-time warning, banner, clear/restore, selection, back-link | **genUI** | Application UI. Refine already accepts a target node (`refineDashboard` → `scopeNodeIds`), so the selection plumbing exists. |
| Slack / MCP App projections | **genUI, after slices 6.2/6.3** | Both still read the legacy `DashboardPayload`; Slack also needs node-addressed blocks. |
| Agent-created focuses | **Out of scope here** | The planner already decides through `ctx.decide`, so it is feasible, but it is a different feature with different trust requirements; evaluate it on its own. |

## 5. loom-ui: the one necessary change

**Node emphasis as a first-class renderer seam.** `renderer-lit` reconciles by key and never remounts a
widget whose id is unchanged; its only per-node hook today is the `data-widget-id` attribute
(`loom-ui/packages/renderer-lit/src/dom/tree.ts`). A consumer styling `[data-widget-id]` from outside would
depend on an undocumented seam, which the "grow the framework, never work around it" rule rules out.

- **Shape.** A render option, e.g. `emphasis: ReadonlyMap<nodeId, "focus" | "subdued">`, surfaced as a
  `data-lu-emphasis` attribute with `--lu-*` tokens (subdued opacity, focus ring) and an optional
  scroll-into-view for the first focused node.
- **Not an IR change.** Emphasis is viewer-local state, like the selected tab or a `setParams` override;
  compile does not need to mean it, and the Blueprint and Experience stay untouched, so the hash stays the
  sender's. (If emphasis were ever to be authored into a surface, that would be a Blueprint IR bump with
  both loom renderers and an ADR, and it would change the hash, contradicting the paper.)
- **Requirements.** Zero extra DOM mutations across `update`/`recompose` when unchanged; a
  `renderer-terminal` counterpart with parity tests; restricted placeholders and collapsed containers
  treated like any other id (the overlay may not reveal anything compile hid); the genericity test; a
  loom-examples reference example.

**Optional, deferrable:** a fail-closed visible-count helper, a "focus survives into version V for this
viewer" helper, and the cross-viewer `SeenLog` read path. Each is a few lines over existing APIs and can
start life in genUI.

## 6. loom: no change

Both of the paper's loom asks are better served by what ships:

- the durable record lives with the share, and the run is referenced by id;
- continuation is a fork or a new run started by the recipient, with the focus as `AgentInput.context`.

Nothing here touches `KERNEL_ABI`, `EVENT_SCHEMA` or any SPI.

## 7. genUI work, in dependency order

1. **Measure.** Both papers make this the gate. `share_links` already records shares, so share frequency
   is countable now; the locating language beside each link needs a short observation.
2. **Wire a viewer** into `compileWith` and hydration. This is a prerequisite: without it the visibility
   rules have nothing to work on. It is also a fix in its own right: with no viewer, loom-ui compiles any
   node classified `sensitive` or `secret` as a placeholder for everyone, the owner included.
3. **`Focus` with the share**, including the share-time check of flagged nodes against their classes.
4. **Recipient view:** emphasis through the loom-ui seam (§5), the banner with the visible count,
   clear/restore, and the window through `setParams`.
5. **Continue as the recipient:** fork or new run with the focus as context.
6. **Slack and MCP App projections**, after slices 6.2/6.3.

## 8. Effect on the current plan

One loom-ui item (the emphasis seam, with its reference example) joins the loom-ui lane whenever genUI
decides to build focus handoff; it has no dependency on loom Wave 3. No loom items are added, and the loom
order (Wave 3: R5, R10, R17) is unchanged.
