# ADR 0092 — Adaptive operator profiles: the journaled value is a decision, not an offset

- Status: **Accepted** (2026-09-10) — placement verdicts recorded. Nothing ships in this record:
  one 1P item is gated on a second consumer (W1), one is deferred behind an evidence gate (W3).
- Date: 2026-09-10
- Resolves: the [Dynamic Persona submission](../requirements/2026-09-10-dynamic-persona.md),
  evaluated in [the placement evaluation](../requirements/2026-09-10-dynamic-persona-evaluation.md).
- Builds on: [ADR 0030](0030-decision-materialization.md) (the decision seam),
  [ADR 0058](0058-read-model-plugin.md) (durable cross-execution read models),
  [ADR 0071](0071-read-only-replay-inspector.md) (a superseded fold is refused, never substituted),
  [ADR 0079](0079-decision-context-and-policy.md) / [ADR 0080](0080-learning-substrate.md)
  (propensity and off-policy evaluation),
  [ADR 0088](0088-blueprint-conformance.md) (the app supplies the vocabulary; findings, not throws),
  [ADR 0083](0083-second-consumer-rule.md) (the outward gate).
- Part of: P10 minimal kernel. **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).**
  No syscall, no event type, no fold change.

## Context

A generative console composes its surface per request, which makes per-operator defaults tractable
for the first time and makes them dangerous for the first time: a surface composed per person is one
that cannot be reproduced, cited in a runbook, or reviewed. The submission proposes an **Operator
Profile** — capability flags with evidence and expiry, stated preferences, and a rule-assigned
cohort — applied in two tiers: a coarse discrete cohort at generation time, and a pure projection
over already-generated structure at render time.

The design is a good fit for this substrate, and the evaluation's headline is that **the app can
build essentially all of it**. This record exists for the parts where the submission's reasoning
depends on mechanisms loom does not have, and for two failure modes it does not raise.

## Decisions

### D1 — Net kernel change: zero. Net 1P change: zero today

Every boundary the design needs is `ctx.decide`; every derivation over history is a projection or a
read model; every vocabulary is app-supplied on the [ADR 0088](0088-blueprint-conformance.md)
pattern. Phase 1 of the submission's own plan — scoped preferences, which it expects to deliver most
of the benefit — requires nothing from loom at all (`plugins/durable-state` is a keyed CAS store
with versioned contracts).

### D2 — The journaled value is the resolved profile, not a log offset

The submission's §A.3 commits to `Profile(operator, T) := fold(events ≤ T)` and concludes that the
value recorded at the boundary is "a single log offset, pinned at run start."

**Rejected, and the correction matters more than the mechanism it replaces.** An offset reproduces
the *events*; it does not reproduce the *fold*, and here the fold **is** the flag catalogue and the
cohort rules — both versioned, both expected to change under review. Re-deriving a profile on replay
under a newer catalogue is the substitution loom already refuses elsewhere:
[ADR 0071](0071-read-only-replay-inspector.md) reports `unavailable` rather than run a current fold
over an old log, on the stated grounds that a silent current-version fallback is the defect.

