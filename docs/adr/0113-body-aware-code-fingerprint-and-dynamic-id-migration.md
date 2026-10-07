# ADR 0113 — A body-aware code fingerprint, replay-divergence detection, and migration of dynamic step ids

- Status: **Accepted** (2026-10-07) — design approved after 4 review rounds; implemented in full (D1–D4) by R7. D5 is by design not kernel work.
- Date: 2026-10-05
- Closes: R7 (agentic-readiness audit, kernel appendix O2/O3/R7, §2a "Versioning a RUNNING agent")
- Builds on: K11 ([ADR 0023](0023-k11-flow-code-versioning-in-flight-executions.md)), K11.5
  ([ADR 0056](0056-k11-5-state-migration-on-resume.md)), [ADR 0061](0061-step-identity-interpreter-guardrails.md)
  (the step-identity rule that mints `id#n` steps at runtime),
  [ADR 0084](0084-effect-classes-static-ceiling-k2-floor.md) and [ADR 0086](0086-runner-body-reach-analysis.md)
  (the compiler's runner-body analysis), [ADR 0109](0109-bounded-history-and-continue-as-new.md)
  (continuation is the clean re-versioning point).
- Placement: **kernel** for the hash, the recorded field and the divergence check;
  **1P** for the code-by-hash registry and bundler support (`@loom/compiler`,
  `@loom/workflow-runtime` `FlowRegistry` packaging). Shares the Wave 2 bump (EVENT_SCHEMA 1.23.0:
  one optional payload field; no ABI change).
- Revision: round 1 (Opus review of PR #495): the divergence detector fires before the first live journal
  append of ANY kind and re-baselines at `EXECUTION_MIGRATED`; it checks **membership only**, not order
  (D3); SHA-256 placement in the platform-neutral core is stated (D1).

## Context

`flowContentHash` (core/src/flowHash.ts) is FNV-1a **32-bit** over the flow id, version, deadline and
the *declared* step list. Three separate defects follow from that.

1. **It is body-blind.** The file's own comment says a body-only edit "folds an existing log
   identically (completed steps are served from the log)". That holds only when the edit does not
   change which step ids the re-run asks for, in what order, or whether it asks at all. A flow is a
   JavaScript function re-run from the top on every resume; an edit that changes a branch condition,
   inserts a step, or reorders two, produces a different id sequence over the same log. The kernel
   serves recorded frames by id, so the divergence is silent: new ids execute live, old frames are
   orphaned, and an effect that already ran under an old id runs again under a new one. Exactly the
   long-lived agents that survive deploys are exposed.
2. **It is 32 bits.** A collision strands nothing and detects nothing; it is a deploy-time accident
   waiting for the right pair of flows (and it is the same class of weakness R13 fixed in
   `viewDigest`, which also began as FNV).
3. **`replay-check` rejects dynamic ids.** `resumeAs(..., { strategy: "replay-check" })` demands that
   every recorded frame id exist in `definition.steps`, while the step-identity rule tells dynamic
   agents to mint `id#n`. So the one safety check that should gate a migration of a dynamic agent
   refuses every such agent.

The kernel also holds flow runners as in-process closures keyed by hash, so serving an old pinned
execution requires its old closure to remain registered in the same binary forever. That is a
packaging problem (1P), made much smaller by ADR 0109: a continuation re-versions cleanly.

## Decision

### D1 — The structural hash becomes SHA-256 (`sha256:`), legacy values still accepted

`flowContentHash` computes SHA-256 over the same canonical structure (no new inputs), prefixed
`sha256:`. **Where SHA-256 lives.** `core` is platform-neutral by rule (`schemaHash.ts` states "no
node:crypto; TextEncoder is web+node"), while `approvalBinding.ts` in `workflow-runtime` already uses
`node:crypto`. `flowContentHash` is called from `core`, `workflow-runtime` and `app/src/verifyAdapter.ts`,
so it stays in `core` and gets a **small dependency-free pure-JS SHA-256** (~60 lines, FIPS 180-4 test
vectors pinned in the test), not a `node:crypto` import and not a move to `workflow-runtime` (which would
invert `verifyAdapter`'s dependency). The cost (a hash per start/resume over a few hundred bytes) is
negligible. A recorded `fnv1a:` value remains valid: the comparison recomputes the legacy hash for a
legacy recording, so no in-flight execution is stranded. New starts record the new form.

### D2 — An opt-in body fingerprint, `codeHash`

`FlowDefinition.codeFingerprint?: string` — a content hash of the flow *body* as built, supplied by
the toolchain (`@loom/compiler`'s `loomPlugin()` already extracts and hashes handler chunks) or by the
author. It is recorded on `EXECUTION_STARTED.payload.codeHash` (additive; the fold key
`_codeHash`) and compared on resume/recovery beside `flowHash`:

- equal, or absent on either side: as today;
- different: `FlowCodeMismatchError` **unless** the registered definition lists the recorded value in
  `compatibleWith: string[]` — the author's explicit assertion that the edit is replay-compatible
  (the analogue of Temporal's `patched()`), reviewed in the diff that adds it.

The kernel does not compute the body hash itself: `Function.prototype.toString` is not stable across
bundlers, minification and closures, and the structural hash exists precisely because "a rebuild
with identical structure yields an identical hash". A fingerprint the toolchain produces is stable
by construction or visibly absent. Absent never fails (G2), so nothing changes for a flow without it.

### D3 — Replay-divergence detection (membership only)

A re-run knows what the log says it did. The runtime checks, **before the first live journal append of any
kind** — a live step start, but also a live `ctx.decide`, `ctx.emit`, `ctx.sleep`/timer registration, a
suspend, a spawn or any other event the re-run is about to write that the log did not already contain —
and again at `EXECUTION_COMPLETED`, that every *completed* frame recorded **before the re-run's resume
point** (outside an open parallel scope) was **visited** by this re-run. A recorded step the new body
never asked for means it skipped durable work the log shows was done: the code changed shape. The
runtime raises `FlowDivergenceError` naming the steps **before** that append, so nothing live runs under
a diverged body. (The first draft checked only at "the first live step", so a body that diverged into a
`decide` or an `emit` first would have written under the wrong shape.)

- **Membership, not order.** The first draft also required "an order consistent with the recorded
  first-start order". That is dropped: a recorded first-start order is not stable for steps that overlap
  (concurrency outside a declared scope, a `Promise.all` of `ctx.execute`) and made every benign reorder a
  failure. A skipped recorded step is the defect worth a refusal; reordering is not.
- **The baseline resets at `EXECUTION_MIGRATED`.** `resumeAs` + `transformState` deliberately changes the
  frame set (K11.3/K11.5): frames recorded before the migration event are exempt, so a migrated execution
  is not refused for the steps its migration removed. The check applies to frames recorded after it.
- Steps inside an open `parallel` scope (ADR 0112) are compared as a set.
- Modes: `divergence: "off" | "warn" | "fail"`, default `warn` (a logged warning and a counter); under
  `security.strict` the default is `fail` (design document §7 question 9). `warn` proceeds, so the
  detector can only report a fault already silently present.

The check is runtime-only: no event, no fold change.

### D4 — `replay-check` understands step families

A frame id `base#suffix` belongs to the family `base`. `replay-check` passes a recorded frame when its
id exists in the new definition *or* its family does (the `agentLoop$` ids
`<loop>#turn:<n>:tool:<j>` and every ADR 0061 `id#n` mint are covered by the rule already in force),
and `FlowDefinition.stepFamilies?: (string | RegExp)[]` extends it for ids that do not follow the
`#` convention. Orphans are reported per family with a count, not one name per dynamic frame.

### D5 — What stays 1P

The **code-by-hash registry** — shipping an older runner next to the current one so a pinned
in-flight execution can finish — is a packaging concern: `@loom/compiler` emits per-version chunks
keyed by `codeHash`, and the workflow-runtime registry already accepts several definitions per flow
id and pins by hash. This ADR adds the key (`codeHash`), not the store. ADR 0109 is the strategic
answer: a long-lived agent re-versions at every continuation instead of pinning an old closure.

## Replay and migration

`flowHash` values already in logs keep working (D1). `codeHash` and `_codeHash` are absent in every
existing log, which compares as "no fingerprint". Divergence detection is new behaviour on existing
logs, which is why the default is `warn`: it can only *report* a fault that is already silently
there. Turning it to `fail` is an operator decision after a clean-run period.

## Tests

SHA-256 recorded for new starts and a `fnv1a:` recording still resumes; collision-resistance is not
tested, the prefix handling is; a body edit that changes the id sequence over a real log →
`FlowDivergenceError` before the first live effect (assert the effect was NOT invoked: the negative
test), and the same edit under `compatibleWith` is refused as a *mismatch* not silently allowed unless
listed; a dynamic-id agent passes `replay-check` and an agent whose family disappeared does not;
parallel-scope steps compared as a set; **the check fires before a live `decide`, `emit` and timer
registration, not only a step**; a migrated execution (frames removed by `transformState`) is not
refused for the removed frames; a pure reorder passes (membership only); strict defaults to `fail`; `warn` mode logs and proceeds; a flow with no
`codeFingerprint` behaves exactly as today (fold byte-equality, hash unchanged apart from prefix).

## Rejected

- **Hashing `runner.toString()`**: unstable, see D2.
- **An order check** (the first draft): unstable for overlapping steps, fails benign reorders.
- **Recording the id sequence in the log and comparing exactly**: duplicates what the frames already
  say, and makes every benign reorder inside a parallel scope a failure.
- **Failing by default**: detection of a fault that has been silent for 22 minor versions should
  arrive as a warning first.

## Implementation notes (as built)

R7 landed D1–D4 with no wire change (EVENT_SCHEMA 1.23.0 and KERNEL_ABI 1.3.0 untouched: `codeHash` and `_codeHash` were frozen at W2-0 and this is their first writer). Deviations and decisions, in the order they bit:

1. **Config lives under `kernel.divergence`**, not `checks`/`durability`: it is a kernel runtime behaviour, beside `kernel.features`/`kernel.continuation`/`kernel.inbox`, and it is not a rolling-upgrade flag (the check is runtime-only). `WorkflowRuntimeDeps.divergence` is the raw spelling. `security.strict` defaults it to `"fail"` (`STRICT_DEFAULTS.divergence`); an explicit value always wins. `runtime.divergenceWarnings` is the counter.
2. **A refusal appends nothing, not even `EXECUTION_FAILED`.** `FlowReplayDivergenceError` (a subclass of the existing wait-identity `FlowDivergenceError`, same name) rejects the handle; the log ends where the resume's own bootstrap left it. A deploy fault must not turn a long-lived execution into a permanently failed one; the execution is in the state a crash would leave it, and resumes once the code is fixed, pinned, listed in `compatibleWith`, or migrated. The failure **latches**: a body that swallows the refusal is refused again at its next append and at completion, even after it asks for every recorded step. The explicit checks at park, continuation and completion run before the park barrier / successor start.
3. **What "visited" means.** `executeIn` marks the id the instant a step is asked for (served or live). The baseline is `ReplayVM.expectedReplayFrames()`: completed frames in first-start order, minus those recorded before the last `EXECUTION_MIGRATED`. The VM tracks the post-migration completions itself (O(1) per event, allocated only for a migrated execution). **Residual:** a snapshot taken after a migration does not say when the migration happened, so the detector then judges only completions in the tail since that snapshot (fail-open, never a false refusal).
4. **Appends that are not "new work".** `STEP_COMPLETED`, `STEP_FAILED`, `STEP_CANCELLED`, `PARALLEL_COMPLETED`, `EXECUTION_FAILED` and `EXECUTION_CANCELLED` follow a decision already taken and are exempt. A `STEP_STARTED` (or `EFFECT_INDOUBT`) for a step the log already holds a frame for is part of the recorded shape, not new work: an untyped failure re-executes on every re-run and its start can precede a recorded sibling's served frame in an unscoped `Promise.all` (found by `emitReplayOnce.test.ts`'s interleaving probe, which the first cut flagged). While a `ctx.parallel` call is open the check is deferred (the set is compared once it closes), as D3 specifies.
5. **A live decision is checked before its decider runs**, not at `DECISION_RECORDED`: the decider is real work (a model call). **A served decision opens an uncertain window.** `agentLoop$` runs `ctx.execute("<id>#skills:select")` inside `ctx.decide`; on a re-run the decision is served, the decider is skipped and the frame is never asked for. The fold does not say which decision a frame belonged to, so the frames recorded after the re-run's high-water mark are not judged until the re-run asks for a later frame (which closes the window and exempts the ones it jumped over); frames it has already moved past stay judged. Fail-open by construction: a step the body dropped in that window goes unreported. Found by `@loom/agent`'s `ringBypass.test.ts` (the first cut would have refused every strict resume of an agent with skills). **Residual:** a crash between a decider's inner step and its `DECISION_RECORDED` leaves a completed frame the re-run reaches only through the decider, which the pre-decide check precedes: a rare false positive (a warning under `warn`).
6. **D1.** `sha256Hex` (pure JS, NIST vectors pinned, compared with `node:crypto` across padding boundaries) in `@loom/core`; `flowContentHash` returns `sha256:<64 hex>`. `legacyFlowContentHash` and `flowHashMatches` keep a recorded `fnv1a:` value valid; the runtime keeps both hashes per registered version, so pinned resumption also finds a legacy recording. `@loom/deploy-sim` uses `flowHashMatches`. `replay-inspector`'s `canServePin` compares a pin's recorded string with a set the caller supplies; a caller who supplies new-form hashes will not match a legacy pin (the inspector never recomputes), which is unchanged behaviour for any hash change.
7. **D2.** `FlowDefinition.codeFingerprint` / `compatibleWith` / `stepFamilies` ride `flow$`. The check runs in `resolveFlowFor` after the structural hash selects the version (so pinned resumption compares the fingerprint of the version it resolved), is bypassed by `allowFlowCodeMismatch`, and is skipped for a migrated execution (`EXECUTION_MIGRATED` re-points `_flowHash` but not `_codeHash`, and the migration was the operator's decision). `FlowCodeMismatchError` gained a `kind` (`"structure" | "code"`). A `continueAsNew` successor records the fingerprint of the code registered at the rotation. **Not done (follow-up, per the design document):** producing the fingerprint in `@loom/compiler`'s `loomPlugin()`, and a `codeHash` census in `loom deploy check`.
8. **D4.** `orphanedFrames` (exported from `@loom/workflow-runtime`): the family is the part before the first `#`; a frame passes when its id, its family, or a `stepFamilies` string/RegExp matches; orphans are reported once per family with a count (`A#* (2 frames)`). A `<loop>#turn:<n>:tool:<j>` id passes when `<loop>` is a declared step.
9. **Measured / bounded.** One `Set` and one rank map per live run (O(recorded completed frames), built once at run start from a fold the runtime already holds), O(1) amortised per append (a monotone cursor and a size test). The guard is armed after the bootstrap, so the runtime's own resume/migration appends are never judged.
10. **Latent divergences found in the existing suites** (default `warn`, then the whole suite re-run at default `fail`): three, none a real fault in shipped code. (a) `emitReplayOnce.test.ts` "reviewer probe": a detector false positive (untyped failure re-run live), fixed by note 4. (b) `@loom/agent` `ringBypass.test.ts`: a detector false positive (served decision), fixed by note 5. (c) `caughtStepFailure.test.ts` "counts CONSECUTIVE re-drives": the fixture hand-appends `STEP_COMPLETED` for steps (`w0..w2`) the flow never asks for, a true divergence in a synthetic log; the fixture sets `divergence: "off"`. With the default at `fail` no other existing test diverged.
