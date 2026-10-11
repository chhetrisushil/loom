# loom-ui slice 6 — genUI migrates onto loom-ui

**Status:** design, approved in review on 2026-09-23 · **Scope:** genUI (both view models), loom-ui pre-work, one loom Blueprint IR minor bump · **Depends on:** loom `main` 8ff79a3, loom-ui `main` b2f9886 (slice 6a shipped), genUI `main` bcd45d7 · **Roadmap:** `2026-09-21-loom-ui-design.md` §10 row "6 genUI: migrate"; `2026-09-22-blueprint-ir-2-design.md` §7.

## 0. Decisions this design rests on

Made in review on 2026-09-23:

| Question | Decision |
|---|---|
| Which of genUI's view models migrate? | **Both, as ordered sub-slices.** 6.1 the end-user dashboard path (`PublicLayoutSchema` + `PrivateExecutionManifest`), 6.2 the authoring path (the tree `Blueprint`), 6.3 delete what is left. Slice 6 ends with no private view model in genUI. |
| How does genUI's generation compose? | **genUI implements loom-ui's `Planner` SPI.** Its prompts, catalogue and corpus-tuned behaviour carry over; the model call becomes one `ctx.decide` (genUI's first decide call site); the planner must pass `checkPlannerConformance`. The reference planner stays loom-ui's reference, not genUI's engine. |
| What happens to stored data? | **A one-time, versioned migration script** per sub-slice, verify-then-drop: code reads only the new format; old columns are dropped by a later migration only after every row converted. |
| Sequencing | **Strangler, dashboard path first** (approach 1 of 3). Generic gaps land in loom-ui first, each its own PR with tests; genUI changes follow; every sub-slice leaves genUI's CI, integration tests and 18 e2e journeys green. Rejected: type-swap-first (genUI red for weeks, e2e cannot guard steps); boundary adapters (keeps two models — the thing slice 6 exists to end). |
| Approvals across the rehash | **Carried over through a proven old→new hash map** (§4.6). "Approval never transfers" still holds for any content change. |
| Where does this spec live? | loom `docs/requirements/`, beside the earlier loom-ui designs. |

**loom-ui is a generic UI framework on top of loom.** genUI is its first consumer, never its design centre (user ruling 2026-09-23, during phase 0): loom-ui names no consumer (no `genui` / `gx-` anywhere in the repo — theme tokens are `--lu-*`; a fitness test enforces it; README's `## Consumers` section is the one exception); every capability is stated as a consumer-neutral need; a value contract describes the widget, not a consumer's payload (a consumer with an idiosyncratic shape adapts at its own boundary); and every capability ships with a reference example in loom-examples that is not a specific consumer's app. Every loom-ui review asks: would an unrelated app use this as-is? Where this document says "genUI needs X", X lands in loom-ui only in its consumer-neutral form.

Standing rules that apply: grow the IR, never work around it (a field the Blueprint cannot carry is an IR bump, not a smuggled prop); loom-ui builds a capability before its consumer arrives; a generic capability goes into loom-ui, a genUI product concern stays in genUI.

## 1. The problem

loom-ui was seeded from genUI (`core` ← `shared/blueprint.ts`/`layout.ts`/`governance.ts`, `hydration` ← `ui-sdk`, `planner` ← `apps/server/app/compose`, `renderer-lit` ← `widgets-lit`, `renderer-terminal` ← genUI's `renderer-terminal`), and genUI still runs its own copies. Until genUI runs on loom-ui, the framework has no consumer (`2026-09-21-loom-ui-design.md` §10: "it is not optional").

genUI has **two** independent view models, not one:

| | tree `Blueprint` (`packages/shared/src/blueprint.ts`) | flat `PublicLayoutSchema` (`packages/shared/src/layout.ts`) |
|---|---|---|
| Consumers | authoring: `apps/authoring`, ~21 server files (ingest / refine / apply-operation / presubmit flows, `store/blueprints.ts`, governance services), `packages/i18n` content extraction | end users: `generate-dashboard` → `apps/web` (Lit) and `apps/tui` (Ink), `apps/server/app/hydrate`, `services/dashboards.ts` (dashboards CRUD, checkpoints, snapshots, share links, comments, experiments) |
| Shape | content-addressed tree, ops + fold + three-plane merge | flat `components[]` with `position {x,y,w,h}`, `views`, `timeRange`, `filters`; plus a server-only `PrivateExecutionManifest` (tool DAG, `$now` tokens, reshape scripts, `filterable`) |
| loom-ui equivalent | `Experience` + `Operation` (near-identical — it was seeded from this) | none; genUI's web app never sees a Blueprint today |

A capability-by-capability gap analysis (2026-09-23, every row cited against the three `main` heads above) found that the migration is not only "port what is missing": five behaviours **conflict**, and one gap is a loom IR change.

## 2. What goes where

### 2.1 loom (1P) — Blueprint IR minor bump ("A")

genUI dashboards are free-placed (`x`, `y`, `w`, `h`) and views are titled. loom's `GridCell` carries only `span`; no `Layout` carries a title. Per grow-the-IR:

- `GridCell` gains optional placement: `row`, `rowSpan` (height), `column` (start). Absent = today's flow placement; `span` keeps its meaning (width).
- Every `Layout` gains an optional `title` (a section heading).
- A **minor** `BLUEPRINT_IR_VERSION` bump (additive, readers ignore absent fields) with the shape manifest re-pinned, both loom renderers (React, terminal) honouring placement and title, `validateBlueprint` findings for out-of-range placement, and an ADR. No kernel, EVENT_SCHEMA or KERNEL_ABI change.

### 2.2 loom-ui pre-work

| Group | Contents | Why genUI needs it | First needed |
|---|---|---|---|
| **B1 value and widgets** | New framework kinds, each with a zod value contract, an `lu-*` element and a terminal renderer: a KPI (`value, unit?, format?, label?, deltaPct?`), a columnar table (`columns: (string \| {label, format})[]`, rows of arrays, per-column format), a status card (`level, headline, detail?`, `role="status" aria-live="polite"`), a static `Note`; `LocalizedText` in declared text props, resolved at compile like labels; and registry kinds `A2UIView` / `SandboxView` mounting `lu-a2ui-view` / `lu-sandbox`. Richer charts: per-series `format`, `axis: "left" \| "right"` with a dual-axis `lu-timeseries`, value-level `format` honoured by both charts; `formatFromUnit` accepts any ISO 4217 code. | genUI's metric, table and status shapes **conflict** with loom's `MetricCard` (number), `DataTable` (records) and `StatusBadge` (string) contracts, which loom's React renderers depend on — so framework kinds are added, loom's are not changed. Dual axis is advertised by genUI's catalogue and emitted by its reshapers. | 6.1 |
| **B2 output check by contract** | A `ProviderSpec` output mode that validates the reshaped value against the bound kind's value contract (`checkKindValue`) instead of an exact `outputShapeHash`; drift only when the contract fails. The shape hash remains the input-drift signal. | loom's structural shape hash differs for `[]` vs `[{…}]` and `null` vs a number, so an empty result set or a null cell would mark a healthy widget stale and fire the repair loop (**conflict**). | 6.1 |
| **B3 hydration** | (a) **Split hydration**: a controller variant that schedules from a public handle inventory (handle, priority, overridable params — shipped beside the Blueprint) and loads through a pluggable `HandleLoader`, publishing into a client-side `HydrationStore`; the server side stays `executeProvider`. (b) Relative-time tokens (`$now`, `$now-7d`) resolved against an injected clock. (c) Per-load `params` applied only to arguments a step declares overridable (a new optional `MCPToolNode` field), never to a templated argument; defaults for a time range. (d) `HydrationCache` keys include resolved params. (e) An optional argument hook. (f) A controller-wide concurrency cap and an in-pass memo of identical steps (same tool, resolved args, schema pin) across providers. (g) `inputDrift: "report" \| "report-and-proceed"`: on `schemaDrift`, record the drift and retry once with the observed hash. (h) A third reshaping engine, `Named`: host-registered reshapers resolved through an injected registry, no sandbox hop. | genUI's browser must never see tools (**conflict** with in-process hydration; the compiled Blueprint also drops `priority`). `$now` tokens, the time-range picker, filter bar, controls and widget-scoped filters. genUI bounds a whole pass to 4 calls and shares upstream outputs across handles. Read-only viewers (checkpoints, published pages, snapshots) cannot persist a repair (**conflict**: genUI proceeds, loom-ui goes stale). genUI's eight built-in `(tool, componentType)` reshapers. | 6.1 |
| **B4 ops and planner** | `removeProvider` (refused while a node still binds the handle; refused from `interpretAction`), a structural layout op carrying `span` and the §2.1 placement fields, and model `usage` on `PlannerModel.complete` and `PlanReport`, recorded inside the decision. | Remove / remap without orphan providers (which fail presubmit pin freshness); resize (no op can change `span` today); per-dashboard token totals that survive replay. | 6.1 |
| **B5 authoring support** | `mergeExperiences(base, ours, theirs)` — layout by stable id, providers atomic per handle, localization key conflicts, always an ours-biased partial plus conflicts; static provider-graph checks in `validateExperience` (cycles, unknown `dependsOn`, `{{steps.x…}}` naming no earlier step). | genUI's three-plane merge; `checkSchemaDag` at author time. | 6.2 |

Carry-overs re-checked: `removeProvider` is needed (B4). Not needed: setProps key removal (genUI's `configure` also merges), reference-planner reorder/re-type and QuickJS authoring (genUI writes its own planner, which already authors scripts). Newly found: no op changes `span` (B4).

#### Implementation notes (phase 1)

What phase 1 shipped as (loom-ui #12 = P1 layout/IR 2.1, #13 = B2/B3 hydration, #14 = B4 ops and usage), where it sharpened or deviated from the design above:

- **D14 — `HydrationCache` key (B3d).** The key is the spec fingerprint + the *declared* overridable params with `$now`-family time tokens left unresolved (not the values they'd resolve to) + the checked kinds, contract mode only, normalised. A key built from a resolved `$now` would never hit; freshness is the TTL's job, not the key's. (PR #13)
- **D15 — input drift under contract mode (B2).** With `outputCheck: "contract"`, B2's "the shape hash remains the input-drift signal" is read as: input drift is signalled by the tool schema pin only. The contract check governs output/staleness; it does not itself signal input drift. (PR #13)
- A `report-and-proceed` outcome (B3g) is never cached — only a clean load populates `HydrationCache`. (PR #13)
- Input-only drift is published as a `schema-drift` finding, not `provider-failed` — the two stay distinguishable downstream. (PR #13)
- Split hydration (B3a) serves only *public* findings to the client; full findings (including provider identity) reach only the server-side `onFinding` hook. (PR #13)
- On the split server, `serveHandles` caps concurrent tool calls at 32 **per batch** by default (`DEFAULT_MAX_CONCURRENT_CALLS`); a server-wide bound comes from wrapping the invoker once in `limitInvoker` and sharing it across batches. (PR #13)
- Every op that can place a node (`setPlacement`, `insertNode`, `moveNode`) refuses an off-grid or overflowing result (`placement-outside-grid` / `placement-out-of-range`) rather than accepting it — so a log recorded before this shipped that inserted such a node no longer replays. (PR #14)
- The reference planner clamps `column` on a widening revision rather than refusing it. (PR #14)
- B4's planner `usage` is the sum of attempts that reported a value; an absent report is not treated as zero, and an invalid or overflowing usage value is dropped (with a `usage-invalid` finding) rather than summed. (PR #14)

### 2.3 Stays in genUI (app code)

The HTTP and SSE transport and the `/api/hydrate` wire; message-catalogue loading, i18n extraction and translation; dashboards CRUD, checkpoints, snapshots, share links, comments, experiments, applications, published links, notifications; product governance checks (pin freshness, RBAC feasibility, cost/latency, sensitive-exposure regex, localization); presubmit, approvals and promotions; retiring orphan runs; the embed shells (`genui-page`, `genui-embed-page`, `/api/public/*`); `form` and `controls` as genUI custom kinds; `widget-frame` chrome; the A2UI egress and agent surface; genUI's `Planner` implementation and its prompts.

## 3. 6.1 — the dashboard path

### 3.1 Compose

- `generate-dashboard` runs `GenuiPlanner`, a loom-ui `Planner` built from genUI's current generate prompt, catalogue and plan validation, passing `checkPlannerConformance`.
- The model call is one `ctx.decide`: a replayed generation does not call the model. **Inside the decider the model adapter invokes genUI's existing llm effect through `effectRuntime.invokeTransient`**, so the llm middleware (retry, quota, circuit breaker) still applies; a test asserts quota accounting sees the call. *(Scope corrected, review ruling on Task C2, 2026-09: genUI wires no quota or metering middleware today, so this test can only prove that planner calls traverse genUI's real middleware chain — retry re-drives, and the probe sees `toolId` / signal / label — and that usage maps into `PlanReport.usage` and per-dashboard token usage. It cannot prove quota enforcement, because none exists.)*
- A thrown model call (transient outage, timeout) rejects `GenuiPlanner`'s decision and NOTHING is recorded (review ruling on Task C3, 2026-09): a transient outage is never journaled as a failed plan, so a replay or retry calls the model again. A model that answers with an unusable plan is different: that plan IS recorded, as a failed plan with findings.
- genUI's planner samples its tools inside `compose` (it cannot know arguments before the plan exists); loom-ui's contract permits this because genUI owns the planner. The sample calls are no longer separately recorded steps — they are inside the decision.
- The semantic catalogue is built per owner per call (genUI's per-owner user components); a new user component therefore re-keys compose decisions, which is correct.
- A genUI node that depends on another handle's node becomes a provider whose `executionGraph` inlines the upstream step; B3's in-pass memo keeps the shared upstream call single.
- "Partial success: drop failed widgets" and the clean / retried / partial outcome trace stay genUI policy, fed from `PlanReport`.
- The composed Experience is recorded (`EXPERIENCE_COMPOSED`); genUI's `dashboards` row stores it and its `versionHash`; checkpoints, forks and publishing point at `versionHash`es. genUI adopts `seal` / `mintVersionHash` and `getExperience`'s tamper check.

### 3.2 The dashboard title

loom-ui's compiled title is `intent.objective`, which is inside the hash and immutable (**conflict** with a renamable, localizable dashboard title). The dashboard title stays on the dashboard row; `intent.objective` holds the original generate prompt; genUI's page does not render `Blueprint.title`.

### 3.3 What the browser receives

`GET` a dashboard returns the compiled Blueprint for the viewer's locale, the public handle inventory (handle, priority, overridable params) and the dashboard fields (title, time range, filter catalogue). Providers — tool names, arguments, scripts — never leave the server; a test fails if `executionGraph`, `toolName` or `scriptRef` appear in any browser response or bundle.

**Scope (user ruling, 2026-09-23).** "Any browser response" means every VIEWER-FACING response: the dashboard `GET` (head and checkpoint previews), `/api/hydrate`, share links, public and embed pages, published pages and experiment serves. The dashboard owner's developer view — genUI's `GET /api/dashboards/:id/authoring`, which feeds the execution-plan panel and the remap / A-B tools — is an explicit exemption visible to the dashboard's owner and its editors (anyone with edit rights). A viewer gets 403 with no provider bytes, and public, embed and published pages never carry providers. The privacy test asserts both the exemption (owner 200, editor 200) and its gate (viewer 403, no session 401). The bundle check greps provider content (tool ids, reshaper keys, script source), not field names, because loom-ui's own schemas spell `executionGraph` / `toolName` / `scriptRef`.

### 3.4 Hydration

- Client: B3's split controller with a genUI `HandleLoader` over today's `POST /api/hydrate` body (the `filters` and `controls` journeys assert that body). P2 promotion stays IntersectionObserver-driven through `markVisible`.
- Server: `executeProvider` per requested handle through genUI's `TransientInvoker` wrapper, which injects `__user` and the locale arguments, and applies genUI's granularity rule through B3's argument hook.
- Read-only viewers use `inputDrift: "report-and-proceed"`; only the head triggers repair, through `GenuiPlanner.revise`, which authors a QuickJS script.
- genUI treats any reshape-script throw as drift today; loom-ui reports it as an error. genUI's drift handler keeps the old behaviour by treating `reshape-*` findings on the head as a repair trigger.
- Drift is recorded only for output-caused reshape failures (a script that crashed or hit a limit on the tool's output, loom-ui gap G11), never for infrastructure or transient failures (review ruling, G11, 2026-09).
- SSE stays, for app notifications only (e.g. `drift_repaired`).

### 3.5 Web

- `renderBlueprintDom` with `litRegistry.merge(genuiRegistry)`. genUI's registry wraps every kind in `widget-frame` (title bar, comment pins, filter popover, drag and resize, hidden columns and series projected before delegating to `lu-*`), so the `widget-frame` hooks the e2e journeys and embed counts rely on keep working.
- `form` and `controls` are genUI custom kinds with `KindContract`s.
- Every edit — move, resize, configure, remove, refine — is an Experience operation on the server; the page lands the returned Blueprint with `handle.update`, keeping focus and typed input (slice 6a).
- The time-range picker's event is `lu-time-range` (was `time-range-change`); listeners are renamed.
- The embed bundle (`genui-page.js`) ships `lu-*` and the renderer.

### 3.6 Locale

genUI's message catalogues stay. A bridge drives loom-ui's `setLocale` from genUI's locale switch; labels resolve at compile time, so the server compiles for the requested locale and a switch is a recompile plus `handle.update`. This is a behaviour change covered by the i18n journeys.

### 3.7 TUI

The Ink shell keeps its chrome and its grid, now reading §2.1 placement. Widget bodies come from loom-ui's terminal renderers, including B1's kinds.

### 3.8 Dashboard data migration

A versioned, idempotent script, in one transaction per batch:

1. `PublicLayoutSchema` + manifest → `Experience`: components → `SemanticNode`s under grid containers per view (view title → container `title`); `position` → `span` + placement; `opaqueHandle` → `binding.handle`; `config` → declared props; built-in reshapers → `Named` engine; LLM scripts → content-addressed `QuickJS` `scriptRef`.
2. Node ids are preserved (comment pins, experiment variants and share links key on them).
3. Templates `{{nodes.<id>.output.<path>}}` → `{{steps.<stepId>.output.<path>}}`; cross-handle dependencies inlined.
4. `intent` synthesized once: the dashboard's generate prompt, else its title.
5. Checkpoints re-pointed to the new `versionHash`es.
6. Every converted row must pass `validateExperience` and `compile`; unresolved template references are reported as findings.
7. A dry run against a copy of production data precedes the live run; the old columns are dropped by a separate, later migration, only after the verify step reports every row converted.

**Part G2 not applicable (user ruling, 2026-09-30).** The dry run on a production copy and the live run were not applicable, because there is no deployment. The E/F merge gate (`version_hash IS NULL` = 0) was met trivially.

### 3.9 Tests

Planner conformance; a migration round-trip per stored-row fixture; hydration parity (split load equals in-process load); the provider-privacy test (§3.3); quota accounting through the decider; B2 fixtures with empty and null-varying data; the call-count test for the in-pass memo. e2e specs change only where they select `gx-*` tag names; behaviour assertions stay; `render-truth` guards placement.

## 4. 6.2 — the authoring path

### 4.1 Model

- Renames: `kind: "widget"` → `"semantic"`, `component {name, version}` → `type` / `typeVersion`, `binding.opaqueHandle` → `binding.handle`.
- genUI's operation union maps onto loom-ui's one-to-one; loom-ui adds `setLabel`, and B4 adds `removeProvider` and the layout op.
- `applyOperation` / `foldOperations` → `apply` / `replay`. Scrub, fork and rebase keep genUI's lineage tables over `replay` + `seal` / `mintVersionHash`.
- The three-plane merge moves to B5's `mergeExperiences`, including genUI's localization key-conflict kind.
- Every authoring blueprint gets an `intent`, synthesized once: the ingested document's title or prompt, else the blueprint name.

### 4.2 Flows

Ingest passes the figma / stitch / screenshot / PRD document as `ComposeInput.context` to the same `GenuiPlanner`; refine is `Planner.revise`; apply-operation is the pure `apply`; widget actions go through `interpretAction`, which already refuses `prompt` and `remapProvider` from a widget.

### 4.3 Governance and presubmit

- Provider-graph cycles, dangling `dependsOn` and dangling `{{steps…}}` move to `validateExperience` (B5); binding completeness is already there.
- Pin freshness, RBAC feasibility, cost/latency, the sensitive-exposure regex and localization stay genUI checks, ported to walk `ExperienceNode`.
- **Vocabulary floor (conflict, inverted meaning).** genUI's check asks "can the deployed client render this?"; loom-ui's `checkFloor` asks "must this experience carry these types?". genUI keeps its check, recast over `compile({registry})` renderer-coverage findings; migrated blueprints get `vocabularyFloor: {types: []}`.
- The sensitive-exposure regex may seed the declared `binding.sensitivity`, which loom enforces downstream.

### 4.4 i18n

`MessageLike` in titles and props → `LocalizedText` (labels, and B1's localized props). A bare string becomes `key = text`, genUI's existing keying, so catalogues stay valid. The content-string extractor and data-text translation move to `ExperienceNode`.

### 4.5 Authoring app

The preview canvas compiles and renders through `renderBlueprintDom`; the op panel emits loom-ui operations; presubmit preview runs the same shared checks client-side; a locale switch is a recompile plus `handle.update`.

### 4.6 Authoring data migration (the rehash)

Every `versionHash` changes (`v_<40 hex>` → `sha256:<64 hex>`: normalized root, schema defaults applied, `intent` in the artifact). The script rewrites, in dependency order: `blueprint_versions`, `parents`, `blueprint_lineages` (genesis, head, forkedFrom), `blueprint_operations` (base, result), `presubmit_reports` (their `r_` ids hash a report that embeds the version hash, so they are recomputed), `approvals` and `approval_votes`, `blueprint_promotions`, `authoring_public_links`, and any checkpoint that points at a version. Order keys failing loom-ui's base-62 rule are re-keyed with their order preserved. Scrub's `matchesStored` is re-verified on the new hashes.

**Approvals and promotions carry over** through the old→new map only after the script proves content identity for that version (old → `Experience` → projected back equals the old artifact modulo the documented renames). Each carried approval gets an audit row naming the migration.

### 4.7 Tests

A golden round-trip over every stored-row fixture; `mergeExperiences` against genUI's existing merge cases; the governance checks over `ExperienceNode` with genUI's current cases; scrub on the new hashes; e2e `console-author`, `refine-and-rbac` and the i18n journeys.

## 5. 6.3 — deletion, guards, CI

### 5.1 Deleted

- `packages/shared`: `blueprint.ts`, `layout.ts`, and the `hydration.ts` wire types that duplicate loom-ui. It keeps `api.ts` (the `/api/hydrate` wire), `filters.ts`, governance (now over `ExperienceNode`) and the i18n helpers.
- `packages/ui-sdk`: its hydration pieces are replaced by loom-ui; `GenUIClient`, `DashboardStore` and optimistic local edits move into `apps/web`; the package is removed.
- `packages/widgets-lit`: every `gx-*` element and its registry.
- `packages/renderer-terminal`: replaced by loom-ui's.
- Server: `compose/publicLayout.ts`, `compose/manifest.ts`, `hydrate/transient.ts`, and the old generate / ingest / refine model-call paths. `reshapers.ts` stays as `Named` reshaper registrations.
- The migration scripts stay in migration history; the old tables and columns are dropped by a second, later migration.

### 5.2 Guards

- A genUI fitness test fails if any source defines a schema or type named `Blueprint`, `LayoutNode`, `PublicLayout` or `ExecutionManifest`; if any source defines a `gx-*` custom element; or if `packages/ui-sdk`, `packages/widgets-lit` or `packages/renderer-terminal` reappear.
- Biome `noRestrictedImports` bans the deleted module paths.
- A grep fitness test fails if an e2e spec selects `gx-*`.
- The provider-privacy test (§3.3) runs over the production bundle.
- The guards land in 6.3 together with the deletion; they are never enabled while they would fail.

### 5.3 CI

- genUI gains a `LOOM_UI_REF` pin. The loom commit is **derived** from loom-ui's own `LOOM_REF` at that pin — one source of truth, no second loom pin to drift.
- CI checks out loom, loom-ui and genUI as siblings; genUI's `pnpm.overrides` gain `@loom-ui/*` → `link:` paths into the loom-ui checkout. The existing `LOOM_REPO_TOKEN` is reused for loom-ui if its scope covers the repo (the phase-2 plan verifies this).
- A loom-ui bump is a genUI PR changing `LOOM_UI_REF` and running the full suite: typecheck, lint, i18n check, unit, integration, e2e, `loom doctor`.

## 6. Delivery

| Phase | Work | Repo | Parallel with |
|---|---|---|---|
| 0 | **A**: IR minor bump, both loom renderers, ADR | loom | B1 |
| 0 | **B1** | loom-ui | A |
| 1 | loom-ui bumps `LOOM_REF` to A; `compile` emits placement and title | loom-ui | — |
| 1 | **B2**, then **B3** (same package, serial) | loom-ui | B4 |
| 1 | **B4** | loom-ui | B2 / B3 |
| 2 | **6.1** as several PRs: CI pin + overrides; `GenuiPlanner` + conformance; server storage + hydration; web registry + renderer; TUI; the dashboard migration script, dry-run on a copy of production data first | genUI | B5 (from the web PR on) |
| 3 | **B5** | loom-ui | late 6.1 |
| 4 | **6.2**, including the rehash migration with carried approvals | genUI | — |
| 5 | **6.3** | genUI | — |

One spec (this document); **one implementation plan per phase**, each written after the previous phase merges, against the APIs that actually shipped. Every PR goes through a task review per task, a final whole-branch review, and fix-before-merge.

### 6.1 Risks

| Risk | Guard |
|---|---|
| `ctx.decide` bypasses genUI's llm middleware | model adapter through `invokeTransient`; quota-accounting test |
| providers leak to the browser | provider-privacy test over responses and the bundle |
| healthy data fires the repair loop | B2; empty / null-varying fixtures |
| migration data loss | idempotent, transactional, dry run on a production copy, verify-then-drop in a separate migration |
| latent template bugs become errors | the dry run reports unresolved `{{steps…}}` as findings before cutover |
| two locale runtimes drift | the bridge, covered by the five i18n journeys |
| duplicated upstream tool calls | B3 in-pass memo; call-count test |
| the IR bump (A) is declined in review | none — it is the one external dependency; without it free placement and view titles have no home |

### 6.2 Done

- [x] genUI has no private view model; the §5.2 guards are green. *(genUI 6.3, guards G-A–G-J, PR #213.)*
- [x] genUI's full CI — typecheck, lint, i18n check, unit, integration, all 22 e2e journeys (the suite grew from 18 during 6.2/6.3), `loom doctor` — is green against a pinned loom-ui. *(Local full gate on genUI main; loom-ui pin 7442532.)*
- [ ] Stored dashboards and blueprints are migrated and verified; the old tables are dropped. *(Migrations and the verify-then-drop command `migrate:drop-legacy` shipped in genUI #200/#205/#212; the LIVE drop on production is run by the operator per the genUI README runbook — pending.)*
- [x] loom-ui's `README` names genUI as its first consumer; `2026-09-21-loom-ui-design.md` §10 marks the slice-6 row shipped.

## 7. Non-goals

- A generic loom-ui A2UI egress compile target (genUI keeps its egress; it may generalise later).
- Changing loom's built-in `MetricCard` / `DataTable` / `StatusBadge` contracts.
- Browser transport in loom-ui (the `HandleLoader` is a seam; genUI's HTTP/SSE stays app code).
- Reference-planner reorder / re-type and QuickJS authoring (genUI's planner covers genUI's needs).
- Removing a prop key through `setProps`.
