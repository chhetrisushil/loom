# ADR 0115 — Open vocabularies: `EffectKind`, `TaskKind`, and metering dimensions

- Status: **Proposed** (2026-10-05)
- Date: 2026-10-05
- Closes: R15 (agentic-readiness audit, kernel appendix G2/G3)
- Builds on: [ADR 0032](0032-resource-dimensions-bounded-negotiation.md) (the fixed dimensions),
  [ADR 0030](0030-decision-materialization.md), [ADR 0083](0083-second-consumer-rule.md) (relaxed for
  Part R).
- Placement: **kernel/core types and the `RESOURCE_METERED` fold**; the `a2a` effect moves to its plugin.
  Shares the Wave 2 bump (EVENT_SCHEMA 1.23.0: one optional payload field; KERNEL_ABI is unchanged by
  this ADR, `ResourceDimension` is a type).

## Context

Three closed enums in the kernel name one application style.

- `EffectKind = "tool" | "llm" | "human" | "a2a"` (`core/src/types/definitions.ts`). The only
  *semantic* use in the kernel is `kindOf(...) === "human"`, which changes replay (a human step parks
  and its answer is a resume, `WorkflowContext.execute`, the stray-passthrough scanner). `llm` and
  `a2a` are labels; `a2a` is a named external protocol, and `A2AEffect` lives in `@loom/effect-runtime`.
  A `"sensor"`, `"robot"` or `"payment"` effect cannot declare its kind without a core edit.
- `TaskKind` adds `agent`, `ui`, `memory`, `plan`: the vocabulary of one way of building agents.
- `ResourceDimension = "tokens" | "costUsd" | "ms" | "memBytes" | "wallMs" | "netBytes"` and a fixed
  `RESOURCE_METERED` fold into a fixed `_resources` shape, with a fixed ceilings table
  (`METER_CEILINGS`). GPU-seconds or API credits cannot be metered by the kernel's own mechanism, so
  they cannot be budgeted, quota-checked or negotiated either.

## Decision

### D1 — `EffectKind` and `TaskKind` are open strings with reserved semantics

`type EffectKind = KnownEffectKind | (string & {})` (and likewise `TaskKind`), where the known set
documents the values the kernel or first-party code gives meaning to. The kernel gives exactly one
value meaning — `"human"` — and that is stated as a contract: *an effect declaring `kind: "human"`
parks the flow for an external answer.* Every other value is advisory metadata (placement
compatibility, analytics, authorization displays). A custom kind must match
`/^[a-z][a-z0-9._-]{0,63}$/`, so a kind is safe to use as a map key and a metrics label.

`A2AEffect` and the `"a2a"` literal move to `@loom/plugin-a2a`; `@loom/effect-runtime` keeps a
deprecated re-export for one minor. `"ui"` leaves `TaskKind`'s documented set with ADR 0114.

### D2 — Custom metering dimensions

`RESOURCE_METERED` gains an additive optional `custom?: Record<string, number>`. The fold adds each
entry into `_resources.custom` (fold-owned map; absent unless used, so existing logs fold
byte-identically). Names match `/^[a-z][a-z0-9._-]{0,63}$/`, at most 32 per execution (a
cardinality bound, because the map rides every snapshot), and are stored with null-prototype
semantics (`__proto__`, `constructor` and `prototype` are refused: the map is keyed by caller-chosen
names, the class of hole the binding-pin audit found). Values are finite and in `[0, ceiling]`; the
default ceiling for an unknown name is `1e15`, and `WorkflowRuntimeDeps.meterCeilings` overrides per
dimension. The six built-ins keep their top-level fields exactly (no migration).

`ResourceDimension` becomes `BuiltinDimension | (string & {})`. Budgets, `QUOTA_EXCEEDED`,
`negotiateBudget` and `ExecutionPolicy` resource ceilings accept any name; `currentResource(name)`
reads `custom[name]` for a non-built-in. The kernel assigns no unit and no price: converting
`gpuSeconds` to money is a middleware/policy concern, as `costUsd` already is.

### D3 — `estimatedCostUsd` stays

`DecideOptions.estimatedCostUsd` is a descriptive field on a decision (ADR 0030) and is not
removed; a generic `estimatedCost?: { [dimension: string]: number }` is the open spelling and lands
additively beside it. (Only the descriptive field; `choice` stays the sole replay input.)

## Replay and migration

All additions are optional payload fields and a map that is absent until used. Existing logs fold
byte-identically; a reader that does not know `custom` ignores it (it is folded into the one key it
does not read). The `a2a` move is a source-level change only, with the deprecated re-export.

## Tests

A custom effect kind round-trips through register/`kindOf`; a `"human"`-kind custom effect still parks
(the one semantic value, pinned by a test); a kind failing the pattern is refused at registration;
`RESOURCE_METERED { custom: { gpuSeconds: 3 } }` folds, accumulates, snapshots and replays equal; a
budget on `gpuSeconds` fires `QUOTA_EXCEEDED`; `__proto__`/33rd name/negative/NaN/over-ceiling
refused; fold equality on every existing vector; the wire-abi vector.

## Rejected

- **Removing the closed enums outright**: they document the first-party vocabulary; widening keeps the
  documentation and the autocomplete.
- **A dimension registry with units and prices**: a policy surface with no second consumer yet; names
  plus a ceiling are the minimal kernel contract.
