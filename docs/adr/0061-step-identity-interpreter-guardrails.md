# ADR 0061 — Step identity rule & interpreter-pattern guardrails

- Status: **Accepted** (normative rule + compiler lint + kernel crash-matrix
  tests + `fanout$`/`maxDepth` residues)
- Date: 2026-07-19
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (DE-1/DE-5/DE-6), the saga `#compensate:${i}` id idiom, ADR 0060 (typed
  failures — the depth-guard channel).
- Part of: the GenUI/DE corrected series. **No kernel changes**; KERNEL_ABI and
  EVENT_SCHEMA untouched by this ADR.

## Context

The DE-5 audit was not a no-op. Frames are keyed by static step id — replay's
substitution, K9.2 idempotency keys, and K9.3 in-doubt detection all hang off
`frames[stepId]`. An interpreter flow (`ctx.run` inside a loop bounded by
runtime-loaded plan data) that reuses one step id is **silently wrong today**:
iteration 2+ is served iteration 1's memoized output. That is the worst failure
class in the system (silent replay corruption) sitting one naive loop away, and
the interpreter pattern is load-bearing for both GenUI (`executeBlueprint`) and
the copilot (runbook walkers).

## Decisions

### D1 — The identity rule (normative)

> The sequence of durable-step identities an execution produces MUST be a pure
> function of logged inputs (flow input, step outputs, decisions, resume
> payloads). A step invoked more than once with different intent MUST mint a
> deterministic distinct id — `${id}#${index}` for loops, `${id}#retry:${n}` for
> deliberate re-tries (saga: `#compensate:${i}`). Frames are keyed by id:
> reusing an id returns/substitutes the first recorded outcome — including typed
> failures (ADR 0060 D4).

Dynamic ids are deliberately OUTSIDE `flowContentHash` (it hashes the static
`steps[]` only): K11.1's structural guard covers the compiled skeleton;
fold-compatibility of the dynamic sequence is guaranteed by this rule, not by
the hash. Dynamic steps bind a static `toolId` to a registered effect — the
effect registry, not the compiler manifest/chunkMap, is the load-bearing map
(the manifest's "unregistered step" warning covers handler-bearing steps only).

### D2 — Compiler lint: `analyzeLoopIdentity`

A syntactic pass beside `analyzeNonDeterminism` (no type checker): inside loop
bodies (`for`/`for-of`/`for-in`/`while`/`do` and `.map`/`.forEach`/`.flatMap`
callbacks), flag `*.run(...)`/`*.execute(...)` whose first argument is a static
step reference (id cannot vary per iteration) or whose id-producing subtree
contains no loop-scoped binding. Quiet on anything unresolvable — false
negatives are acceptable; false positives kill lints. Wired to `@loom/verify`
like the nondeterminism pass; handler bodies exempt (memoized by the kernel).

### D3 — Kernel crash-matrix test

`interpreterLoop.test.ts`: a plan-driven loop flow minting `apply#${i}` ids,
crash-injected at every loop position, recovered, and cold-replayed — asserting
per-position invocation counts and byte-identical folds. This is the executable
form of the DE-5 acceptance criteria.

### D4 — DE-1 residue: `fanout$` (userspace)

`fanout$(ctx, baseStep, items, { limit })` in `@loom/orchestration`: mints
`${baseStep.id}#${i}` per item and delegates to `ctx.parallel` (input-order
results). Runtime-sized fan-out, deterministic join by construction,
crash-mid-fan-out recovery re-executes only missing frames — every DE-1
acceptance criterion, zero kernel surface. Nested fanout composes (ids
concatenate). The dormant PARALLEL_* bracket events stay dormant.

### D5 — DE-6 residue: recursion depth guard

`awaitChild` gains `maxDepth` (depth = `::` separators in the deterministic
child id); exceeding it completes on a typed `depthExceeded` channel (ADR 0060)
instead of recursing unboundedly — the bound the drift-repair re-entry loop
needs.

## Consequences

- The interpreter pattern is a documented, linted, tested contract instead of a
  latent corruption. Blueprint/runbook walkers are buildable on it as-is.
- Spec capability `step-identity-guardrails`; evidence: the lint tests +
  `interpreterLoop.test.ts`.
