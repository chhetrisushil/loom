# Experience Runtime / Rendering Runtime — placement evaluation

- Status: **Verdict recorded. Build it as a separate framework, seeded from `genUI`, with loom as
  its substrate. Net kernel change: zero. Net loom 1P surface change: negative** — the document is
  the argument for moving loom's widget vocabulary and renderers *out*, not for growing them.
- Evaluates: [the AI-Native Experience Runtime and Rendering Runtime TRD](2026-09-21-experience-rendering-runtime.md),
  a brainstorm output whose submitted question was *integral to loom, or a separate framework?*
- Method: the ADR 0051 discipline — a placement verdict per claim, judged against the best
  existing loom mechanism, bias outward (P10), the
  [second-consumer rule](../adr/0083-second-consumer-rule.md) applied before anything becomes 1P
  surface. Every claim below was checked against this repo and against the `genUI` and `aetherOS`
  sibling checkouts on 2026-09-21, not against prior evaluations.
- Builds on: the portfolio evaluation's [Part II](2026-09-01-product-portfolio-evaluation.md)
  (structure static / data dynamic), the [composed-surfaces recipe](../composed-surfaces.md),
  ADRs [0067](../adr/0067-reactive-graph-resumability-rejected.md),
  [0068](../adr/0068-projection-selector-subscription.md), [0069](../adr/0069-a2ui-egress-adapter.md),
  [0083](../adr/0083-second-consumer-rule.md), [0084](../adr/0084-effect-classes-static-ceiling-k2-floor.md),
  [0088](../adr/0088-blueprint-conformance.md), [0092](../adr/0092-adaptive-operator-profiles-placement.md),
  [0094](../adr/0094-blueprint-node-identity.md), [0095](../adr/0095-binding-semantics-pin.md), and the
  [surface-area audit](2026-09-11-surface-area-audit.md).

---

## 0. Verdict

Three tiers, decided by evidence rather than taste:

| Tier | Verdict | Why |
|---|---|---|
| Kernel | **Nothing.** No syscall, no event kind, no fold change. | Every requirement that touches durability, ordering, replay, provenance or authorization already resolves to an existing mechanism (§2). This is the same result as Part II, the three CON passes and the persona evaluation. |
| Loom 1P | **Keep the durable channel thin; move the widget vocabulary and renderers out.** | The one serious GenUI consumer imports the channel and ignores the vocabulary (§1). Under ADR 0083 a renderer with zero consumers is not 1P surface, and the [surface-area audit](2026-09-11-surface-area-audit.md) already found loom's problem is *names*. |
| Separate framework | **Yes — a sibling repo, extracted from `genUI`, not greenfielded from the TRD.** | Both halves of the TRD exist there today as app code with two live surfaces (§1). The TRD is a generalisation of what was built; extraction gives it a consumer on day one. |

The document's own §6.3 ("MUST NOT duplicate Loom's durable execution semantics") and non-goal
("not a database") are the constraint that makes the third row possible: the framework depends on
loom through a narrow contract and owns no store of its own.

## 1. The decisive evidence: a consumer already voted

`genUI` (sibling checkout, last commit 2026-09-16) is the only GenUI product built on loom that is
past the demo stage. Its imports from loom, counted by `from "@loom/…"` occurrences across
`packages/` and `apps/`:

| Package | Imports | Role |
|---|---|---|
| `@loom/core` | 70 | kernel |
| `@loom/workflow-runtime` | 43 | kernel |
| `@loom/plugin-mcp` | 33 | capabilities |
| `@loom/effect-runtime` | 33 | kernel |
| `@loom/plugin-sandbox` | 32 | reshaping scripts (ADR 0064) |
| `@loom/llm` | 27 | planning |
| `@loom/orchestration` | 17 | kernel |
| `@loom/event-runtime` | 12 | log |
| `@loom/plugin-postgres` | 10 | log |
| `@loom/app` | 10 | config |
| `@loom/agent-surface` | 10 | **the durable UI channel** (`createSurfaceEmitter`, `SURFACE_PATCH`) |
| `@loom/plugin-a2ui` | 4 files | **catalogue + egress wire types** |
| `@loom/blueprint-runtime` | **0** | declared in `apps/server/package.json`, never imported |
| `@loom/plugin-renderer-react` | 0 | — |
| `@loom/plugin-renderer-terminal` | 0 | — |

