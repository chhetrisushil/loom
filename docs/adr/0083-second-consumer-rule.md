# ADR 0083 — The second-consumer rule: an outward gate on first-party surface

- Status: **Accepted** (2026-08-12)
- Date: 2026-08-12
- Complements: the *inward* evidence-gate archetype
  ([ADR 0052](0052-run-chaining-deferred-evidence-gate.md),
  [ADR 0065](0065-group-commit-deferred-evidence-gate.md),
  [ADR 0081](0081-long-lived-suspensions-no-promotion.md),
  [ADR 0082](0082-substitutive-replay-deferred.md)) and
  [ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md)'s placement litmus.
- Prompted by: the [Companion platform evaluation](../requirements/2026-08-12-companion-platform-evaluation.md),
  and the question it raised — whether loom stays a framework if that evaluation is implemented.
- Part of: P10. **No code, no contract change.** A review rule.

## Context

Loom has a strong antibody against kernel growth, and it works. Across 82 ADRs the kernel ABI
has never moved off 1.1.0, and the rejection list is long and mostly written *against* a workload
that wanted the thing: fibers, live migration, speculative execution, `finding$`, `checkpoint$`,
identity-preserving suspension transfer, run durability classes, streams/pipes, a kernel
projection primitive, and — most recently — both promotions the Companion workload asked for.
The evidence-gate archetype exists precisely to make those refusals reopenable on merit rather
than permanent by accident.

There is no equivalent antibody pointing outward, and the workspace is now **42 packages, 18
plugins and 11 tools**.

Nothing in the repo asks whether a package *should exist*. `findLayeringViolations` checks
dependency **direction** (no kernel/SPI → `plugins/*`), not existence. The `@loom/spec` registry
grades **maturity**, not necessity. The `loom plugin check` contract validates a plugin's
**shape**, not its justification. So the pressure that once produced kernel bloat now produces
first-party surface, and trips no guard on the way.

This matters because P10's actual promise is not "the kernel is small" — it is *"you never pay
for a runtime you did not opt into; the simple path stays a one-liner."* A kernel surrounded by
one application's SDK satisfies the letter of that and violates its intent. Every individual
step is defensible; the aggregate is what changes what loom is.

The failure mode is specific and observable in the Companion evaluation: a requirement derived
from one product, generalised just enough to look like a mechanism, landing as first-party
surface that only that product will ever call.

## Decision

**Before a workload-derived requirement becomes first-party surface, name a second unrelated
consumer of the same mechanism. If you cannot, it is application code.**

### What it gates

- a new package under `packages/*` or `plugins/*`;
- a new rule in `@loom/verify` or a new compile-time check;
- a new seam in the plugin registry;
- a new exported abstraction that encodes a *vocabulary* (a taxonomy, a class list, a state set)
  rather than a mechanism.

### What counts as a second consumer

It must be **named** and **unrelated to the workload that prompted the proposal**. In descending
order of strength:

1. an existing in-repo consumer — another package, a `loom-examples` app, a shipped plugin;
2. a recorded requirement in another `docs/requirements/` document;
3. a concrete, named external workload with a stated use, written down in the proposing ADR.

Explicitly **not** evidence: "it is generic by construction", "any app might want this", a second
consumer that is a different part of the *same* product, or a second consumer invented in the
same sentence as the proposal.

### Outcomes

- **Pass** — proceed. Record the named second consumer in the proposing ADR, as a section a
  reviewer can check.
- **Fail** — land it as application code in the consuming app (or in `loom-examples`), and state
  what would change the verdict. As with the inward gates, failing means *not yet*, not *never*:
  the second consumer arriving is exactly the evidence that reopens it.

### Where it is applied

**In review, by the reviewer, against a written claim** — not by the author's own judgement at
authoring time. A proposal that does not state its second consumer has not answered the
question, and "obviously generic" is a missing answer rather than a passing one.

## Worked examples

Both from the Companion evaluation, both decided by this rule:

**EF (effect classes) — passes.** The mechanism is "declare what a flow may do, validate it
statically whole-flow, compose conservatively across call boundaries." Second consumers, named:
any approve-then-run system over generated code; the existing K2 grant table, which is the
runtime half of the same concern and predates the Companion workload entirely. It is a
mechanism, and more than one thing wants it.

*But its vocabulary fails.* `read-only | local-write | external-write | irreversible` is
Companion's list. Only Companion wants that list. So the mechanism is first-party and the class
vocabulary is app-supplied — which is the discrimination the rule exists to force, and which the
evaluation would otherwise have blurred.

**EL-7 (compile-time rejection of writing a `projected`-classed event type) — fails.** The
`observed / decided / projected` taxonomy is a discipline one application adopted. No second
consumer exists, the fold deliberately treats domain event types as inert, and encoding the
taxonomy in loom's compiler would make loom hold an opinion about how applications shape their
event vocabulary. It belongs in the application's own lint. If a second workload adopts the same
taxonomy, that is when it is worth promoting.

## What this deliberately does not gate

- **3P plugins.** Someone else's package is their business; that is the entire point of the
  1P/3P split (ADR 0043).
- **New functions in an existing package.** The cost being controlled is surface *count* and the
  opinions a package encodes, not lines of code.
- **Conformance kits and spec artifacts for an SPI loom itself defines.** These are
  single-consumer by nature and exist to make the SPI checkable — `runPolicyConformance` has
  exactly one implementation today and should still exist.
- **Examples.** `loom-examples` is where single-consumer code is *supposed* to live; that is the
  fail branch, not a violation.

## Consequences

- Proposals get one more section, and reviewers get a question they can actually adjudicate
  instead of a judgement call about taste.
- Some legitimately useful mechanisms will be delayed until a second consumer shows up. That is
  the intended trade, and it is the same trade the inward gates already make.
- **This rule cannot check the person applying it.** It was proposed and first applied by the
  same author who wrote the evaluation that prompted it, which is not a control. It is written
  to be operable by a reviewer against a written claim precisely so that it stops depending on
  that author — and if it is only ever cited by the person proposing the package, it has failed
  and should be replaced by something mechanical.
- It does not apply retroactively. Existing packages are not re-litigated by this ADR; the rule
  governs what is added next.
