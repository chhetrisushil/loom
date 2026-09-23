# loom-ui — a semantic UI framework that compiles to loom's Blueprint

- Status: **Design approved in review, 2026-09-21.** Implementation plan to follow.
- Supersedes in part: the move-out list in
  [the Experience/Rendering Runtime evaluation](2026-09-21-experience-rendering-runtime-evaluation.md) §5.
  That evaluation's placement verdict (separate framework, loom as substrate, kernel change zero)
  stands. Its proposal to move `@loom/blueprint-runtime` and the two renderer plugins out of loom
  is **withdrawn**: the framework compiles *to* loom's Blueprint, so loom's UI is its foundation,
  not its competitor. An addendum to the evaluation records this.
- Evaluates and reshapes: [the AI-Native Experience Runtime and Rendering Runtime TRD](2026-09-21-experience-rendering-runtime.md).
- Consumers: `genUI` (first, by migration), then any loom app that wants a runtime-composed UI.
- Builds on: the [composed-surfaces recipe](../composed-surfaces.md); ADRs
  [0060](../adr/0060-typed-failure-channels.md)–[0066](../adr/0066-transient-effect-invocation-facade.md)
  (transient hydration), [0068](../adr/0068-projection-selector-subscription.md) (selector
  subscription), [0083](../adr/0083-second-consumer-rule.md) (second-consumer rule),
  [0088](../adr/0088-blueprint-conformance.md) (catalogue conformance),
  [0092](../adr/0092-adaptive-operator-profiles-placement.md) (context is a recorded decision),
  [0094](../adr/0094-blueprint-node-identity.md) (node identity),
  [0095](../adr/0095-binding-semantics-pin.md) (binding pins).

---

## 0. Decisions this design rests on

Made in review on 2026-09-21, in this order:

| Question | Decision |
|---|---|
| Loom's basic UI | **Kept.** `blueprint$`, the eight widgets, agent-surface and both renderer plugins remain usable with no framework. |
| Relationship of the framework's model to loom's Blueprint | **Compile target.** Semantic nodes resolve, per surface, to loom widget kinds; the compiler emits a plain loom `Blueprint`; loom's renderers draw it. One vocabulary chain. |
| First consumer | **Extract from genUI, then migrate genUI.** genUI's private Blueprint is deleted at the end. |
| Where the framework lives | **Sibling repo** `../loom-ui`, `@loom-ui/*` scope (working name), consumed via `link:` like loom-plugins and loom-examples. |
| Who owns planning | **Pluggable Planner SPI** with one reference implementation, running on `ctx.decide`. |
| Surfaces in v1 | **Web via loom's React renderer, web via Lit (genUI's widgets as a loom DOM renderer), terminal.** Chat surfaces are declared in the catalogue type but get no renderer work. |