What it built instead maps onto the TRD almost section for section:

| `genUI` package | TRD concept |
|---|---|
| `packages/shared` — `blueprint.ts` (zod `Blueprint`, `LayoutNode`, `VocabularyFloor`, `ProviderSpec`), `layout.ts`, `governance*.ts`, `localization-*.ts`, `hydration.ts`, `forms.ts`, `components.ts`, `a2ui.ts`, `chart-svg.ts` | §7 Experience Model, §12 semantic node, §15 Experience IR, §26–29 registry / design-system / a11y / localization |
| `packages/ui-sdk` — `HydrationController`, `HydrationProjection`, `HydrationState`, `DashboardStore`, `Signal`, `BATCH_WINDOW_MS`, `applyOpsLocally` | §17 Rendering Runtime, §23–25 progressive rendering / streaming / scheduler (P0/P1/P2 priority batching, 50 ms debounce-and-collect) |
| `packages/widgets-lit`, `packages/renderer-terminal` | §19 platform renderers — two of them, over one headless runtime |

Its `WidgetNode` is `{ id, kind: "widget", component: { name, version }, binding: { opaqueHandle, priority } }`.
That is already closer to the TRD's §12 semantic node (a *named, versioned* component reference
resolved per surface) than loom's `WidgetKind` union of eight visual widgets
(`MetricCard`, `Timeline`, `ApprovalCard`, `StatusBadge`, `ProgressBar`, `DataTable`, `AlertCard`,
`StreamingText` — `packages/blueprint-runtime/src/types.ts`) is.

So the placement question has been answered once by a real consumer: **the render layer lives
beside loom, uses loom's log for durability, and does not use loom's widget vocabulary.** A
second consumer, `aetherOS`, is on the same footing (two app surfaces on the kernel; last commit
2026-08-10). Neither asked for a 1P rendering runtime, and neither adopted the one loom has.

## 2. The "Experience Runtime" is mostly loom's kernel re-described

Read with the TRD's UI vocabulary stripped off, §6.1's ownership list is the event-sourced
execution model. The mapping, each verified against code:

| TRD requirement | Existing loom mechanism |
|---|---|
| §47 / I8 — replay from initial experience + ordered events | the fold; `SURFACE_PATCH` is a userspace domain event, replayed by construction |
| §20 — reject a mutation on a stale `baseVersion` | sequence fencing (K9, ADR 0021) on append |
| §45 — mutation provenance (source, agent, model, reasoning ref) | `by: PatchProvenance` on `SurfacePatchPayload` (`packages/agent-surface/src/types.ts`); `DECISION_RECORDED` carries model, policy, context and propensity (ADR 0079) |
| §8 — intent immutable; §35 — hydrate without re-planning | *"composition is an event; rendering is a replay"* — `BLUEPRINT_COMPOSED` + a `sha256:` ContentStore ref ([composed-surfaces](../composed-surfaces.md)) |
| §34 — serialize identity, graph, capability refs, policies; never DOM/Fiber | the same recipe; ADR 0067 D1 records serializing a reactive graph as a permanent non-goal |
| §32 / §44 / I7 — UI mutation ≠ capability execution; layered authz | K2 `GrantTable` (runtime floor) + ADR 0084 effect classes (static ceiling) + execution-lifecycle authz (ADR 0039) |
| §13 — Capability with schemas, permissions, risk, execution mode | `@loom/capability`, `@loom/plugin-mcp` (with canonical schema hash + drift channel, ADR 0063), effect classes |
| §14 / §51 — data dependencies with cache/refresh; multi-layer caching | the transient hydration interpreter: a plan whose nodes pin an input-schema hash, a content-addressed reshape script and an expected output hash, walked through `invokeTransient` with **zero events on the read path**, recording `SCHEMA_REPAIRED` on drift (ADRs 0060–0066; Part II §8) |
| §33 — lifecycle CREATED…SUSPENDED…RESUMED…DESTROYED | execution lifecycle, `ctx.suspend`/resume, long suspensions (ADR 0081) |
| §26 / §37 — registry resolution; surface negotiation ("doesNotSupport interactive_chart") | `validateBlueprint` (composition → catalogue) and `catalogCoverage` (catalogue → renderer), ADR 0088 D1 — one surface today, generalises to N |
| §11 — stable node ids across revisions | explicit `id` on every builder, `preservesNodes`, `bridge.identityDiff` (ADR 0094) |
| §52 — independent versioning of schema / IR / components / capabilities | `projectionVersions` pins + `checkBlueprintPins` (ADR 0095); `ReadModelDefinition.version`; MCP schema hash |

