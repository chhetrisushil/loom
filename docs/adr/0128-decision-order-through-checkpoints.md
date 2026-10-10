# ADR 0128 — Carry decision order through checkpoints: a recorded sequence on each folded decision

- Status: **Accepted** (2026-10-11) — option A, by the user's decision; implemented (see "Implementation note").
- Date: 2026-10-11
- Closes (if accepted): the logged follow-up "carry decision order through checkpoints (needs a fold ordinal — ABI)" ([ADR 0116](0116-late-outcome-attach.md), round 4 item 2).
- Builds on: [ADR 0106](0106-compaction-integrity.md) (what compaction keeps), [ADR 0116](0116-late-outcome-attach.md) (evidence from the fold, `evidenceEvents`), [ADR 0079](0079-decision-context-and-policy.md) / [ADR 0124](0124-learning-lifecycle.md) (the learning consumers), [ADR 0026](0026-t2-wire-level-kernel-abi.md) (the fold vectors are a cross-implementation contract).
- Placement: **kernel** for the one field (the information is lost INSIDE the kernel's fold; no consumer can reconstruct it afterwards); **1P** (`@loom/learning`) for reading it. If the user prefers no kernel change, the 1P-only fallback (option E) is the answer and this ADR is Rejected.
- Version impact if accepted: `EVENT_SCHEMA` 1.23.0 -> **1.24.0** (additive). `KERNEL_ABI`, every SPI: unchanged.

## Context

A checkpoint (compaction, ADR 0106) folds `DECISION_RECORDED` events into `state.variables._decisions` and frees them. `_decisions` is a plain object keyed by `decisionId` (`packages/replay-vm/src/eventHandlers.ts`, `DECISION_RECORDED`), so the ONLY record of the order decisions were made in, once the events are gone, is the object's key order. That is not a durable fact:

1. JavaScript lists array-index-like keys (`"10"`, `"2"`) first, ascending, regardless of insertion order.
2. A snapshot store that normalises JSON loses it entirely. The Postgres snapshot store writes `jsonb` (`plugins/postgres/src/PostgresSnapshotStore.ts`, `$5::jsonb`), and `jsonb` orders keys by length, then bytes. This one is not an edge case: it affects EVERY compacted execution on Postgres with more than one decision.
3. SQLite stores text JSON and keeps order, so the same execution behaves differently per backend.

The fold is "complete" for what each decision WAS (ADR 0116) but not for WHEN. The log never had this problem because the event `sequence` is the order.

### Who needs it

- `@loom/learning` `trajectories(evidenceEvents(state, log))`: the **discounted terminal credit** (`discount < 1`) weights each decision by its distance from the end of the run. Direct-outcome credit, `discount = 1` (the default), per-arm statistics and policy evaluation are order-free, which is why this stayed a logged follow-up. `evidenceEvents` rebuilds absorbed decisions with their key-order ordinal as `sequence`; that number is currently wrong on Postgres.
- `loom learn report|eval` (reads checkpoints since ADR 0116 round 4) inherits the same error.
- Second consumer to confirm before acceptance (ADR 0083): `@loom/analytics` `replay.ts` reads `_decisions` for the decision timeline; any per-execution "what was decided, in order" view over a compacted run has the same hole. If the user finds only the learning lens real, option E is the honest alternative.

### Concrete failing scenario

Policy-driven agent, `trajectories(..., { discount: 0.5 })`, terminal success. It records decisions `route-b` then `route-a` (same length, so `jsonb` sorts by bytes). Uncompacted, `route-a` is last and takes full terminal credit, `route-b` half. Compact, load the snapshot from Postgres: `_decisions` now reads `route-a`, `route-b`; `evidenceEvents` assigns ordinals 1, 2 in that order, so `route-b` takes full credit and `route-a` half. The learner trains on swapped credit, silently, and only for compacted executions. The in-repo tripwire is `it.fails("IDEAL (known limit): absorbed array-index-like ids keep their true order")` in `packages/learning/src/loop.test.ts` (it covers the JS half; the Postgres half has no test because the in-memory snapshot store keeps order).

## Options

**A. Stamp the event sequence on each folded decision (recommended).** `DECISION_RECORDED`'s handler writes `seq: event.sequence` into the entry, taken from the ENVELOPE (not the payload) and kept from the FIRST record of an id (a repeated id keeps its slot today; it keeps its `seq` too). Descriptive, never a replay input: `getDecision` still returns only `choice`.
- The fold stays pure: `event.sequence` is part of the log, so replaying events is byte-identical and the event bytes never change. Precedent: the same handler already stamps `recordedAtSeq: event.sequence` on inner-step overflow, and `ReplayVM` already reads it.
- It is a value, so it survives `jsonb`, key reordering and array-index ids. It is also EXACT, not a re-derived ordinal: `evidenceEvents` can use it as the rebuilt event's `sequence`.
- Cost: one integer per decision (~12 bytes folded); no new container.
- Impact: `EVENT_SCHEMA_VERSION` 1.24.0 plus a history comment ("additive field on the folded `_decisions` entry"); fold vectors in `packages/wire-abi/src/foldVectors.ts` gain/alter vectors (every existing `_decisions` expectation grows `seq`); `eventSchema.test.ts` pin; `docs/spec/compatibility-matrix.md` row (regenerate with `loom kernel-manifest --emit-docs`), the version strings in `docs/spec/loom-kernel-specification.md` (section on the event schema), `docs/cheatsheet-features.md`, `docs/usage-cli.md`. Whether `WIRE_ABI_VERSION` (1.0.0) bumps for added vectors is for ADR 0026's rule to settle during implementation (the vectors are the contract, so a foreign fold that does not stamp `seq` fails them either way, which is the intent). `KERNEL_ABI` (syscalls) and all SPIs: no change. A third-party snapshot store needs nothing: it stores state opaquely.
- **Existing snapshots.** A snapshot written by a 1.23 fold has no `seq` on its absorbed entries. The spec invariant `fold(snapshot_k, tail) == fold(events)` (spec sections on snapshots, 1.21.0 precedent) then holds EXCEPT for the missing `seq` of absorbed decisions, exactly as for the 1.21.0 shapes; the fix is the same pattern, an entry without `seq` is "legacy" and is read in folded-map order (today's behaviour). No rewrite pass: nothing is destroyed, and the lost information cannot be recovered for already-compacted runs anyway. State this explicitly in the spec text; do NOT make `normalizeSnapshotState` invent a `seq`.
- Replay byte-identity: event log bytes, hash chains (computed over envelopes) and `getDecision` are unchanged. Folded STATE bytes change (a new key), so any golden test that snapshots a folded `_decisions` updates; implementer must grep for state hashing (none known).

**B. A parallel `_decisionOrder: string[]`.** Order survives `jsonb` (arrays are ordered) but duplicates every id (O(D) strings versus O(D) integers), needs an in-place owned-container rule like `_decisions` (R1a), and two structures can disagree. Same version impact as A. Rejected as strictly larger.

**C. Order in the snapshot record, not the state.** `Snapshot` gains `decisionOrder`; `SNAPSHOT_STORE_SPI_VERSION` 1.1.0 -> 1.2.0, every store (memory, SQLite, Postgres, encrypting decorator), conformance kit, `loadState` consumers would not see it, and `fold(snapshot, tail)` would need a side channel. Rejected: SPI churn across three stores to avoid one integer in the fold.

**D. Derive from the log.** Keep decision events in place at compaction. Already rejected in ADR 0116 round 3 (2000 decisions x 2 KB stayed at 4 MB; compaction becomes unable to reclaim a long agent run).

**E. No kernel change (1P/doc only).** Keep today's behaviour: `discount = 1` is exact, document that `discount < 1` over compacted Postgres executions is approximate, and let apps that need exact order use sortable ids (zero-padded counter) AND a snapshot store that keeps key order. Zero risk, but the error is silent and backend-dependent, and a learner cannot detect it. Acceptable only if the user judges `discount < 1` on compacted runs not worth a schema minor.

## Triage (ADR 0083 / P10)

Kernel only for the one field, because the loss happens inside the fold and the checkpoint is the kernel's own artifact: a plugin cannot add the information back after the events are freed. Everything that USES the order is 1P: `evidenceEvents` sorts absorbed entries by `seq` when present and uses it as the rebuilt `sequence`, falls back to map order for legacy entries, and the `it.fails` test becomes a plain passing test (the file's comment says to delete `.fails` the day order is carried). No new package, no new syscall, no new SPI method. Smallest safe change = option A, ~15 lines in the fold plus vectors and docs.

## Decision needed from the user

1. Accept a kernel schema minor (EVENT_SCHEMA 1.24.0) for option A, or choose option E (document, no kernel change)? Recommendation: A.
2. If A: does a repeated `decisionId` keep its FIRST `seq` (matches the slot rule; recommended) or take the last?
3. If A: field name (`seq`, proposed; `recordedAtSeq` is already taken by the overflow semantic, so it is avoided) and confirmation that legacy snapshots are read in map order with no migration.
4. Is `WIRE_ABI_VERSION` bumped for new fold vectors? (Settle against ADR 0026 at implementation; flagged here so it is not discovered late.)

## Test plan (when accepted)

Fold vectors for first-record `seq`, repeated id, and a vector WITHOUT `seq` (legacy) folding unchanged; `evidenceEvents` equality compacted vs uncompacted for `discount < 1` including array-index ids and a `jsonb` round trip against a throwaway Postgres 17 (the Postgres half has no test today); snapshot-plus-tail equals full fold for a post-1.24 snapshot; a legacy snapshot reads in map order.

## Implementation note (2026-10-11)

User decisions: option A; a repeated `decisionId` KEEPS its first `seq`; the field is `seq`; legacy snapshots are read in map order with no migration; `WIRE_ABI_VERSION` is not bumped.

- **Fold** (`packages/replay-vm/src/eventHandlers.ts`, `DECISION_RECORDED`): stamps `seq: event.sequence` from the envelope. A repeat keeps the first `seq`; a repeat of a legacy entry (no `seq`) stays without one, because its first sequence is unknowable and stamping a later one would misplace it. `EVENT_SCHEMA_VERSION` 1.23.0 -> 1.24.0.
- **WIRE_ABI_VERSION stays 1.0.0.** ADR 0026 versions the wire protocol (a projection of the syscall ABI that a wire client negotiates on); it sets no rule that the fold vectors are versioned with it, and the 1.23.0 vectors were added with no bump. The vectors are the conformance contract, and a foreign fold that does not stamp `seq` fails them, as intended. Existing `_decisions` expectations in `FOLD_VECTORS` gained `seq`; one new vector pins first-record `seq`, a repeated id, an array-index-like id and a payload-supplied `seq` being ignored.
- **State hashing:** none. The folded `_decisions` is hashed nowhere (hash chains are over envelopes; `approvalBinding`, content and policy hashes cover other inputs), so no persisted or compared hash changes for an existing execution. Folded STATE bytes change; the goldens that pinned an entry (`decisionD1`, `foldScale` oracle, wire-abi vectors) were updated.
- **Consumer:** `@loom/learning` `evidenceEvents` rebuilds absorbed decisions sorted by `seq`, with `seq` as the event `sequence` (and drops it from the rebuilt payload). Legacy entries come first, in map order, with negative ordinals so the two kinds never interleave. The `it.fails` tripwire in `loop.test.ts` is now a plain passing test, with a legacy-snapshot test beside it and the Postgres half: a run deciding `route-b` then `route-a` is compacted on the real Postgres stores (`jsonb` lists `route-a` first) and its `discount: 0.5` credit equals the uncompacted one; it fails without the stamp. `@loom/analytics` `replay.ts` only counts `DECISION_RECORDED` events, orders nothing from `_decisions`, so it is not a second consumer and is unchanged.
- **Docs:** specification section 3 (compatibility), `10-event-schema-reference.md`, compatibility matrix, cheatsheet, `usage-cli.md`, CHANGELOG.