So: record the **resolved** profile — cohort id, flag set, catalogue version — through `ctx.decide`.
It is discrete, small, versioned and citable (satisfying the submission's C1 by its own terms), it is
served from the log on replay without re-deriving anything, and it makes "suspension drift" a
non-event: a recorded decision is served identically on resume, which is what the decision seam is
for.

### D3 — A flag lapse is an event, not a read-time comparison

The submission prefers expiry to decay partly because "expiry is a timestamp comparison rather than
a recomputation." That comparison makes the fold a function of `(events, now)`, so pinning anything
at run start pins nothing, and the divergence is silent under replay.

**A scheduled evaluator emits the lapse into the log** (`sleepUntil` → a logged `TIMER_FIRED` fact),
which restores purity and, under the submission's own explicability constraint, is strictly better
product: a lapse becomes a dated fact an operator can be shown, rather than a computation performed
behind them.

### D4 — The profile is a read model, not a per-run projection fold

Two facts make the literal reading of §A.3 unaffordable: projection state never crosses the SPI, so
every fold starts from `initialState` and there is no anchor (stated in
[ADR 0071](0071-read-only-replay-inspector.md)); and loom's log is keyed by `executionId`, so "the
events of an operator" is a cross-execution query, not a stream.

`plugins/read-model` ([ADR 0058](0058-read-model-plugin.md)) is the fit, and its contract is already
the submission's own words — a watermarked cache of the log, never an authority, rebuilt by re-scan.
It also upgrades the design's best property from a discipline to a structure: with extraction over
ordinary run logs, **no run has a write path into profile state**, because no run writes profile
events at all.

### D5 — Floor-node identity is explicit, or the floor is not one (W1, gated)

`packages/blueprint-runtime/src/widgets.ts` derives a widget id from a hash of `kind + props` when
none is supplied, and changes it whenever any prop changes — documented in the file, and correct for
a view authored once. A floor whose nodes take derived ids therefore stops being a floor the moment
a cohort's generator varies a floor node's title or density, silently.

**Floor nodes MUST carry explicit ids.** The corresponding *check* — that two blueprints name the
same node ids — is a pure function of the shape `validateBlueprint` established, and it is
**gated on [ADR 0083](0083-second-consumer-rule.md)**: it becomes 1P surface only when a second,
unrelated consumer exists. The named candidate is the a2ui revision path, which needs stable node
identity for the same reason. One consumer plus a plausible one is not two.

### D6 — Subject erasure must invalidate derived read models (W3, deferred)

`@loom/compliance` shreds the log and knows nothing about read models; `ReadModelStore`'s only
removal verb is `clear(modelId)`. A shredded subject's derived rows therefore survive with their
extracted fields intact — and those are the rows a console reads. The correct behaviour today is
`clear` + rebuild, which after the shred produces no rows for the subject, and the profile extractor
must tolerate `{ $shredded }` payloads on the `exportSubject` precedent, or the rebuild throws on the
one operator who exercised deletion.

A row-granular purge on the store SPI is **deferred behind an evidence gate**: reopen when a measured
rebuild cost at production log size exceeds the erasure SLA. Until that number exists, the available
mechanism is sufficient and the SPI addition is unjustified.

### D7 — Rejected: a render overlay in the 1P renderers, and a new gap class

An ordering/disclosure overlay reads as a renderer feature and is not one. Reordering siblings
touches no props, so ids survive it under D5; disclosure state is expressible in the app's own
catalogue, which is where a runtime-composed vocabulary belongs
([ADR 0088](0088-blueprint-conformance.md) D2). An overlay type plus support in both 1P renderers
would be new surface for a single consumer.

Likewise, "an above-floor capability this cohort did not receive" needs no new gap class: it is a
**finding** on the existing conformance report shape, which already carries a denominator — so the
non-removal invariant becomes a rate rather than an assertion.

## Consequences

- The submission's §1.4 and §A.2 arguments against learned per-user profiles rest, in three of four
  cases, on machinery loom does not ship: there is no derivation cache, no artifact-approval
  binding, and no compile-time specialization. The conclusion stands; the reasons are D2, D3 and
  explicability. This is recorded so it is not re-litigated from the absent premises.
- Nothing here changes what a consumer of the framework can call, which is why this ADR ships no
  changelog entry.

## Addendum — 2026-09-10, from implementing D6

D6 says the extractor "must tolerate `{ $shredded }` payloads … or the rebuild throws". Building
the case showed the sentence puts the failure one layer too low, in the direction that matters:

**The throw is at the SOURCE read, before any extractor runs.** `EncryptingEventStore` fails an
authoritative read of a shredded subject by design (K10-R4), and `ReadModelService`'s scan is such
a read — so a rebuild through the store the fold uses does not degrade, it does not skip the
subject, it raises `PayloadShreddedError` and indexes nothing at all. The repair D6 prescribes is
unavailable unless the rebuild is given a source configured `onShredded: "tolerate"`, which is a
deployment decision, not an extractor one.

Tolerance then hands the extractor a second decision D6 did not name: a tolerant read substitutes
`{ $shredded: true }` for each erased field, so an extractor that indexes it verbatim rebuilds the
**placeholder** into the cache. Nothing leaks — the value is genuinely gone — but every erased
subject collapses onto that single value in a field the app declared as an id, so a model keyed on
it merges erased subjects into one bucket.

Both are now pinned by `plugins/read-model/src/erasure.test.ts`, alongside the stale-row hazard
itself and the *O(log)* rebuild cost. The deferral of a row-granular purge is unchanged.

## Notes

The evaluation carries the full verdict table, the correction record, and answers to three of the
submission's open questions using existing machinery (exploration budget via reported ESS; absence
as a conformance finding; mid-run re-pinning as a typed resume gate).