The TRD's §58 reference layout then lists `runtime/event-store/` and `runtime/persistence/` — a
direct contradiction of its own §6.3 and of the "not a database" non-goal. Built separately *with
those directories*, the framework rebuilds the kernel badly and loses every guarantee in the table.
Built inside loom, it is not a runtime at all: it is a vocabulary over `ctx.emit`, `ctx.decide`
and the ContentStore.

**Verdict on the name:** the first half is not an Experience *Runtime*. What is real is an
**Experience Model** — a data schema, a mutation vocabulary, and a compiler to Rendering IR. The
second half is honestly a runtime, and it is one loom should never contain (§4).

## 3. Where the document is wrong on its own terms

These are defects in the TRD regardless of where it is built. Each names the loom finding that
already established the point.

### 3.1 One `version` counter conflates three things that must stay apart

§7's `Experience` holds `intent`, `graph`, `state` and `context` under a single `version`. Part II
§6's structural finding is that these have different lifetimes: **structure** is composed once and
content-addressed, **data** is a patched sequence, **viewer context** is never persisted. Under the
TRD, a filter click (`state.filters`) increments the same version that §22's rendering patches key
on (`fromVersion`/`toVersion`), and §34 serializes `state` beside the graph. §9's own rule that
sensitive context MUST NOT be persisted is then honoured only by a "references" qualifier.

Two counters are needed: a **structure revision** (the content hash of the composed artifact) and
a **data sequence**. Loom already has exactly this split — `BLUEPRINT_COMPOSED { ref }` for the
former, the `SURFACE_PATCH` sequence for the latter — and `genUI`'s `Blueprint.meta` versus its
hydration projection is the same split in the consumer.

### 3.2 Planning has no determinism story

§5 puts an **Experience Planner** and a **Policy Engine** inside the Experience Runtime. The
planner calls a model. If its output is not recorded as a decision, §47's replay diverges, which is
why §47 says the runtime *SHOULD* (not MUST) reconstruct the same state. This is the one place
where building separately loses something real: `ctx.decide` → `DECISION_RECORDED` is what makes
"the same intent produced this experience" a replayable fact rather than a hope.

**Fix:** planning MUST run as a loom execution, and the Experience Model is the recorded output.
§6.3's *MAY execute work through Loom* becomes *MUST, for anything nondeterministic*. §47's SHOULD
becomes MUST for free.

### 3.3 "The registry MUST be extensible" reopens ADR 0088

§12 requires the semantic type registry to be extensible without saying **when**. Extensible at
build time is how every catalogue works. Extensible at *runtime* lets an agent introduce a type
nobody audited — precisely the hole `validateBlueprint` and the closed catalogue shut on
2026-09-01, and the [composed-surfaces](../composed-surfaces.md) "what not to do" list states the
rule: accessibility, i18n and design conformance are properties of individual outputs, so a
vocabulary open at runtime cannot be audited at all. The TRD's own §27 ("MUST NOT arbitrarily
invent visual styles") and §28 assume the closed form. Say "closed at runtime; a gap is logged".

### 3.4 "Reject stale unless safely rebased" is unspecified

§20's mutation protocol is node-level (`add/remove/replace/update/move/bind/unbind`) with
optimistic concurrency and an escape hatch: *unless the mutation can be safely rebased*. "Safe" is
the entire problem, and the document does not define it. Loom's composed-surfaces rule avoids the
question: a recomposition is a **new artifact and a new event**, identity comes from the content
hash plus explicit node ids, and `preservesNodes(before, after)` reports what a revision dropped
(ADR 0094). On the A2UI path this is `recompose(components)` → `updateComponents` (ADR 0088 D5).

**Fix:** mutations are *proposals* that yield a new composed artifact; the log records the artifact
ref with the mutation as provenance. Then §47 replay is a fold, and §22's rendering patch is a
**derived** diff between two trees, not a primary protocol that has to be versioned (§52) and
tested (§48.4) on its own.

### 3.5 A second Capability model means two authorization vocabularies