The alternatives considered and rejected: a superset IR with a sidecar (a second half of the
truth that content addressing has to cover), and keeping genUI's Blueprint canonical with a
`toLoomBlueprint` adapter (the path nobody's app runs, so it rots).

## 1. Why this shape

genUI is the one GenUI product on loom past the demo stage. It imports loom's kernel heavily and
loom's durable UI channel (`@loom/agent-surface`, `@loom/plugin-a2ui`), declares
`@loom/blueprint-runtime` and imports nothing from it, and built its own Blueprint, hydration
controller, Lit widgets and terminal renderer. Left alone, that is two vocabularies that never
meet, and loom's basic UI becomes a tier nobody upgrades from.

The three seams line up better than that history suggests:

- Loom's Blueprint is a small stable target: `Widget {id, kind, title, props, binding:
  {projectionId, path}}` in grid/flex/stack layouts, data through `ProjectionRuntime`, and a
  `RendererRegistry<TRenderer>` generic over the renderer type, whose own comment anticipates DOM
  and Angular adapters.
- genUI's Blueprint is already most of the TRD's Experience Model done properly: stable ids with
  fractional ordering, `component: {name, version}`, a `VocabularyFloor`, a provider plane with
  pinned tool-schema hashes, lineage with content hashes and parents, and `Operation`s as the
  merge and replay unit whose `prompt` op carries the primitives it materialised.
- genUI's hydration controller already publishes per-widget state as a slice of one loom
  projection, so a compiled widget can bind to it with loom's own `DataBinding`.

So the framework is the semantic tier above loom's Blueprint, seeded from code that exists.

## 2. Repo and packages

**Repo.** `../loom-ui`, pnpm workspace, loom consumed via `link:` to the sibling checkout plus
pnpm overrides (the one pattern proven on this pnpm version). CI checks loom out with a PAT,
builds it, then builds, typechecks and tests loom-ui against the pinned loom commit, failing
closed if the token is absent.

**Five packages**, one job each, one-way dependencies:

| Package | Job | Seeded from | Depends on |
|---|---|---|---|
| `@loom-ui/core` | Experience Model (semantic node tree, operations, lineage, replay fold, identity); semantic catalogue with per-surface resolution; compiler to a loom `Blueprint`. Pure, isomorphic. | genUI `shared/blueprint.ts`, `layout.ts`, `json.ts`, `governance.ts` | `@loom/blueprint-runtime` (types + validators) |
| `@loom-ui/hydration` | Provider plane execution; `HydrationController`; the hydration projection compiled widgets bind to. | genUI `ui-sdk/HydrationController`, `hydrationProjection`, `shared/hydration.ts` | core, `@loom/projection-runtime`, `@loom/plugin-mcp`, `@loom/plugin-sandbox` |
| `@loom-ui/planner` | Planner SPI, one reference implementation, a conformance kit. | genUI `apps/server/app/compose` | core, `@loom/llm` |
| `@loom-ui/renderer-lit` | A loom DOM renderer adapter (own subpath) and genUI's Lit widgets registered into it. | genUI `widgets-lit` | core, `@loom/blueprint-runtime`, `@loom/projection-runtime` |
| `@loom-ui/renderer-terminal` | Kind-aware string renderers registered into loom's terminal renderer. | genUI `renderer-terminal/renderShape.ts` | `@loom/plugin-renderer-terminal` |

`core` carries model, catalogue and compiler together on purpose: one type graph, all pure, and
package names are loom's real bloat cost. It splits when a consumer needs the catalogue without
the compiler.

**Stays in genUI:** the authoring app, the server, i18n extraction tooling, Postgres setup, and
the three-plane merge.

## 3. Experience Model (`@loom-ui/core`)

### 3.1 Nodes

```ts
type ExperienceNode = ContainerNode | SemanticNode;

interface ContainerNode {
  id: string;            // minted once, never reused
  order: string;         // fractional (LexoRank-style) sibling key
  kind: "container";
  direction: "row" | "column" | "grid";
  span: number;          // 1..12
  gap?: number;
  children: ExperienceNode[];
}

