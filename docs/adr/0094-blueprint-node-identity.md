# ADR 0094 — Node identity across a structural change

- Status: **Accepted — implemented** (2026-09-10)
- Date: 2026-09-10
- Implements: the item [ADR 0092](0092-adaptive-operator-profiles-placement.md) D5 gated on a
  second consumer. **The gate is satisfied, not waived** — see D3.
- Builds on: [ADR 0088](0088-blueprint-conformance.md) (findings-not-throws, and the denominator),
  [ADR 0083](0083-second-consumer-rule.md) (the outward gate),
  [ADR 0070](0070-a2ui-callfunction-bidirectional-rpc.md) / the a2ui bridge's `recompose`.
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** Pure functions over
  JSON-serializable values, in an existing package.

## Context

A widget's `id` is derived by default — `stableId` hashes kind + props — so a node keeps its
identity only while its props stay byte-identical. `widgets.ts` has said so since it was written,
and `docs/composed-surfaces.md` tells a composer's author to supply explicit ids. Neither is a
check, and the failure is silent in both directions that matter:

- **Revision.** A composer re-emits a view with one prop edited. To every consumer the edited
  node is a *different* node: it remounts, and any pin, annotation, or agent reference keyed on
  the old id dangles.
- **Variants.** Two trees generated separately are meant to share a set of nodes — the floor a
  cohort's blueprint must contain, the panel a runbook step names. Vary a title between them and
  the two trees quietly stop agreeing about what the node is.

`validateBlueprint` checks one tree, including ids *within* it (`duplicate-node-id`). Nothing
compared one tree to another, which is where identity is actually lost.

## Decisions

### D1 — One question, asked over id sets

```ts
preservesNodes(before: Iterable<string>, after: Iterable<string>): IdentityReport
```

Both failures above reduce to *which ids did this change drop?*, so this is one function, and it
takes **id sets rather than blueprints** — which is what lets the second consumer be A2UI, whose
components are a flat list and not a `Blueprint`. `blueprintNodeIds` and
`preservesBlueprintNodes` spell the blueprint case.

The same call answers the floor question with the arguments swapped in meaning: pass the floor's
ids as `before`, and any finding is a floor violation while everything above the floor lands in
`added` — a variant may add, never subtract.

### D2 — It reports, and `added` is data rather than a defect

Dropping a node is legitimate (a subtree genuinely being replaced) and illegitimate (a
re-identification nobody intended), and neither the blueprint nor the bridge can tell them apart.
So: findings, never a throw — [ADR 0088](0088-blueprint-conformance.md) D3's reasoning, unchanged.

`added` is reported as data because a `dropped` finding *beside* an `added` id is what a
re-identification looks like; the caller has the context to judge. And `compared` is the
denominator, for the same reason `BlueprintValidation.widgets` is: `ok: true` over an empty
`before` is not evidence that identity held, and a caller whose floor computation returned
nothing would otherwise read a clean report. That case has its own test.

### D3 — The second consumer is real, and it is what shaped the API

[ADR 0092](0092-adaptive-operator-profiles-placement.md) D5 gated this on
[the second-consumer rule](0083-second-consumer-rule.md), naming the a2ui revision path as the
candidate. That path exists (`A2UISurfaceBridge.recompose`), so the gate is satisfied by wiring
it, not by waiving the rule:

`bridge.identityDiff(next)` reports which component ids a proposed recompose would drop, as a
**query** — it neither commits the tree nor emits, so "look before you leap" is not itself the
leap. A client keys rendered components by id; a dropped id is a component it unmounts and
rebuilds, discarding whatever state lived inside it.

Being a genuine second consumer changed the design rather than ratifying it: a blueprint-shaped
`preservesNodes(before: Blueprint, after: Blueprint)` — the obvious first API, and the one a
single consumer would have accepted — cannot serve a flat component list at all. The rule earned
its keep here.

`plugins/a2ui` therefore gains a dependency on `@loom/blueprint-runtime`, the edge
`renderer-react` and `renderer-terminal` already have.

## Consequences

- A composer that must survive revision has a check, not just a paragraph telling it to supply ids.
- A floor — every variant contains this set of nodes — is expressible without new vocabulary.
- Nothing is enforced automatically. Both consumers hand back a report; refusing on a legitimate
  subtree replacement would be worse than the silence this replaces.