§13 defines `Capability` with `permissions`, `risk` and `execution: local|remote|agent|workflow`.
Loom already has `@loom/capability`, K2 grants, and ADR 0084 effect classes (which exist because a
*granted* capability can still bust its class — the reconciliation lives in the finding text). I7
("UI mutation does not imply capability execution authorization") depends on there being **one**
vocabulary that both the experience layer and the execution layer consult. Make the experience
layer hold **references** to loom capabilities and nothing else — which is what §7's
`capabilities: CapabilityReference[]` already says, before §13 contradicts it.

### 3.6 Data dependencies and caching are already solved better than §14 and §51

§14's `mode: eager|deferred|streaming|onDemand` plus `cachePolicy`/`refreshPolicy`, and §51's five
cache layers with "explicit invalidation", redesign what the transient hydration interpreter
(`genUI`'s own `hydration.ts`, on ADRs 0060–0066) already does with a stronger guarantee: each node
pins the tool's input-schema hash, a content-addressed reshape script and an expected output hash;
the read path emits nothing; a pin that drifts crosses into a durable run that records
`SCHEMA_REPAIRED`. Part II §8 called this *CON §5.4 already built*. The TRD should adopt it as the
data-dependency model, not specify a parallel one.

### 3.7 Personalization from context has no fold treatment

§1 promises experiences "personalized using runtime context" and §9 makes context versioned and
observable. ADR 0092 found the trap: an expiring or learned profile read at fold time breaks fold
purity, so the **resolved** profile must be journaled as a decision, and erasure never reaches
read-model rows. The TRD never addresses it. Any "adapt to user" behaviour belongs in the planner
(§3.2), recorded via `ctx.decide`, not in a context object the renderer reads live.

### 3.8 Scope fails the second-consumer rule for loom — and that is fine for a separate framework

§19 lists six renderers; §61 adds four in Phase 3; §62 adds speculative rendering, collaborative
and distributed experience state. Angular, Flutter, native and Teams have **zero** consumers in any
repo the maintainer owns; Slack has zero; the two that exist (web, terminal) are in `genUI`. As
loom 1P packages that is disqualifying under ADR 0083, and the
[surface-area audit](2026-09-11-surface-area-audit.md) already concluded loom's bloat is in package
*names* and needs a prune. As a product's own framework, a single consumer is an acceptable
starting state — the rule gates *loom's* surface, not a product's. **This asymmetry alone decides
the placement.** §43 (zero-cost-when-unused) also becomes true by construction in a separate repo
and false by construction inside loom, where every user pays the name.

Chat surfaces are additionally already half-covered at the edge: `@loom/plugin-a2ui` (egress) and
`@loom/plugin-mcp-app` (MCP Apps host surfaces) exist as protocol adapters. A "Slack renderer"
should be an A2UI or MCP-app client, not a fourth renderer.

## 4. What is right, and should be kept as written

- **I1, I2, I4, I6, I7, I10** are consistent with what loom enforces or has recorded. "No LLM in
  the render path" is the composed-surfaces rule; "UI mutation ≠ execution authz" is K2 + ADR 0084;
  "no platform UI state in canonical state" is ADR 0067 D1.
- **§4.2 semantic-before-visual.** Correct, and it indicts loom's own `WidgetKind` (eight *visual*
  widgets) as much as it indicts JSX. `genUI`'s `component: { name, version }` is the right shape.
- **The Rendering Runtime is genuinely separate** and belongs nowhere near loom: scheduler,
  layout, a11y mapping, design-system constraints, device adaptation, hydration, local interaction
  state. None of it touches the log; all of it churns with the platform. ADR 0067 D3 already filed
  lazy hydration as a renderer-plugin internal; ADR 0069 housed A2UI at the edge because it is
  young. The TRD's §6.2 ownership list is the right boundary.
- **§37 surface negotiation** is `catalogCoverage` generalised across surfaces — a good idea, and
  the kind of thing the separate framework should own.
- **§49 failure taxonomy** (a capability failure produces an error node, not a dead experience)
  matches ADR 0060's typed failure channels and ADR 0088 D3's findings-not-throws.

## 5. Placement, concretely

### Kernel — nothing

`KERNEL_ABI` and `EVENT_SCHEMA` unchanged. No `@loom/spec` capability entry.

### Loom 1P — keep, and hold thin