interface SemanticNode {
  id: string;
  order: string;
  kind: "semantic";
  type: string;          // catalogue name, e.g. "Trend"
  typeVersion: string;   // pinned at composition; resolved by (type, typeVersion)
  span: number;
  label?: { key: string; fallback: string };
  props: Record<string, unknown>;
  binding?: { handle: string; priority: "P0" | "P1" | "P2" };
}
```

No visual kind appears in a node.

### 3.2 Artifact

```ts
interface Experience {
  experienceId: string;                 // names a LINEAGE
  versionHash: string;                  // names an ARTIFACT; sha256 via loom's content-address helper; "" until persisted
  parents: string[];                    // 0 genesis, 1 linear, 2+ reserved for merge (out of v1)
  intent: { objective: string; source: "user" | "agent" | "application" | "system"; constraints?: unknown[] };
  root: ExperienceNode;
  providers: Record<string, ProviderSpec>; // by handle; shape in §5
  vocabularyFloor: { minVersion: string; types: Array<{ name: string; version: string }> };
  meta: { author: string; createdAt: string; sourceKind: string }; // NOT hashed
}
```

`experienceArtifact(exp)` is the hashable projection: everything except `versionHash` and `meta`.
`intent` is inside the hash and no operation may change it; a new intent is a new lineage whose
genesis lists the old artifact in `parents`. **Structure revision is the hash. Data has no version
here**; it lives on the hydration projection's sequence (§5).

### 3.3 Operations

```ts
type Operation =
  | { type: "insertNode"; parentId: string; node: ExperienceNode }
  | { type: "removeNode"; nodeId: string }
  | { type: "moveNode"; nodeId: string; newParentId: string; newOrder: string }
  | { type: "setProps"; nodeId: string; patch: Record<string, unknown> }
  | { type: "setLabel"; nodeId: string; label: { key: string; fallback: string } }
  | { type: "bindProvider"; nodeId: string; handle: string; priority?: "P0" | "P1" | "P2" }
  | { type: "remapProvider"; handle: string; spec: ProviderSpec }
  | { type: "prompt"; text: string; scopeNodeIds?: string[]; materialized: Operation[] };

interface Provenance { source: "user" | "agent" | "application" | "system"; agentId?: string; modelId?: string; ref?: string }
interface RecordedOperation { op: Operation; by: Provenance; at: string }
```

- `apply(exp, op)` is pure and total (refuses with a finding, never throws).
- `replay(genesis, ops)` is deterministic: a `prompt` replays its `materialized` primitives and
  never invokes a planner.
- `preservesNodes(before, after)` reports dropped ids (the ADR 0094 question, asked here).
- There is no rebase. An operation applied to an artifact yields a new artifact with the old one
  as parent. Concurrency is a lineage question, not a mutation-protocol question.

### 3.4 Persistence

Composed-surfaces recipe, unchanged. `core` exports `experienceArtifact`, `encode/decode`, and
`putExperience(content, exp) → ContentRef` (subpath `@loom-ui/core/log`, the only part that depends
on `@loom/plugin-content`). The **app**, inside a loom execution, emits the userspace event
`EXPERIENCE_COMPOSED { ref, parents, ops: RecordedOperation[] }`. `core` never touches the log.

## 4. Semantic catalogue and compiler (`@loom-ui/core`)

### 4.1 Catalogue

```ts
type Surface = "web" | "terminal" | "chat";

