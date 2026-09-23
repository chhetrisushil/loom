# Recipe — the composed surface as a logged artifact

**When to use.** A model assembles a UI at runtime — a dashboard from a
question, a review surface per proposal, a panel added to a view already open —
and that surface has to survive the moment it was made: pinned, shared, re-run
tomorrow, or produced in a postmortem as *the thing the human was looking at
when they approved this*.

**The rule.** *Composition is an event; rendering is a replay.* Generation
happens once, at the moment of intent. What is recorded is the **composed
artifact**, and every render afterwards replays it. No model sits in the render
path, so a pinned view never waits on generation and never quietly means
something different than it did yesterday.

**No new primitive is needed, and none should be added.** Three separate product
designs reached for this construction and each assumed it required platform
support; it does not. It is four things Loom already has, in a particular order.
This page is that order.

## Why it is not the obvious thing

Loom's two composition models make the **structure static and the data dynamic**:
a [`Blueprint`](../packages/blueprint-runtime) is a value the app authors, and
`SURFACE_PATCH` streams data into it — the patch ops (`set`/`merge`/`append`/
`remove`/`increment`) address *values*, and there is no structural op.

GenUI inverts that. The thing composed at runtime **is the structure**, so the
structure is what needs a durable identity. The two wrong turns are equally
tempting: put the blueprint in surface state (it is then data the client binds
to, and it grows every render), or ask for a kernel event kind (there is nothing
for the fold to do with it).

## Shape

```ts
import {
  MetricCard,
  blueprint$,
  builtinCatalog,
  checkBlueprintPins,
  stack,
  validateBlueprint,
} from "@loom/blueprint-runtime";
import type { Blueprint } from "@loom/blueprint-runtime";
import { decodeValue, encodeValue } from "@loom/plugin-content";
import type { ContentRef, ContentStore } from "@loom/plugin-content";

const BLUEPRINT_COMPOSED = "BLUEPRINT_COMPOSED";

// 1. COMPOSE — once, at the moment of intent. A model picks catalogue entries;
//    the app builds the widgets. The model never names a `kind` directly.
async function compose(
  ctx: { emit: (t: string, p: unknown) => void },
  content: ContentStore,
  // What every projection this view binds to MEANT right now: `projectionRuntime.pins()`.
  pins: Record<string, string>
) {
  const view = blueprint$({
    id: "checkout-triage",
    title: "Checkout triage",
    layout: stack({
      children: [
        // An explicit id: this node must stay identifiable across a revision.
        MetricCard({
          id: "p99",
          title: "p99 latency",
          binding: { projectionId: "latency", path: "p99" },
          unit: "ms",
        }),
      ],
    }),
    projections: ["latency", "deploys"],
    // The binding above freezes a NAME. This freezes what that name meant, and because it
    // is a field of the value it is part of the content address (ADR 0095).
    projectionVersions: pins,
  });

  // 2. VALIDATE BEFORE YOU RECORD. An off-catalogue component that reaches the
  //    log is durable: every replay reproduces it. This is the last point at
  //    which it is still a findings list rather than a fact.
  const report = validateBlueprint(view, builtinCatalog);
  if (!report.ok) return { degraded: report }; // degrade + record the gap; never throw a surface away

  // 3. STORE THE BYTES, LOG THE REFERENCE. The address is `sha256(bytes)`, so
  //    it *is* the semantic identity — "the view I was looking at" becomes a
  //    precise statement, and two identical compositions collapse to one blob.
  const ref = await content.put(encodeValue(view));

  // 4. EMIT. `BLUEPRINT_COMPOSED` is a USERSPACE domain event: the fold skips
  //    unknown types while still advancing `sequence`, so this costs no
  //    EVENT_SCHEMA change and no kernel change. The log stays small — it holds
  //    a 60-byte address, not a component tree.
  ctx.emit(BLUEPRINT_COMPOSED, { ref, catalogId: builtinCatalog.id, intent: "checkout latency" });
  return { ref };
}

// 5. RENDER — a read, not a generation. Resolve the ref, hydrate the bindings
//    against THIS viewer, draw. Nothing here can produce a different structure
//    than the one that was recorded.
async function render(ref: ContentRef, content: ContentStore, pins: Record<string, string>) {
  const bytes = await content.get(ref);
  if (!bytes) throw new Error(`blueprint ${ref.__loomContent} is gone — see "Pin it" below`);
  const view = decodeValue(bytes) as Blueprint;

  // 6. CHECK THE PIN. The structure is identical to the one that was promoted; whether it
  //    still MEANS the same thing is a different question, and this is the one place it can
  //    be asked. Findings, never a throw — a drift may be a deliberate re-promotion.
  const pinned = checkBlueprintPins(view, pins);
  return { view, pinned };
}
```

