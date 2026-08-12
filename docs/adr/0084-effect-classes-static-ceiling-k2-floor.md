# ADR 0084 — Effect classes: a static ceiling beside K2's runtime floor

- Status: **Accepted** (2026-08-12) — implemented: `effect-class` rule in `@loom/verify`,
  `effectClass` on `step$`/`flow$`, `checks.verify.effectClasses` in `@loom/app`.
- Date: 2026-08-12
- Promotes: **EF-1…EF-3, EF-5, EF-7** of the
  [Companion platform requirements](../requirements/2026-08-12-companion-ambient-execution-platform.md) §7,
  at the layer the [evaluation](../requirements/2026-08-12-companion-platform-evaluation.md) §1
  assigned them (compiler + runtime, **not** kernel).
- Builds on: [ADR 0028](0028-runtime-verification.md) (`@loom/verify`), K2 capability grants,
  [ADR 0076](0076-wildcard-classification-paths.md) (`classification-reachability`, the
  neighbouring declared-property check).
- Part of: P10. **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** No new
  syscall, no new event, no log field.

## Context

An automation compiled from a mined signature is approved once and then runs unattended. The
question "what is this allowed to *do*" therefore has to be answerable **before** approval, and
has to stay answerable after — which is what an *effect class* is: a declared ceiling on the
severity of side effect a flow may reach.

Loom already has a runtime answer to a neighbouring question. K2's `GrantTable` authorizes every
effect and denies ungranted ones (`EFFECT_DENIED`). It is tempting to conclude that effect
classes are therefore redundant.

They are not, and the reason is the whole of this ADR.

## Decision

### Two rings, answering different questions

| | Question | When | Mechanism |
|---|---|---|---|
| **Effect class** | *Does this flow reach anything worse than it promised?* | composition | `@loom/verify` `effect-class` |
| **K2 grants** | *May this principal invoke this tool at all?* | runtime | `CapabilityAuthorizer` |

**Static class = declared upper bound; grants = runtime floor.** Neither subsumes the other:

- A capability can be **granted and still bust the class**. K2 sees a permitted tool and allows
  it; nothing at runtime knows the flow promised `read-only`. Only the static check catches this,
  and the finding says so in as many words — *"the capability IS granted, so K2 will not stop it
  at runtime — this check is the only thing that will."*
- A capability can be **within class and ungranted**. That is `capability-compat`'s job, and it
  fails closed at runtime regardless.

Writing that sentence into the finding is the reconciliation. It is the difference between two
checks that coexist and two checks a reader can tell apart.

### The vocabulary is the app's

`effectClasses` is an **app-supplied ordered list**, ascending severity, passed through
`checks: { verify: { effectClasses: [...] } }`. Loom checks the ordering it is given; it does not
define one.

This is [ADR 0083](0083-second-consumer-rule.md) applied to its own worked example. The
*mechanism* — declare a ceiling, compose conservatively over what is reachable, fail when
exceeded — has more than one plausible consumer. The *taxonomy*
`read-only | local-write | external-write | irreversible` has exactly one, and hardcoding it would
have put one product's judgement inside the framework.

### It composes conservatively, and it cannot pass vacuously

A flow's effective class is the **max over every effect it reaches** (EF-3). Three findings:

- **error** — a reachable effect is classed above the flow's declaration;
- **error** — a class name outside the configured ordering, on a flow or an effect (typos would
  otherwise rank as "unknown" and sail through);
- **warn** — the flow declares a class but *N* reachable effects carry **no** class.

That last one is load-bearing. Without it the rule reports a clean pass on a flow whose effects
are entirely unclassified — a verification nobody performed. It is a `warn` rather than an
`error` so that classifying a large tool inventory can be incremental, which is the tradeoff
LQ-4 identified; the cost is that adopters must read their warnings.

## Consequences

- **`effect-class` is live, not declared.** The producer reads `effectClass` from the real
  `StepDefinition`/`FlowDefinition` inside `resolveVerifyInput` — never accepted from a caller —
  so the check cannot be satisfied by an app that merely claims a class. Five tests drive it
  through `defineConfig` end to end for exactly this reason: this repo has a rule
  (`suspension-safety`'s `correlationKey`/`wakeAt` checks) that has never fired for any app
  because nothing populates its input, and a green report says nothing about it.
- **G2 holds.** No `effectClasses` ⇒ the rule is a no-op. No `effectClass` on a flow ⇒ that flow
  is skipped. Unwired is byte-identical.
- **Reachability inherits `capability-compat`'s bound.** "Reachable" means the toolIds of the
  flow's declared `steps`. A step invoked but not declared is invisible here, exactly as it is to
  the capability check — the same limit, on the same data, and worth stating rather than
  implying. Closing it needs runner-body analysis of the kind `nonDeterministicByFlow` already
  arrives by.
- **EF-4 (verification predicates) and EF-6 (presubmit report binding) are not in this ADR.**
  EF-4 is a product contract about what "worked" means, and belongs with the approval flow rather
  than the class check.
- **No kernel field.** The class is a property of code, and the log already pins code identity via
  `flowHash` (K11.1) — so "did the class change" is answerable from today's log as "did the hash
  change", and EF-5's audit criterion is satisfied without a schema bump.