interface SemanticEntry {
  name: string;
  version: string;
  props: readonly string[];                 // allow-list; [] is a valid answer
  binding: "required" | "optional" | "none";
  surfaces: Partial<Record<Surface, { kind: string } | { degradeTo: string }>>;
}
interface SemanticCatalog { id: string; entries: readonly SemanticEntry[] }
```

Resolution is by `(name, version)` and **per modality, not per renderer**: React and Lit both
register loom kind `MetricCard`, so one `web` compile serves both. `degradeTo` chains resolve
transitively; a cycle or an unresolved end is a finding. `checkFloor(exp, floor)` reports types
the experience dropped that the floor requires.

The catalogue is **extensible at build time and closed at runtime**. A planner may only name
entries; a gap is a finding and a human ships the component.

### 4.2 Compiler

```ts
compile(exp: Experience, opts: {
  surface: Surface;
  catalog: SemanticCatalog;
  hydrationProjectionId: string;
  hydrationProjectionVersion: string;
  resolveLabel?: (label: { key: string; fallback: string }) => string; // default: fallback
}): { blueprint: Blueprint; findings: Finding[] }
```

Pure; same inputs, byte-identical output. Never throws.

| Experience | Loom Blueprint |
|---|---|
| container `row` / `column` / `grid` | `flex` row / `flex` column / `grid` |
| semantic node | `Widget` with `id = node.id`, `kind` = resolved surface kind, `title = resolveLabel(label)`, `props = node.props` (+ `span`, see below) |
| `binding.handle` | `binding: { projectionId: hydrationProjectionId, path: "values.<handle>" }` |
| — | `blueprint.id = "<experienceId>@<versionHash>"`, `projections: [hydrationProjectionId]`, `projectionVersions: { [hydrationProjectionId]: hydrationProjectionVersion }` |

Priority is not compiled; the hydration controller reads it from the experience. Semantic metadata
is **not** smuggled into `props` (loom's catalogue check would flag it); the experience is the
source of truth and the widget id is the join key back to it.

**Two validators, in order.** `validateExperience(exp, catalog, surface)` reports `unknown-type`,
`undeclared-prop`, `missing-binding`, `text-prop-shape`, `floor-violation`, `duplicate-node-id`,
`unresolvable-on-surface`. Then loom's `validateBlueprint` and `catalogCoverage` run on the output,
so a compiler defect that emits an off-catalogue kind is caught by loom's check rather than trusted.

> **`text-prop-shape`** — a declared text prop (`SemanticEntry.textProps`) holds something other than a string or `LocalizedText`. *(Added loom-ui slice 6 phase 0, 2026-09-23.)*

**Known degradation.** Per-child grid `span` has no field in loom's layouts. It is emitted as
`props.span`; the Lit renderer honours it, loom's React grid ignores it (equal columns). Visible,
not silent; the first candidate for an additive loom change (§8).

## 5. Hydration (`@loom-ui/hydration`)

`ProviderSpec` is genUI's shape unchanged: an execution graph of MCP tool nodes each pinning
`toolSchemaHash`, a reshaping step (`JSONPath` or a content-addressed QuickJS `scriptRef`), an
`outputShapeHash`, and `cachePolicy { ttlSeconds, scope: "principal" | "global" }`.

**The read path emits nothing.** Each graph runs through loom's `invokeTransient`; reshaping runs
in `@loom/plugin-sandbox`; output is checked against `outputShapeHash`. Rendering a persisted
experience is a cache lookup plus these calls — no model, no log writes.

**Projection shape** (declared `version`, pinned by the compiler):

```ts
interface HydrationState {
  values: Record<string, unknown>;                                   // by handle — what widgets bind to
  status: Record<string, { state: "pending" | "ready" | "stale" | "error"; seq: number; finding?: Finding }>;
}
```

**Scheduling.** Handles deduplicated across nodes; ordered P0 → P1 → P2; collected in a batching
window (50 ms, genUI's value) before dispatch; a recompose cancels in-flight loads for handles no
node binds. Clock and invoker are injected, so scheduling is testable deterministically.

**Crossing the determinism boundary.** A live tool whose canonical schema hash differs from the
pin is never guessed at: the handle becomes `stale` with a finding, and a durable loom execution
records `SCHEMA_REPAIRED` and produces a `remapProvider` operation → a new artifact.

**Per viewer.** Hydration runs per principal against a shared artifact. The blueprint carries
bindings, never values, so sharing an experience never shares a viewer's data.

**Not in v1.** Transport of projection state to a browser stays app code (genUI's SSE).

## 6. Renderers

**Web / React — nothing to build.** Compiled Blueprint + hydration projection → loom's
`BlueprintRenderer`. The app runs `catalogCoverage` against its React registry at startup so a
missing kind is a startup failure, not a per-viewer placeholder. `WidgetAction.widgetId` is the
node id.

**Web / Lit — `@loom-ui/renderer-lit`.** Two parts behind two subpaths:

- `/dom`: `renderBlueprintDom(blueprint, projectionRuntime, executionId, { registry, onAction })`
  on `traverseBlueprint`, one `subscribeSelector` per widget so one handle resolving re-renders one
  widget. `type DomWidgetRenderer = (host: HTMLElement, props: WidgetRendererProps) => { update(value: unknown): void; dispose(): void }`.
  This is the DOM adapter loom's `RendererRegistry` comment anticipates; promotable to a loom
  plugin when a non-Lit consumer appears.
- root: genUI's Lit widgets registered under loom kinds — `MetricCard`, `DataTable`, `StatusBadge`
  where React has them, `TimeSeries`, `BarChart` where it does not — with a11y, RTL and tooltip
  helpers.

**Parity is a test.** Every `web` kind the semantic catalogue resolves to must be covered by both
the React and the Lit registries. Adding a Lit-only kind fails the suite.

**Terminal — `@loom-ui/renderer-terminal` + one loom change.** Loom's `renderBlueprintToString` /
`TerminalRenderer` gain an optional registry of `(widget, value) => string` renderers with an
explicit `[kind]` marker for unregistered kinds (§8). This package registers genUI's shape
renderers (sparklines, tables). Loom's terminal renderer then covers its own catalogue — ADR 0088's
second direction.

**Chat.** Declared in `Surface`, no renderer work in v1. When it comes: compile to Blueprint,
project through `@loom/plugin-a2ui` / `@loom/plugin-mcp-app`. Not a new renderer.

**Locale and theme are inputs, not mutations.** A locale change re-runs `compile` with another
`resolveLabel`. Nothing is appended.

## 7. Planner SPI and interaction model

### 7.1 Planner (`@loom-ui/planner`)

```ts
interface Planner {
  compose(input: { intent: Experience["intent"]; catalog: SemanticCatalog; capabilities: CapabilityRef[]; context?: unknown }, ctx: FlowContext): Promise<PlanResult>;
  revise(input: { experience: Experience; request: { text: string; scopeNodeIds?: string[] } }, ctx: FlowContext): Promise<PlanResult>;
}
interface PlanResult { ops: Operation[]; findings: Finding[] }
```

- **A planner produces operations, never an experience.** `compose` returns ops against an empty
  genesis; `revise` returns one `prompt` op whose `materialized` holds the primitives. The core
  fold mints the artifact.
- **The model call is a decision.** A planner runs inside a loom execution and reaches the model
  via `ctx.decide`, so its output is `DECISION_RECORDED` with model, policy and context. Replay
  serves the recorded ops; the model is never re-called. This is the TRD §47 SHOULD made MUST.
- **Reference implementation** (from genUI's compose): output constrained to a JSON schema derived
  from the catalogue (declared types, allow-listed props, given capability handles only);
  `ProviderSpec`s built with the tool schema hash pinned at plan time; `validateExperience` on the
  result with findings fed back for a bounded retry count; first-attempt validation rate reported.
- **Context is an input, never a lookup.** Profiles and viewer context arrive resolved and
  recorded by the caller (ADR 0092). The framework fetches nothing.
- **Conformance kit.** Any planner must hold: every returned op validates against the catalogue;
  a `prompt` op's `materialized` replays to the same artifact. The SPI stays at two methods until
  a second planner exists.

### 7.2 Interactions — two authorization domains

`interpretAction(exp, action: WidgetAction): { kind: "experience"; op: Operation } | { kind: "business"; action: unknown }`

- **Experience operations** (structural) are authorized by the app's own policy on who may edit
  the lineage.
- **Business actions** are handed to loom's ordinary effect path — K2 grants and ADR 0084 effect
  classes apply. The framework authorizes nothing here. Being allowed to rearrange a view never
  implies being allowed to run what it shows.

### 7.3 Proposals are lineage

An agent's ops always yield a new artifact with the current one as parent. Whether it is shown is
a separate app-level `EXPERIENCE_PROMOTED { ref }` event. Low-risk changes promote automatically;
high-impact ones wait on loom's suspend/resume gate. Fork, simulate, promote — applied to a view.

## 8. Changes in loom

**Unchanged:** `@loom/blueprint-runtime` (stays, in loom, as the basic tier and the compile target);
`plugin-renderer-react`; `agent-surface`; `plugin-a2ui`; `plugin-mcp-app`; `subscribeSelector`;
`KERNEL_ABI`; `EVENT_SCHEMA`. No semantic kinds join `WidgetKind`.

**Three first-party changes:**

1. **Blueprint becomes a declared contract.** `BLUEPRINT_IR_VERSION` beside the type; a fitness
   test that fails when `Widget`, `Layout` or `Blueprint` change shape without a bump; an ADR
   recording the Blueprint as loom's stable rendering IR. The MemoryStore-SPI discipline applied to
   the one loom type an external framework now targets.
2. **Kind-aware terminal rendering.** Optional string-renderer registry on `renderBlueprintToString`
   and `TerminalRenderer`; explicit `[kind]` marker for unregistered kinds. Justified by loom's own
   recorded defect (Part II G5, ADR 0088 D1), not by a consumer request.
3. **Docs pointers.** A section in the composed-surfaces recipe on compiling to a Blueprint from a
   semantic model; the user guide names the framework as the enhanced tier; an addendum to the
   2026-09-21 evaluation withdrawing its move-out list.

**Deferred, gate stated:**

- Per-child grid `span` on loom layouts — promoted only if a React consumer of the framework needs it.
- The log-conformance kit proposed in the evaluation — the framework's replay tests cover the
  property for its one consumer; a loom-side kit waits for a second artifact-composing framework.

## 9. Testing

Negative case first, at every layer — declared and enforced look identical in a green suite.

| Layer | Asserted |
|---|---|
| core / model | replay reproduces the artifact hash; `prompt` replays without a planner present; an op touching `intent` is refused; `preservesNodes` reports a dropped id |
| core / compile | golden Blueprints per surface, byte-identical across runs; one finding per defect class incl. `unresolvable-on-surface` and `floor-violation`; output passes loom's `validateBlueprint`, and a deliberately broken catalogue entry makes it fail |
| hydration | fake clock + invoker: priority order, dedupe, batching window, cancellation on recompose; drifted schema hash → `stale` + finding, never a value; principal-scoped cache never crosses principals |
| planner | conformance kit against the reference planner on a scripted model; validation rate computed from findings, not exceptions |
| renderers | React ∩ Lit registries ⊇ catalogue web kinds; Lit adapter (jsdom) re-renders one widget on one handle; terminal golden shows `[kind]` for an unregistered kind |
| cross-repo | CI builds the pinned loom first and `tsc`-typechecks loom-ui against built `.d.ts` (vitest misses rotted imports; only `tsc` catches them) |
| end to end | TRD §63 with a scripted planner: intent → artifact → compile → React render → agent revision adds an Insight → new artifact where only the new node's id is new → recompile → the same artifact renders to terminal |

## 10. Sequencing

Seven slices, each a PR with its negative tests, in dependency order:

1. **loom:** `BLUEPRINT_IR_VERSION` + shape fitness test + ADR; kind-aware terminal registry; evaluation addendum.
2. **loom-ui:** repo scaffold + `core` (model, fold, catalogue, compiler), extracted from genUI `shared`.
3. **loom-ui:** `hydration`.
4. **loom-ui:** `renderer-lit` + `renderer-terminal` + parity tests.
5. **loom-ui:** `planner` SPI + reference + conformance kit.
6. **genUI:** migrate — server composes through loom-ui; web renders a compiled Blueprint via `renderer-lit`; private Blueprint deleted. **Until this lands the framework has no consumer; it is not optional.**
7. **loom:** docs pointers.

## 11. Out of scope for v1

Angular, Flutter, native, Slack and Teams renderers; chat renderer work; three-plane merge and
experience branches beyond `parents`; speculative rendering and prefetching; collaborative or
distributed experience state; browser transport for projection state; per-child `span` in loom
layouts; a loom-side log-conformance kit. Each has its gate named above or in the TRD evaluation.
