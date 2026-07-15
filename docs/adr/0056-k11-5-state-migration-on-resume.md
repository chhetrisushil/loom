# ADR 0056 — K11.5: contract-versioned state migration on `resumeAs` (EVENT_SCHEMA 1.15.0)

- Status: **Accepted — shipped** (`resumeAs({ transformState })`, `EXECUTION_MIGRATED.migratedInput`,
  `StateMigrationError`)
- Date: 2026-07-15
- Builds on: [ADR 0051 D6](0051-perpetual-agents-placement-schedule-remodel.md), ADR 0023 (K11
  code versioning), K5 event-schema governance.
- Part of: the perpetual-agents series (W4, issue #168). The series' only event-schema change:
  additive MINOR, 1.14.0 → 1.15.0. KERNEL_ABI unchanged.

## Context

K11 migrates **code**: hash pinning, version-aware registry, `resumeAs` with replay-check. What it
could not do is migrate **state**: a long-suspended execution (human gate, A2A wait) whose
recorded input no longer matches the evolved contract of the flow it must resume on. `resumeAs`
would hand the new runner the old-shaped input — the exact contract mismatch the requirements
(§4 K11.5) demand be impossible. Deliberately specified as a general K11 amendment, not a
chain/sentinel feature: schedule-driven agents barely need it (each wake starts fresh; carry-state
migration is `@loom/plugin-durable-state`'s job), but any long-suspended execution has it.

## Decision

### D1 — The state contract carrier is the recorded input (`_input`); the transform's OUTCOME is durable

`resumeAs` gains `transformState?: (input) => input` (typically a Zod transform's `parse`). It is
applied at migration time to the **folded** `_input` — which a *prior* migration may already have
replaced — and the **result** is recorded on the existing `EXECUTION_MIGRATED` event as an
optional `migratedInput` payload field. The function is never durable; the outcome is (the same
record-the-outcome move as `ctx.decide` and every recorded effect). Determinism follows: replay
folds the recorded value; it never re-runs the transform.

Extending `EXECUTION_MIGRATED` won over a new event kind on fold simplicity (ADR 0051 D6's open
choice): the migration is already one durable fact; giving state migration its own event would
split one atomic act across two events with ordering to govern.

### D2 — The fold replaces `_input`; every resume path reads the fold

`EXECUTION_MIGRATED`'s handler now sets `variables._input = migratedInput` when present and stamps
`stateMigrated: true` on the `_migrations` audit entry. The three input paths converge on the
fold: `restore()` already read `variables._input`; `resume()` and `resumeAs()` now prefer the
folded `_input` over the raw `EXECUTION_STARTED` payload. A later plain `resume()` — different
process, no transform in sight — therefore hands the runner the migrated input, proven by a
hand-crafted-history test (migration fact recorded, deploy crashed before its own resume ran).

### D3 — Absent or failing transform: explicit, nothing appended

No transform = byte-identical to before (G2; regression-tested). A throwing transform (or one
returning `undefined`) refuses the migration with a typed `StateMigrationError` **before any
event is appended** — the execution is untouched, exactly K11's current refusal discipline with
an escape hatch.

## Schema governance

EVENT_SCHEMA 1.15.0: additive optional payload field on an existing kind; no change to
`knownEventTypes()` / `PINNED_EVENT_TYPES`. A log that never migrates state replays
byte-identically (the fold reads the field only when present).

## Consequences

- The requirements' acceptance criterion 7 (suspended human gate crossing a contract-evolving
  deploy: migrates with a transform, refuses explicitly without one) is now mechanically true.
- `transformState` composes with both strategies (`replay-check` still guards step-shape
  compatibility; the transform guards input-shape) and with pinned-version resumption.
- Found in passing, parked for the W8 audit: `WorkflowContext`'s suspend passthrough is
  single-shot per re-run, so two sequential bare `ctx.suspend` gates do not replay past the
  first on a later resume — a pre-existing limitation orthogonal to this change.
