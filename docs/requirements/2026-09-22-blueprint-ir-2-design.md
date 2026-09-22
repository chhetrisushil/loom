# Blueprint IR 2.0.0 — closing the semantic leaks

**Status:** design, approved in review on 2026-09-22 · **Scope:** loom (`@loom/blueprint-runtime`, `@loom/plugin-renderer-react`, `@loom/plugin-renderer-terminal`) and loom-ui (`core`, `renderer-lit`, `renderer-terminal`) · **Kernel change:** none · **Precedes:** loom-ui slice 6 (genUI migration)

## 0. Decisions this design rests on

Made in review on 2026-09-22, after evaluating the whitepaper *The Experience Runtime: Moving UI Frameworks Below the Semantic Boundary* against loom-ui slices 1–5:

| Question | Decision |
|---|---|
| How does hydration status reach a renderer? | **Loom owns the status contract.** `DataBinding.status?: { path }` resolves, in the same projection state as the value, to a loom-defined `BindingStatus`. Renderers receive `status?`. |
| How does a grid child declare its width? | **Wrapped grid cells.** `GridLayout.children: GridCell[]`, `GridCell { span?: number; node: Widget \| Layout }`. |
| Existing 1.0.0 blueprints | **2.0.0 with a normaliser.** The type is `GridCell[]` only; readers accept a legacy bare child through one `asCell`; writers emit 2.0.0; `Blueprint.irVersion` names the shape. |
| How does a widget say what it stands for? | **`Widget.source?: { type, version, degradedFrom? }`.** Generic wording; never in `props`. |
| What else from the paper rides this bump? | **`DataBinding.sensitivity?: DataClass`** (the field only, enforcement later). |
| Shipping | **Two PRs in order:** loom first, loom-ui second bumping `LOOM_REF`. Then the §7 roadmap: 6a keyed recompose, 6 genUI, 6b scheduling, 6c progressive stages, 7 audience, 8 chat adapter, 9 vocabulary + hints, 10 diff refine — each with a reference example in loom-examples. |

