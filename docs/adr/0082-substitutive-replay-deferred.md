# ADR 0082 — Substitutive replay deferred; branch-from-prefix must be eliminated first

- Status: **Accepted** (2026-08-12) — deferral recorded with a sharpened evidence gate; nothing scheduled.
- Date: 2026-08-12
- Defers: PO-5 ("Promotion 2, conditional") in the
  [Companion platform requirements](../requirements/2026-08-12-companion-ambient-execution-platform.md) §9,
  evaluated in [the placement evaluation](../requirements/2026-08-12-companion-platform-evaluation.md) §1.
- Builds on: [ADR 0079](0079-decision-context-and-policy.md) (the recorded
  `(context, action, propensity)` tuple), [ADR 0080](0080-learning-substrate.md) (SNIPS
  off-policy evaluation), the fork/simulate/promote branching seam.
- Archetype: [ADR 0052](0052-run-chaining-deferred-evidence-gate.md) /
  [ADR 0065](0065-group-commit-deferred-evidence-gate.md).
- Part of: P10 minimal kernel. **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).**

## Context

*Substitutive replay* is re-executing recorded history with a **different** decision at a
decision point, to observe how a counterfactual policy would have proceeded. It is genuinely a
third mode, distinct from event-log replay (which reuses every recorded choice) and from
projection re-execution (which recomputes a pure function): it deliberately diverges from the
recorded history while reusing the recorded prefix.

The submission accepted it as conditional and deferred it, on the grounds that **scoring**
off-policy evaluation (PO-4) answers the stated product requirement without it, and that
substitutive replay becomes interesting only when importance weights degenerate over long
trajectories.

That reasoning is correct as far as it goes. It stops one step short.

## Decision

**Defer, with a sharpened gate.** The submission's gate was "demonstrate an evaluation question
importance weighting cannot answer." That is necessary but not sufficient, because there is a
userspace answer the submission does not consider:

**Branch-from-prefix already does this.** Loom ships fork/simulate/promote over a `BranchRegistry`
— the pattern the `incident-war-room` and `schema-migration-planner` examples exist to
demonstrate — plus `@loom/dst` for deterministic simulation. Forking an execution at a decision
point and re-running the suffix with a different recorded choice **is** substitutive replay,
built from primitives that already exist, with divergence semantics that are already defined
(the fork point is the divergence point, and the branch is a first-class execution with its own
log).

Framing it as a new *replay mode* rather than a *branch* is what makes it look like a kernel
concern. As a branch it is an application pattern, and the questions the submission lists as
unspecified — what is reused, what is re-derived, where divergence may begin — already have
answers.

**Gate:** reopen only when a concrete evaluation question is demonstrated that satisfies **both**:

1. SNIPS importance weighting cannot answer it — most plausibly because trajectories are long
   enough that effective sample size collapses (`evaluatePolicy` reports this directly, so the
   claim is measurable rather than asserted); **and**
2. branch-from-prefix cannot answer it either — with a stated reason why forking at the decision
   point and re-executing the suffix is insufficient or unaffordable.

Absent (2), the requirement is satisfied in userspace and there is nothing to promote.

## Notes

- **Checkpoint replay barriers do not gate this.** The submission's §11.2 keeps them "deferred"
  pending PO-5; they were in fact ruled **not needed** in
  [ADR 0051](0051-perpetual-agents-placement-schedule-remodel.md) (snapshots + K10.4 compaction
  already bound replay depth). If PO-5 ever proceeds, the fork point is the barrier.
- **PO-4 is not deferred — it shipped.** `evaluatePolicy` (`@loom/learning`, ADR 0080) computes
  the SNIPS estimate, agreement rate and effective sample size, and `loom learn eval` runs it
  over a stored log. The Companion requirement it serves (LP-6) is satisfied today.
- **A prerequisite is easy to lose.** Off-policy evaluation of any kind needs `P(action |
  context)` recorded **at decision time** — the propensity, not the randomisation draw. It
  cannot be reconstructed afterwards. A workload that logs only the draw has silently forfeited
  both PO-4 and any future PO-5, and will not discover this until it tries to evaluate.

## Consequences

- Nothing is built; the specification work the submission wanted "scoped before M4" is replaced
  by a cheaper task: attempt the question with a branch, and record what fails.
- If the gate is ever met, this ADR is the place the argument gets made — including why a branch
  was insufficient, which is the part most likely to be skipped under schedule pressure.