| Keep | Why |
|---|---|
| `@loom/agent-surface` (`SURFACE_PATCH`, `by` provenance, `applySurfacePatches`) | the durable data channel; the one thing `genUI` imports from loom's UI layer |
| the `BLUEPRINT_COMPOSED` + ContentStore recipe, `checkBlueprintPins` / `projectionVersions` (ADR 0095) | structure-as-a-logged-artifact; no package of its own, it is a documented pattern |
| `@loom/plugin-a2ui`, `@loom/plugin-mcp-app` | protocol adapters at the edge; consumers exist |
| `ProjectionRuntime.subscribeSelector` (ADR 0068) | the read-model half of hydration; `genUI`'s ui-sdk consumes it |

One **addition**, the only loom-side item this evaluation proposes: a conformance kit — the same
shape as the memory-store conformance kit — asserting that a framework's persistence goes through
the log: *given an experience's event slice, folding reproduces the same sequence of artifact
refs and the same surface state*. That is the seam by which loom stays the substrate without owning
the UI, and it makes §6.3 checkable rather than aspirational.

### Loom 1P — candidates to move out

| Move | Evidence |
|---|---|
| `@loom/blueprint-runtime`'s widget vocabulary (`WidgetKind`, the eight builders, `RendererRegistry`, `builtinCatalog`) | the only serious consumer imports none of it; the kinds are visual, contradicting the TRD's §4.2 and the semantic direction loom itself argued for |
| `@loom/plugin-renderer-react`, `@loom/plugin-renderer-terminal` | 8 React renderers + a kind-blind terminal renderer for a vocabulary the consumer did not adopt; `genUI` ships its own Lit and terminal renderers |

`validateBlueprint`, `catalogCoverage`, `preservesNodes`, `stableId`, `traverseBlueprintAsync` are
sound *as patterns* but are written against loom's `Widget`/`Layout` types, so they move with the
vocabulary. This is a real migration cost — the package has tests, pins, identity and an async
walker — so the sequence is: the framework's Phase 1 decides **adopt or supersede**; if it
supersedes, loom deprecates the package in a follow-up ADR. Not before.

### Separate framework — a sibling repo

Sibling to `loom-examples` and `loom-plugins`, seeded by **extracting** `genUI`'s `packages/shared`,
`packages/ui-sdk`, `packages/widgets-lit` and `packages/renderer-terminal`. Day one it has an
Experience Model, a Rendering Runtime with priority scheduling, two surfaces, and a live consumer.
Its contract with loom is narrow and already exercised: `ctx.emit` (`SURFACE_PATCH`,
`BLUEPRINT_COMPOSED`), `ctx.decide` (planning), the ContentStore (artifact refs), `@loom/agent-surface`,
`@loom/plugin-a2ui`, `invokeTransient` (hydration), `subscribeSelector` (read side). It owns **no
event store and no persistence**.

## 6. Edits to make to the TRD before anyone builds from it

1. Rename the first half **Experience Model**; keep **Rendering Runtime**.
2. Split `Experience.version` into a structure revision (content hash) and a data sequence (§3.1).
3. Make the Planner a loom execution using `ctx.decide`; §6.3 MAY → MUST; §47 SHOULD → MUST (§3.2).
4. Delete `runtime/event-store/` and `runtime/persistence/` from §58; replace with loom adapters.
5. §12: the registry is extensible at build time and **closed at runtime**; a gap is logged (§3.3).
6. §20: replace stale-rebase with recompose-as-new-artifact; make §22 a derived diff (§3.4).
7. §13: `Capability` becomes `CapabilityReference` into loom's model (§3.5).
8. §14/§51: adopt the pinned transient hydration plan as the data-dependency model (§3.6).
9. Add the ADR 0092 rule for personalization: the resolved profile is a recorded decision (§3.7).
10. §19/§61: reduce to the two renderers that exist; route chat surfaces through A2UI / MCP-app
    egress (§3.8).

## 7. Summary

| Claim | Verdict |
|---|---|
| Build the Experience + Rendering runtimes inside loom | **No.** Zero consumers for most of it; the one consumer built its own beside loom and skipped loom's vocabulary. |
| Build them as a separate framework with their own store | **No.** Violates the TRD's own §6.3; rebuilds the kernel without `decide`, fencing, or the fold. |
| Build them as a separate framework **on** loom, extracted from `genUI` | **Yes.** Narrow contract, live consumer, two surfaces on day one. |
| Kernel change | **Zero.** |
| Loom 1P change | One conformance kit in; widget vocabulary and renderers out, after the framework decides adopt-or-supersede. |