The hot read path underneath — fetching each binding's data — is the
[transient manifest interpreter](transient-interpreter.md): plain code over an
immutable plan, zero events, escalating to a durable run only when a schema pin
drifts and the repair must be recorded.

## What the log holds, and what it does not

| | Where | Why |
|---|---|---|
| The composed structure | ContentStore, by `sha256:` address | Content-addressed, so replay reproduces the same address and identical views dedup ([ADR 0046](adr/0046-content-store-seam-thin-authoritative-log.md)) |
| The reference + intent + catalogue id | The log, in `BLUEPRINT_COMPOSED` | Small, ordered, replayable. `claimCheckMiddleware` ([ADR 0054](adr/0054-claim-check-middleware.md)) does the same job automatically for large effect payloads |
| Fetched rows, metrics, names | **Nowhere durable** | A blueprint declares what to fetch, never what was fetched — that is what lets one artifact be shared and hydrated separately against each viewer's permissions. `validateBlueprint`'s `undeclared-prop` is the check ([ADR 0088](adr/0088-blueprint-conformance.md)) |
| What each binding *meant* | Inside the blueprint, as `projectionVersions` | A binding freezes the projection's NAME; the fold behind that name is live code with no version, so the meaning has to be pinned separately — and inside the value, so it is inside the address ([ADR 0095](adr/0095-binding-semantics-pin.md)) |
| Who placed which node | The log, as `SURFACE_PATCH.by` | Ordered events, so *"which patch last wrote this path"* is a projection — `surfaceProvenanceProjection` / `provenanceOf` — not a second store |

## Pin it, or retention will reclaim it

This is the failure this recipe exists to prevent, and it does not show up until
production: the log keeps a reference forever, content GC does not know the
reference matters, and the artifact behind a pinned view disappears.

Name the event kind as a pin ([ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md)):

```ts
import { sweepUnpinnedContent } from "@loom/plugin-content";

await sweepUnpinnedContent({
  eventStores: [eventStore],
  contentStore,
  pinnedEventTypes: ["BLUEPRINT_COMPOSED"], // ← the artifact outlives ordinary sweeps
  olderThanMs: 30 * 24 * 60 * 60 * 1000,
  now: Date.now(),
});
```

## Freezing meaning without freezing implementation

A promoted view must **not** freeze its whole implementation — a component
security patch or an accessibility fix could then never reach it, and every
pinned surface would become an unpatchable liability. The property to hold is
narrower and stronger:

> The meaning of a view never changes silently.

Loom has already solved the isomorphic problem for code. `EXECUTION_STARTED`
folds a `flowHash`; replaying against changed code raises `FlowCodeMismatchError`
rather than producing a plausible wrong answer; and K11.5 `resumeAs`
([ADR 0056](adr/0056-k11-5-state-migration-on-resume.md)) is contract-versioned
migration of a pinned artifact whose dependencies moved. The replay inspector's
`pinOf()` additionally names the case such designs always miss —
`unpinned-legacy`, where there is no pin at all, and where showing a blank or
inferring the current version is exactly the silent fallback the pin exists to
prevent.

