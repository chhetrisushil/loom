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
import { MetricCard, blueprint$, builtinCatalog, stack, validateBlueprint } from "@loom/blueprint-runtime";
import { decodeValue, encodeValue } from "@loom/plugin-content";
import type { ContentRef, ContentStore } from "@loom/plugin-content";

const BLUEPRINT_COMPOSED = "BLUEPRINT_COMPOSED";

// 1. COMPOSE — once, at the moment of intent. A model picks catalogue entries;
//    the app builds the widgets. The model never names a `kind` directly.
async function compose(ctx: { emit: (t: string, p: unknown) => void }, content: ContentStore) {
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
async function render(ref: ContentRef, content: ContentStore) {
  const bytes = await content.get(ref);
  if (!bytes) throw new Error(`blueprint ${ref.__loomContent} is gone — see "Pin it" below`);
  return decodeValue(bytes);
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
identity, bindings, and the catalogue id. **Floating**: component
implementations, patched under [`catalogCoverage`](adr/0088-blueprint-conformance.md).
**Always current, never pinned**: policy and IAM at render.

Two consequences worth stating out loud:

- Supply an explicit `id` on every widget a composer may later revise. The
  derived id is a hash of kind + props, so editing any prop *re-identifies* the
  node — remounting it and breaking any pin, annotation, or agent reference
  keyed on it.
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

## See also

[Transient manifest interpreter](transient-interpreter.md) · the composed-surface
checks in [ADR 0088](adr/0088-blueprint-conformance.md) · content addressing
[ADR 0046](adr/0046-content-store-seam-thin-authoritative-log.md) · claim-check
[ADR 0054](adr/0054-claim-check-middleware.md) · content pinning
[ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md) · the portfolio evaluation's
[Part II](requirements/2026-09-01-product-portfolio-evaluation.md) that this recipe closes.