Alternatives rejected: an opaque second status path (leaks loom-ui's shape into every consumer); `Widget.status` as a full second binding (two projection pins per widget); `span` as an optional field on `Widget`/`Layout` (two shapes for one fact); a permanent `Widget | Layout | GridCell` union (two canonical shapes, the leak pattern again); a blueprint-level provenance map (one fact in two places).

## 1. Why

Slices 1–5 built loom-ui as a semantic model compiled to loom's Blueprint. Three times the Blueprint could not carry what the model meant, and each time the meaning went around it:

1. **`span`** rides in `props` as a reserved key (`SPAN_PROP`), declared into every derived catalogue contract. Lit honours it, React ignores it, a nested container's span is dropped with a `span-not-rendered` warning (ADR 0096 D4 called this "visible degradation" and deferred the field).
2. **Hydration status** (`pending | ready | stale | error`) cannot be expressed in a `DataBinding`, so loom-ui's Lit and terminal adapters compute `handleFromPath(binding.path)` and read `state.status[handle]` from the hydration projection behind the Blueprint's back. loom's React renderer shows no status at all.
3. **Degrade provenance** (`Trend@1.0.0 → Collection@1.0.0 → DataTable`) is computed by the compiler and discarded, because no slot exists. No surface can tell a degraded Trend from a native DataTable.

Every leak is one workaround per adapter, visible only to the adapters loom-ui wrote, invisible to loom's own renderers and to any third consumer. The whitepaper predicts exactly this for a lower IR that cannot grow. The fix is to grow it, deliberately, under its version pin.

The paper also distinguishes a mutable experience **model** from one validated **IR** beneath it. loom-ui keeps that split: the Experience is the model planners edit and content addressing pins; the Blueprint is the IR every adapter consumes. After this change an adapter renders everything from the Blueprint alone. That is the "one IR" property.

## 2. The IR at 2.0.0

### 2.1 Types (`@loom/blueprint-runtime`)

```ts
export type BindingState = "pending" | "ready" | "stale" | "error";
export interface BindingStatus {
  state: BindingState;
  /** Monotonic per binding; lets a renderer coalesce out-of-order updates. */
  seq?: number;
  finding?: { code: string; message: string };
}

export interface DataBinding {
  projectionId: string;
  path: string;
  /** Where, in the SAME projection state, this binding's status lives. Absent ⇒ no status channel. */
  status?: { path: string };
  /** `@loom/classify` DataClass. Read by compilers and delivery; never by renderers. */
  sensitivity?: DataClass;
}

export interface WidgetSource {
  type: string;
  version: string;
  /** Outermost first: the semantic types this widget was degraded through to reach `kind`. */
  degradedFrom?: Array<{ type: string; version: string }>;
}

export interface Widget {
  readonly _tag: "Widget";
  id: string;
  kind: string;
  title?: string;
  props: Record<string, unknown>;
  binding?: DataBinding;
  source?: WidgetSource;
}

export interface GridCell {
  /** Columns occupied in the parent grid. Default 1. */
  span?: number;
  node: Widget | Layout;
}
export interface GridLayout { type: "grid"; columns: number; gap?: number; children: GridCell[] }
export interface FlexLayout  { type: "flex"; direction: "row" | "column"; gap?: number; children: Array<Widget | Layout> }
export interface StackLayout { type: "stack"; gap?: number; children: Array<Widget | Layout> }

export interface Blueprint {
  readonly _tag: "Blueprint";
  /** The IR shape this artifact was written in. Absent ⇒ "1.0.0". Writers always set it. */
  irVersion?: string;
  id: string;
  title: string;
  layout: Layout;
  projections: string[];
  projectionVersions?: Readonly<Record<string, string>>;
}

export interface WidgetRendererProps {
  widget: Widget;
  value: unknown;
  status?: BindingStatus;
  onAction?: (action: WidgetAction) => void;
}
```

`WidgetKind` stays eight. `flex` and `stack` are unchanged. `DataClass` is imported as a type from `@loom/classify` (a new dependency of `@loom/blueprint-runtime`; it is type-only).

### 2.2 Version pin

`BLUEPRINT_IR_VERSION = "2.0.0"`. The key-shape manifests gain `GRID_CELL`, `BINDING_STATUS`, `BINDING_STATUS_REF`, `WIDGET_SOURCE`, and the new optional keys on `WIDGET`, `DATA_BINDING`, `BLUEPRINT`; `irVersion.test.ts` gains a second pinned row `["2.0.0", <digest>]` and keeps the 1.0.0 row (never edited). Major, not minor, because `GridLayout.children`'s element type changed.

### 2.3 What is deliberately not here

No semantic kinds (D4 of ADR 0096 stands). No per-child span on flex or stack (they have no columns). No audience on the Blueprint (audience is a property of the surface, resolved by the compiler; §7). No status for widgets without a binding.

## 3. Compatibility

- **Readers accept 1.0.0.** `asCell(child: GridCell | Widget | Layout): GridCell` wraps a bare child with `span: 1`. `traverseBlueprint`, `validateBlueprint`, `collectAllWidgets` and both renderers call it and never branch on the union elsewhere. (`blueprintPins` does not walk the tree at all — it reads `Blueprint.projectionVersions` — so it never sees a grid child and needs no normaliser.) A blueprint without `irVersion` is treated as 1.0.0.
- **Writers emit 2.0.0.** `blueprint$` sets `irVersion: BLUEPRINT_IR_VERSION`. `grid({ columns, children })` accepts `Array<GridCell | Widget | Layout>` and normalises to `GridCell[]`, so `grid({ children: [MetricCard(...)] })` in every example and doc keeps compiling and produces a 2.0.0 artifact. A new builder `cell(span, node)` exists for explicit spans.
- **Explicit upgrade.** `upgradeBlueprint(bp: Blueprint): Blueprint` returns a 2.0.0 artifact (cells wrapped, `irVersion` set), identity on 2.0.0 input. It is what a migration or a `getExperience`-style reader calls when it wants to re-address the artifact; readers do not need it.
- **Content addresses change.** A 1.0.0 artifact re-emitted as 2.0.0 has a different content address; that is a new artifact with the old as parent, exactly as any structural change is. Nothing rewrites stored artifacts.

## 4. Validation (`validateBlueprint`)

New rules, findings not throws, one code per defect class:

| Code | Severity | Condition |
|---|---|---|
| `span-out-of-range` | error | a `GridCell.span` not an integer in `1..columns` of its parent grid |
| `columns-invalid` | error | a grid's `columns` is not a positive integer; that grid's cell spans are then not checked, so one defect yields one finding |
| `malformed-node` | error | a layout child that is neither a `Widget` nor a `Layout` (a stray `null`, a string, a `GridCell` outside a grid); the subtree below it is not walked |
| `status-path-invalid` | error | `binding.status.path` empty or not a dotted path |
| `sensitivity-unknown` | error | `binding.sensitivity` not a `DataClass` value |
| `source-invalid` | error | `source.type`/`version` empty, or a `degradedFrom` entry missing either |
| `ir-version-unknown` | error | `irVersion` present and not one of the pinned versions |

Existing rules are unchanged; `span` is no longer a prop and `undeclared-prop` fires for a literal `props.span` as it would for any undeclared key (loom-ui stops emitting it, §6).

## 5. Traversal and renderers

### 5.0 The rendering runtime layer

The whitepaper names a **Rendering Runtime**: a thin shared contract with a fat implementation per surface. loom has one; this spec names it so the layering is explicit and so no responsibility is left unowned.

- **Shared contract = `@loom/blueprint-runtime`.** The Blueprint IR (this document), `RendererRegistry`, `traverseBlueprint`, `validateBlueprint`, `catalogCoverage`, `BindingStatus` and the canonical status matrix. This is what an app on loom alone renders with, and it is why loom's basic UI exists without loom-ui.
- **Per-surface implementations** = loom's React plugin (eager and fiber), loom's terminal plugin, loom-ui's Lit adapter (`renderBlueprintDom` + `litRegistry`), and later loom-ui's chat adapter. The asymmetry the paper predicts is already visible: React with fiber scheduling is large, terminal is nearly empty.
- **Resolution happens at compile, not at render** — a deliberate difference from the paper. loom-ui's compiler resolves a semantic type to a concrete kind per surface once, and the artifact is content-addressed with that result. Adapters receive concrete kinds and stay deterministic and cheap; the cost is that a surface cannot re-resolve at runtime. Presentation hints (§7, slice 9) are therefore compile-time inputs that change the artifact, never renderer-side switches.

Where each of the paper's rendering-runtime responsibilities lives. **None is deferred**: loom-ui is a framework, so every capability is built first and proven by a reference example in the same slice (§7); "until a consumer asks" is not a status this roadmap uses.

| Responsibility (paper) | Owner | Status |
|---|---|---|
| Patch protocol and versioning | `@loom/blueprint-runtime` (IR 2.0.0, `irVersion`, pins) | this spec |
| Patch application preserving focus, scroll, half-entered input | each surface implementation; Lit first | slice 6a — shipped in loom-ui (`renderBlueprintDom` `handle.update`), design: `2026-09-22-loom-ui-recompose-design.md` |
| Partial and out-of-order streams, every stage renderable | loom-ui compile emits progressive stages; adapters render each | slice 6c |
| Scheduling by semantic priority, coalescing agent bursts | React: fiber mode (exists); Lit: adapter scheduler | slice 6b |
| Resolving semantic type + hint to a component per surface | loom-ui compile (`resolveSurface`), hints as catalogue-declared inputs | exists; hints slice 9 |
| Accessibility semantics → platform APIs | Lit (`a11y.ts`, `describeValue`); React built-ins; terminal n/a | exists; parity asserted in slice 6b |
| Interactions upward as intents, never capability calls | `interpretAction` (loom-ui planner) → loom's authorised effect path | exists (slice 5) |
| Stale vs invalid when the connection drops | `BindingStatus` matrix (stale/error), hydration drift | this spec |
| Capability and identity negotiation | compile-time `renderer-coverage`; surface `audience` | coverage exists; audience slice 7 |

**`traverseBlueprint`** resolves `status` beside `value`: `resolveWidgetStatus(widget, stateMap)` = `resolvePath(state, binding.status.path)` when `binding.status` is set, else `undefined`, validated structurally (a value that is not a `BindingStatus` shape resolves to `undefined` and is not a throw). `renderWidget` receives `{ widget, value, status?, onAction? }`. `ContainerContext` gains the `GridCell[]` so container renderers can read spans.

**Canonical status precedence**, the same on every surface (adopted from loom-ui slice 4's matrix, now loom's): `error` → value renderer never runs, show the finding; `stale` → marker plus the value if present, marker plus "no value" otherwise; `pending` → marker plus the value if present, loading otherwise; no status or `ready` with `value === undefined` → loading; otherwise ready. Kind-level value contracts stay the framework's (loom validates nothing about values); the slot between `error` and `stale` where loom-ui inserts its contract check is a real parameter on both renderers, so the two matrices compose rather than merely being documented as composable: `check?: (widget, value) => { code, message } | undefined` on `TerminalRenderOptions` and on `BlueprintRenderer`/`WidgetFrame` props. It runs only for a widget whose binding DECLARES a status channel and only when `status?.state !== "error"` (a delivery error outranks it — there is no value to check), and a returned finding renders exactly as the error row does, suppressing the widget's own renderer. Returning `undefined` leaves the matrix untouched.

**React (`@loom/plugin-renderer-react`)**, eager and fiber paths alike:
- a grid cell gains a wrapper element carrying `gridColumn: span N` ONLY when `span > 1`; a span-1 cell is emitted directly, so every 1.0.0 grid renders the DOM it always did and each child still reconciles by its widget id;
- a widget with `status` is wrapped in `<div data-binding-state=…>` and, for `pending` and `stale`, a marker element; for `error`, the finding replaces the widget renderer (the widget renderer is still passed `status` so a custom renderer may take over);
- `source` becomes `data-source-type`, `data-source-version`, and `data-degraded="Trend@1.0.0 › Collection@1.0.0"` with a `title` tooltip on the wrapper;
- `WidgetRendererProps.status` reaches every registered renderer; the eight built-ins ignore it (the wrapper handles it).
- Fiber mode subscribes each widget to a selector over `(value, status)` and re-renders on either.

**Terminal (`@loom/plugin-renderer-terminal`)**: `TerminalWidgetRenderer` becomes `(widget, value, status?) => string`; `renderBlueprintToString` applies the matrix with the glyphs `⋯ ` (pending, and the loading row — a declared channel with no value yet, whichever state says so), `~ ` (stale), `✗ ` (error, finding appended); a degraded widget's line ends with ` (degraded from Trend@1.0.0)` on its FIRST line only; spans are ignored. loom-ui's `withStatus` wrapper is retired (§6).

## 6. loom-ui changes (second PR)

- **CI** bumps `LOOM_REF` to the loom merge commit; `pnpm.overrides` unchanged.
- **core/node**: `SemanticNode.binding` gains `sensitivity?: DataClass` (zod enum over `@loom/classify`'s values); operations `bindProvider` gains `sensitivity?`; the artifact hash includes it (structure).
- **core/compile**: emits `GridCell { span: node.span, node }` for every child of a grid container (widgets and nested containers alike) — `span-not-rendered` is deleted; emits `binding.status = { path: statusPath(handle) }` (`status.<handle>`, exported beside `hydrationPath`) and `binding.sensitivity` when set; emits `source = { type, version, degradedFrom: via.map(...) }` from `resolveSurface`'s `via`; stops emitting `SPAN_PROP`; `loomCatalogFor` stops appending `span` to contracts; `SPAN_PROP` and `handleFromPath` are deleted from the public surface (a `hydrationStatusPath`/`handleFromStatusPath` pair replaces the latter for hydration's own use).
- **hydration**: `HandleStatus` is re-exported as loom's `BindingStatus` (structurally identical; hydration's `seq` is required, loom's optional — hydration narrows, never widens); the projection's `status.<handle>` slot is what `binding.status.path` names; no runtime change.
- **renderer-lit**: `renderBlueprintDom` drops `statusProjectionId` and `selectSlice`'s handle lookup; the per-widget selector becomes `(resolveWidgetValue, resolveWidgetStatus)` over the binding's projection; grid cells apply `gridColumn`; `LuWidget` reads `widget.source` for its accessible name ("Trend, shown as a table") and a `data-degraded` attribute. `DomWidgetProps.status` type becomes loom's `BindingStatus`.
- **renderer-terminal**: `withStatus`, `renderExperience`'s status projection option and the framework's glyph code are deleted; `loomUiTerminalRegistry` renderers take `(widget, value, status?)`; `renderExperience` is `renderBlueprintToString` over the store's state map with loom's registry merged; `watch` unchanged.
- **planner**: `describeExperience` emits `sensitivity` when set; `planSchema` admits `binding.sensitivity` from the model only if the catalogue entry declares `sensitivity: "model-may-set"` (default: caller-set only) — a small guard so a model cannot lower a class.
- **Tests**: every slice-4 cross-surface status test moves to assert loom's renderers directly; the parity test gains "React and Lit render the same `data-binding-state` for the same status"; a golden 1.0.0 blueprint fixture renders through `asCell` and `upgradeBlueprint(fixture)` re-addresses it.

## 7. Roadmap — every capability, with its reference example

loom-ui is a framework: each capability is built first and proven by a reference example in the same slice, so consumers have something to copy. Nothing below is deferred "until a consumer asks". Reference examples live in the sibling **loom-examples** repo (decision 2026-09-22), which gains `pnpm.overrides` `link:` entries for `@loom-ui/*` beside its `@loom/*` ones and a CI pin for each sibling.

| Slice | Capability | Where | Reference example (loom-examples) | Proves |
|---|---|---|---|---|
| IR 2.0 (this spec) | grid cells, loom-owned status, source, sensitivity field; both loom renderers | loom, then loom-ui | `blueprint-status` — a plain loom app (no loom-ui) exposing status from its own projection, spans, and source | loom alone gains the channel; the basic UI is enhanced, not taxed |
| 6a | keyed recompose in renderer-lit: diff old/new Blueprint by widget id, patch in place, preserve focus/scroll/half-typed input | loom-ui | `experience-recompose` — an agent revision lands while the user types into a form | "update lands without regeneration" holds for the DOM, not only the artifact |
| 6 | genUI migration: server composes through the planner, web renders via renderer-lit, private Blueprint deleted | genUI | genUI itself (the real consumer) | the framework serves a shipped product |
| 6b | Lit adapter scheduler: semantic render priority, coalescing of agent patch bursts; accessibility parity asserted across React, Lit, terminal | loom-ui | `experience-busy-agent` — a burst of 50 revisions coalesces to what the viewport needs | production behaviour under agent churn |
| 6c | progressive stages: compile emits stages, adapters render each independently, tolerate out-of-order arrival | loom-ui core + adapters | `experience-streaming` — an experience arrives in three stages, each renderable | partial trees never show an invalid screen |
| 7 | surface `audience: "viewer" \| "broadcast"`; compile withholds or redacts bindings whose `sensitivity` exceeds it, with a finding and `source.redacted` | loom-ui core + compile | `experience-broadcast` — one experience rendered per-viewer and for a channel, redaction visible | the identity model is enforced, not declared |
| 8 | chat adapter (Slack Block Kit emitter) as the first broadcast surface, with size-limit degradation | loom-ui `renderer-chat` | `experience-slack` — headless emission of the same experience as a Block Kit payload fixture | the second surface is genuinely different |
| 9 | core vocabulary pack (Metric, Trend, Collection, Entity, Status, Action, Form, Filter, Timeline, Progress) extracted from genUI's catalogue; presentation hints with precedence surface capability › hint › default, degradation recorded in `source` | loom-ui `vocabulary` + core | `experience-vocabulary` — one experience on three surfaces from the core pack, hints honoured or degraded visibly | domain-neutral core, domain packs above it |
| 10 | diff-based refinement in the planner (ops rather than a full node list), measured against slice 6's token cost | loom-ui planner | `planner-refine` — same revision both ways with token counts | refinement cost bounded |

Sequencing: IR 2.0 → 6a → 6 → 6b → 6c → 7 → 8 → 9 → 10. Slice 6 sits early because a shipped consumer is the strongest test of the model; every later slice adds a capability genUI can then adopt.

## 8. Changes in loom, triaged

| Change | Placement | Why not elsewhere |
|---|---|---|
| IR 2.0.0 types, manifests, `asCell`, `upgradeBlueprint`, `cell()`, validation rules, status resolution | 1P `@loom/blueprint-runtime` | the IR is loom's compile target and both loom renderers read it |
| React: spans, status wrapper, source attributes, fiber selector | 1P `@loom/plugin-renderer-react` | loom's basic UI gains the channel too; a loom-ui React renderer would duplicate every widget |
| Terminal: status glyphs, degraded suffix, renderer signature | 1P `@loom/plugin-renderer-terminal` | same |
| ADR 0097, CHANGELOG, `composed-surfaces.md`, `architecture.md`, `api-reference.org`, `plugins.md` | docs | four guards fire on a new ADR (adrIndexDocs, changelogCoverage, docCitations, NOT_A_CAPABILITY) |
| Kernel | none | event schema, syscalls, ABI untouched |

Blast radius: loom-examples (`db-observability`, `saved-views`, and every `grid({children})` call) keeps compiling through the normalising builder; its suite is run before the loom PR merges. loom-plugins and loom-demo do not consume `GridLayout.children` directly (verified by grep before the plan is written).

## 9. Testing

Negative case first at every layer.

| Layer | Asserted |
|---|---|
| IR | digest pinned for 2.0.0 beside 1.0.0; a manifest edit fails the pin; `asCell` on a bare child, a cell, and a nested layout; `upgradeBlueprint` is identity on 2.0.0 and changes the content address of a 1.0.0 fixture |
| validation | one finding per new code; a 1.0.0 fixture with bare children validates clean; `props.span` is `undeclared-prop` |
| traversal | `status` resolved from the same state as `value`; a malformed status resolves to `undefined`, never throws; a widget without `binding.status` gets no status even when the state has one |
| React | grid span → `gridColumn`; the eight-cell status matrix (4 states × value present/absent) on `data-binding-state`; error replaces the renderer; `source` attributes; fiber re-renders on a status-only change |
| terminal | the same eight-cell matrix as glyph lines; degraded suffix; `[kind]` marker unchanged |
| loom-ui compile | golden 2.0.0 blueprint byte-identical across runs; cells for widgets and nested containers; `status.path`, `sensitivity`, `source` present; no `span` in props; passes loom's `validateBlueprint` against the derived catalogue |
| loom-ui adapters | Lit and terminal read status from the Blueprint only (no hydration import in the adapter path — fitness test); parity: same `data-binding-state` on React and Lit for the same state |
| cross-repo | loom-examples suite green against the loom PR; loom-ui CI green at the bumped pin |

## 10. Sequencing

1. loom PR: IR 2.0.0 + renderers + ADR 0097 + docs; loom-examples run against it; rebase-merge on the maintainer's word.
2. loom-ui PR: `LOOM_REF` bump + §6; rebase-merge on the maintainer's word.
3. loom-examples PR: `@loom-ui/*` overrides + CI pin + the `blueprint-status` example.
4. Then the §7 roadmap in order, one slice per PR pair (capability + example).