Apply the same split. **Frozen** (part of the address): intent, layout, node
identity, the binding *names*, the versions those names were pinned at, and the
catalogue id. **Floating**: component implementations, patched under
[`catalogCoverage`](adr/0088-blueprint-conformance.md). **Always current, never
pinned**: policy and IAM at render.

A binding is `{ projectionId, path }`, so freezing it freezes a **name**. The
projection behind that name is live code — and the query, the filter predicates,
the join keys, the aggregation and the window all live there, on the *floating*
side. Rolling-versus-fixed is not expressible in a `DataBinding` at all. Edit the
fold and every pinned view bound to it means something else under an unchanged
hash, which is the one failure this page exists to prevent, so the meaning is
pinned by **declaration** ([ADR 0095](adr/0095-binding-semantics-pin.md)):

```ts
projection$({ id: "latency", name: "Latency", version: "3", initialState, handlers });
```

A binding may separately declare `status: { path }` in that same projection — a place, in the
same state a value already resolves from, where the binding's delivery state
(`pending`/`ready`/`stale`/`error`/`empty`) is written. Loom's own renderers read it and show the
matching pending/stale/error marker; a binding that declares nothing renders exactly as it did
before the channel existed ([ADR 0097](adr/0097-blueprint-ir-2.md)). `empty` means the upstream
answered with nothing to show — the widget renders `○ <title>: no data`, which is not an error
and triggers nothing ([ADR 0100](adr/0100-blueprint-ir-empty-binding-state.md)).

A grid cell may also be *placed* — `cell(span, node, { row, column, rowSpan })` — and any layout
may carry a `title`, a section heading; an artifact that uses neither renders as it always did
([ADR 0098](adr/0098-blueprint-ir-placement-and-titles.md)). Cross-renderer reading order is
guaranteed only when every cell of a grid has both `row` and `column`, or none has any placement:
a *partially* placed grid is auto-placed by CSS in React (the unplaced/partial cells fall to CSS
grid's sparse auto-placement, which drops each into the next free slot at or after an
auto-placement cursor that only ever advances) and sorted with absent coordinates last in the
terminal, and the two can disagree about where those cells land.

A layout may also carry a `role` — what the container is to a renderer that has one registered
for it (`"stepped"`, `"tabbed"`), the way `kind` is for a widget. loom's own renderers ignore
it and draw the plain container ([ADR 0099](adr/0099-blueprint-ir-layout-roles.md)).

