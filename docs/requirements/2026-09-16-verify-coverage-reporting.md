# Verification that reports its own coverage

**Status:** PROPOSED — scoping only. The analysis this began as a request for **already exists**; §1 is the correction.
**Date:** 2026-09-16
**Kernel baseline:** EVENT_SCHEMA 1.18.0, KERNEL_ABI 1.1.0 — unchanged by everything below
**Relates to:** [ADR 0086](../adr/0086-runner-body-reach-analysis.md) (runner-body reach), [ADR 0028](../adr/0028-runtime-verification.md) (runtime verification)

---

## 1. The correction first: the analysis is built

This was scoped as *"runner-body analysis in the compiler, the same machinery `nonDeterministicByFlow`
already arrives by"*. That work is **done and shipped**:

| stage | where | status |
|---|---|---|
| extract suspend points from the runner body | `tools/compiler/src/runnerReach.ts` — `RunnerSuspend { id, correlationKey, timed, wakeAt }` | ✅ |
| write them into the compiler manifest | `tools/compiler/src/transform.ts:402` → `manifest.runnerReach` | ✅ |
| read the manifest | `tools/cli/src/verify.ts:87` → `runnerReachByFlow` | ✅ |
| populate `FlowSpec.suspends` | `packages/app/src/verifyAdapter.ts:260` | ✅ |
| consume it | `suspension-safety`'s timed-suspend check (`rules.ts:102`) | ✅ |

ADR 0086, accepted 2026-08-14. Building the same thing again would have duplicated a shipped
analysis.

**What sent me looking for it** was `verifyAdapter`'s own header, which still read *"`FlowSpec.suspends`
is still unpopulated, and that matters… Two of `suspension-safety`'s three checks therefore never fire"*.
True when written, false since ADR 0086, never updated — and I repeated it verbatim in a `loom doctor`
advisory before catching it. Both are corrected. The lesson is the familiar one in a new place: **a
claim about coverage is exactly the kind of comment that rots silently**, because nothing fails when it
goes stale.

## 2. The gap that is actually open

`FlowSpec.suspends` is populated **from the manifest, and only from the manifest**. So the bound is
about input, not about producers:

```sh
loom verify --config ./dist/app.js
# → 8 rule(s), 0 error(s), 0 warning(s)
```

That output is identical whether or not a manifest was found. Without one:

- **`suspension-safety`** reads `flow.suspends ?? []` — empty — so its timed-suspend and
  correlation checks contribute nothing. Only the K12 approval check (from declared
  `resumeSchemas`) is live.
- **`capability-compat`** and **`effect-class`** see the DECLARED steps only. A tool invoked
  through `ctx.run(binding)` without being listed in `steps` is invisible, so both are
  partially blind rather than silent.

`reachAnalyzed` exists precisely to distinguish these cases — `verifyAdapter.ts:266` sets it — and
**no rule reads it.** A field written and never read is the vacuous-check pattern: the distinction was
modelled, and then nothing acted on it.

So the honest statement of the defect is not "the analysis is missing" but:

> **A clean `loom verify` reports the same thing whether three rules examined the runner bodies or
> never saw them.**

That is the same failure this codebase keeps finding — an unchecked thing that reads as a checked one
— sitting in the tool whose entire job is to say what it checked.

## 3. Proposed work

Small, and mostly in `@loom/verify`. No kernel change, no new analysis, no SPI version.

| | item | shape | size |
|---|---|---|---|
| **V1** | `suspension-safety` emits an `info` finding per flow when `reachAnalyzed !== true`: *"suspend points were not analysed (no compiler manifest); timed-suspend safety is unverified for this flow."* | `rules.ts` | ~15 lines + tests |
| **V2** | Same for `capability-compat` and `effect-class`, worded for *their* blind spot (`ctx.run` targets outside `steps`), so three rules stop reporting clean on unexamined bodies | `rules.ts` | ~20 lines |
| **V3** | `formatReport` summarises coverage: `8 rule(s), 0 error(s), 0 warning(s) — 3 rule(s) partially verified (no manifest)`. The counts today invite the reading that nothing was wrong | `verify.ts` (package) | ~15 lines |
| **V4** | `loom verify` says when it found no manifest, not only when it found one — the banner is currently one-sided | `tools/cli/src/verify.ts` | ~8 lines |
| **V5** | `loom doctor`'s verify check carries the coverage line through, so the front door does not flatten it | `tools/cli/src/doctor.ts` | ~5 lines |

**Severity is `info`, deliberately.** `warn` would fire for every app that does not build with the
Loom compiler — which is most of them, since the compiler is opt-in — and a verifier that scolds every
correct project is a verifier people switch off. `info` states the coverage; the *summary* line (V3) is
what makes it hard to miss.

### Verification

The test that matters is the negative one, and it is cheap: verify the same app **with and without**
`runnerReachByFlow`, and assert the two reports differ. Today they are byte-identical — which is the
defect, and makes a clean red/green pair.

A fitness test should also assert that **every rule reading reach data emits a coverage finding when
`reachAnalyzed` is absent** — otherwise V1/V2 fix three rules and the fourth one added next year
silently reintroduces the gap.

## 4. What NOT to do

- **Do not add a second suspend analysis.** ADR 0086's exists; a runtime-side or adapter-side
  re-derivation would drift from it and double the surface that can be wrong.
- **Do not make the manifest mandatory.** `defineConfig` apps that never run the compiler are a
  supported shape; the answer to partial coverage is to *say so*, not to refuse.
- **Do not promote these findings to `error`.** Nothing about a missing manifest says the app is
  wrong — only that three rules did not look.

## 5. Placement verdict (ADR 0083)

Not kernel — no syscall, no event, no SPI. V1–V3 are `@loom/verify` (where the rules and their report
live); V4–V5 are the CLI. The second consumer for the coverage-reporting idea is already shipped and
adjacent: `loom doctor` distinguishes `skipped` from `ok` for exactly this reason, and `loom census`
reports lease coverage as *"not asked"* rather than zero. This is that same rule applied to the
verifier itself.
