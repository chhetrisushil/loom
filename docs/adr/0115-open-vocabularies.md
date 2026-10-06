# ADR 0115 — Open vocabularies: `EffectKind`, `TaskKind`, and metering dimensions

- Status: **Accepted — implemented** (2026-10-07) — design approved after 4 review rounds; see "Implementation notes" for what the code does beyond the text
- Date: 2026-10-05
- Closes: R15 (agentic-readiness audit, kernel appendix G2/G3)
- Builds on: [ADR 0032](0032-resource-dimensions-bounded-negotiation.md) (the fixed dimensions),
  [ADR 0030](0030-decision-materialization.md), [ADR 0083](0083-second-consumer-rule.md) (relaxed for
  Part R).
- Revision: round 1 (Opus review of PR #495): the `custom` map is validated at the userspace-emit guard
  (D2), and the fold skips a bad key deterministically instead of throwing (D2).
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

**Where the validation runs.** `RESOURCE_METERED` is one of the kernel kinds userspace may append
(`USERSPACE_KERNEL_EVENTS` in `userspaceEmit.ts`: middleware metering emits it through `ctx.emit` /
`EffectContext.emit`), so the pattern, the cardinality bound, the prototype-name refusal and the value
range are enforced in **`guardUserspaceEmit`** (the single gate every userspace append passes, named in
the same file), where a violation is refused with a typed error before anything is appended — not first
in the fold. **The fold must never throw on a log it did not write the guard for** (a log from another
node, a hand-edited fixture, a pre-guard writer): it **skips a bad key deterministically** — a name failing
the pattern, a prototype name, a non-finite or out-of-range value, or the 33rd distinct name is ignored
and the rest of the event folds — so every replica folds the same state and a poisoned event cannot make
replay fail. The conformance vectors include an event with bad keys and the expected folded state.

The fold's ceiling is the fixed default (1e15) and its name cap is 32; a per-dimension
`meterCeilings` override applies at the guard and in the runtime, never in the fold, because a pure
fold cannot read a runtime setting.

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
refused **at `guardUserspaceEmit`** and **skipped without throwing by the fold** (a raw-appended event with
bad keys folds to the same state on two replicas); fold equality on every existing vector; the wire-abi vector.

## Rejected

- **Removing the closed enums outright**: they document the first-party vocabulary; widening keeps the
  documentation and the autocomplete.
- **A dimension registry with units and prices**: a policy surface with no second consumer yet; names
  plus a ceiling are the minimal kernel contract.

## Implementation notes (2026-10-07)

- **Frozen at W2-0, unchanged.** `RESOURCE_METERED.custom`, the `_resources.custom` fold, the fold's
  skip-a-bad-key rule and the guard's validation (`assertCustomDimensions`) were reserved at W2-0 and are
  untouched in shape; EVENT_SCHEMA stays 1.23.0 and KERNEL_ABI 1.3.0. R15 adds only the open types, the
  ceiling override, the consumers (quota, `negotiateBudget`, middleware) and the descriptive map below.
- **D1.** `KnownEffectKind` / `KnownTaskKind` document the first-party names; `EffectKind` /
  `TaskKind` are `Known | (string & {})`. The pattern is `VOCABULARY_NAME_PATTERN` (exported from
  `@loom/core`, one constant for kinds and dimensions). `EffectRuntime.register` refuses a kind that fails
  it. `"ui"` left `KnownTaskKind` (ADR 0114). `"human"` is pinned by a test: a custom effect declaring
  `kind: "human"` parks. `A2AEffect` is now defined in `@loom/plugin-a2a`; `@loom/effect-runtime` keeps a
  deprecated **copy**, not a re-export (a re-export would make a kernel-adjacent package depend on a plugin
  that depends on it). The copy is removed with the next effect-runtime major.
- **D2 ceilings.** `WorkflowRuntimeDeps.meterCeilings` (and `defineConfig({ kernel: { meterCeilings } })`)
  overrides the per-increment sanity ceiling in `guardUserspaceEmit` for a built-in (raise or lower) or a
  custom dimension (lower only: the fold skips a custom value above 1e15, so a guard that admitted more
  would let through an increment the fold then ignores; refused at construction). Never read by the fold.
- **Consumers.** `ResourceDimension` is open; `negotiateBudget` / `currentResource` read a built-in as a
  top-level field and anything else with an own-property read of `_resources.custom` (`constructor` reads
  0). `ResourceSnapshot.custom`, `ResourceDelta.custom`, `Budget.maxCustom` (metering and nested budgets,
  including the ledger projection) enforce a ceiling on a custom name through the existing
  `QUOTA_EXCEEDED` path.
- **D3.** `DecideOptions.estimatedCost` lands as a descriptive field on the decision entry (additive and
  optional within the unreleased 1.23.0, like the `PARALLEL_COMPLETED` amendment; an older fold ignores
  it). Validated at `ctx.decide` (plain object, at most 32 names, dimension pattern, finite non-negative);
  the fold keeps only the valid entries and never throws. A conformance vector covers both maps.
- **Built-in names are not custom names.** A `custom` entry naming a built-in dimension (`custom: { tokens: 5 }`)
  is refused by the emit guard, by `Budget.maxCustom` validation and by the ledger (which skips it): the frozen
  fold would otherwise file it under `_resources.custom.tokens`, invisible to `currentResource("tokens")`,
  `negotiateBudget` and the built-in ceiling. `meterCeilings` keeps a built-in name as a built-in ceiling only.
  A metering `pricing` function that returns a bad custom name throws from `ctx.emit` after the effect ran, as a
  built-in ceiling breach does. Summed custom totals can exceed 2^53 (a single increment is capped at 1e15 and
  the fold is deterministic), so treat a very large total as approximate.
- **Not done.** No unit or price registry (as designed). `analytics` does not yet surface custom
  dimensions: its per-step attribution and its `total` cover the BUILT-IN dimensions (tokens, costUsd, ms)
  only. Custom dimensions in analytics are a listed follow-up.