A layout may also carry an `id` — the same rule as a widget's, in the same namespace
(`duplicate-node-id` catches a layout sharing a widget's id). A renderer that reconciles keys the
container by it, so a section inserted above or reordered around it keeps the state of the
widgets inside it; `preservesBlueprintNodes` compares layout ids with widget ids, so a container
that was re-identified is reported as dropped. Without an id a container is keyed by position,
as before ([ADR 0101](adr/0101-blueprint-ir-layout-ids.md)).

`projectionRuntime.pins()` is what a composer records into
`Blueprint.projectionVersions`; `checkBlueprintPins(view, pins)` is what a render
compares it against, reporting `drift` when the fold behind a name changed and
`unpinned` when one side declared nothing — because two sides that declared
nothing must not read as a verified match. Bump the version when the fold's
*meaning* changes; a refactor producing identical state is not a new version.
The pin is a declaration, not a proof: an author who edits a fold without
bumping it still lies, and the value of the mechanism is that the honest case
becomes checkable and the dishonest one becomes a review question.

The same declaration works one layer down, on the derived rows a view may read:
`ReadModelDefinition.version` + `ReadModelService.checkPins(recorded)`, where an
edited `extract` is worse than a drifted chart — the old rows stay, the watermark
is already past them, and one query answers from two extractors until someone
runs `rebuild()`.

Two consequences worth stating out loud:

- Supply an explicit `id` on every widget a composer may later revise. The
  derived id is a hash of kind + props, so editing any prop *re-identifies* the
  node — remounting it and breaking any pin, annotation, or agent reference
  keyed on it.
- The same applies **across** compositions, not just along one lineage. If two
  separately generated trees are meant to share a node — the same panel in a
  novice and an expert arrangement, a "floor" every variant must contain — the
  derived id makes them the same node only while their props stay
  byte-identical. Vary a title or a density and the two trees quietly stop
  agreeing about what the node *is*, so anything keyed on it (a pin, a runbook
  step, a recorded operation) resolves in one tree and dangles in the other.
  A set of nodes that must survive every variant is a set of nodes with
  explicit ids ([ADR 0092](adr/0092-adaptive-operator-profiles-placement.md) D5).
  `preservesNodes(before, after)` is how you find out you got it wrong: it reports
  the ids a change dropped, over either two blueprints or the floor's ids against
  a variant's ([ADR 0094](adr/0094-blueprint-node-identity.md)). On the A2UI egress
  path the same question is `bridge.identityDiff(next)` — which components a
  recompose would unmount — asked before committing to the new tree.
- A component change that alters what a view *means* is not an upgrade; it is a
  new component version, and migrating to it is a re-composition — a second
  `BLUEPRINT_COMPOSED`, visible and revertible — not an edit in place.

## Recomposing an open surface

Adding a panel beside an existing one is a **structural** update, not a data
patch. On the A2UI egress path that is `A2UISurfaceBridge.recompose(components)`
→ `updateComponents`, validated against the declared catalogue on the way out
([ADR 0088](adr/0088-blueprint-conformance.md)). Record the new artifact the same
way: recomposition is composition, so it is another event, not a mutation of the
one before it.

## What not to do

- **Do not put the blueprint in surface state.** It becomes data the client
  binds to, it re-enters the fold on every change, and provenance and structure
  end up in the same tree. `by` on the patch payload exists so provenance does
  *not* have to live in the data model.
- **Do not ask for a kernel event kind.** The fold has nothing to do with a
  blueprint. `ctx.emit` writes an arbitrary type that `foldEvents` skips, which
  is the whole mechanism (P10).
- **Do not cache the composition to skip reasoning.** Replaying a recorded
  *decision* (`ctx.decide` → `DECISION_RECORDED`) makes the same run reproducible;
  reusing a stored plan to make a *different* run cheaper is a plan cache, and it
  was rejected in the [Execution OS evaluation](requirements/2026-07-10-execution-operating-system-evaluation.md).
  Different property, different guarantee.
- **Do not serialize a reactive graph to resume a UI.** That is a second,
  non-logged source of truth — in-memory and lossy on exactly the crash it claims
  to survive. [ADR 0067](adr/0067-reactive-graph-resumability-rejected.md).
- **Do not let a composer synthesize components.** Accessibility, i18n and design
  conformance are properties of *individual outputs*, so a vocabulary that is
  open at runtime cannot be audited at all. The catalogue is closed, a gap is
  logged, and a human ships the component.

## The example

`saved-views` (loom-examples) is this page as running code: compose → validate → `put` →
`BLUEPRINT_COMPOSED` → sweep → re-open, with a deploy in the middle that moves the fold behind
one binding from a rolling week to a calendar month. Every claim above is an assertion in its
suite, including the two that are only visible as negatives — an off-catalogue component
reaching neither the store nor the log, and a pre-pin artifact reporting `compared: 0` rather
than a clean pass.

## See also

[Transient manifest interpreter](transient-interpreter.md) · the composed-surface
checks in [ADR 0088](adr/0088-blueprint-conformance.md) · content addressing
[ADR 0046](adr/0046-content-store-seam-thin-authoritative-log.md) · claim-check
[ADR 0054](adr/0054-claim-check-middleware.md) · content pinning
[ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md) · the portfolio evaluation's
[Part II](requirements/2026-09-01-product-portfolio-evaluation.md) that this recipe closes.
