# ADR 0057 — Multi-gate suspend passthrough: the ordered `_resumePayloads` fold (EVENT_SCHEMA 1.16.0)

- Status: **Accepted — shipped** (fold list + counted passthrough + legacy fallback)
- Date: 2026-07-15
- Builds on: the suspend/resume machinery (P2 determinism), K5 event-schema governance,
  found by the [perpetual-agents W8 audit](../requirements/2026-07-15-perpetual-agents-audit.md)
  (first flagged during ADR 0056's testing).
- Part of: the perpetual-agents series (W8, issue #172) — a pre-existing kernel bug fix,
  orthogonal to the series' features.

## Context — the silent bug

A flow re-runs from the top on every resume; recorded steps replay from frames, and a
suspend gate that was already resumed must *pass through* instead of re-parking. The
passthrough was built for one gate: the fold kept only the **latest** resume payload
(`variables._resumePayload`, overwritten by each `EXECUTION_RESUMED`) and the context had
a single-shot consumed flag.

For a flow with two sequential bare gates, the second resume replayed like this: gate 1
passed through — **with gate 2's payload** (the latest) — then gate 2 found the
passthrough consumed and re-parked. Net effect: wrong data through gate 1, and the run
never progresses past gate 2 (for timer gates, an infinite re-wake loop). Silent — no
error, no warning. No flow in the repo used two sequential bare gates, which is why it
survived; the audit's mechanism trace confirmed it as a real bug, not a documented
limitation.

## Decision

**The fold records the ordered list; the context consumes by index.**

- `EXECUTION_RESUMED` now also appends its payload to `variables._resumePayloads`
  (ordered, append-only — the same `appendAudit` idiom as `_migrations`). The
  single-latest `_resumePayload` is kept for compatibility.
- `ctx.suspend` maintains a consumed **count**: the *i*-th suspend call in a re-run
  passes through with payload *i*; a gate beyond the recorded resumes throws and parks,
  exactly as before. Each gate now receives **its own** recorded payload.
- **Legacy fallback:** a pre-1.16 snapshot folded only `_resumePayload`; the context
  treats it as a one-entry list, so single-gate flows resume byte-identically. (Pre-fix
  multi-gate logs were already broken — there is nothing behavior-preserving to keep.)

EVENT_SCHEMA 1.15.0 → 1.16.0: additive fold key derived from existing events — no new
event kinds, no payload changes, `knownEventTypes()`/PINNED untouched. A log that never
resumes twice folds one extra list entry alongside the legacy key; single-gate replay
behavior is regression-tested unchanged.

## Alternatives considered

- **Clear `_resumePayload` on `EXECUTION_SUSPENDED`** — fixes the wrong-payload half but
  not ordering (gate 1 would get *no* payload on the second re-run), and mutates the
  meaning of an existing fold key for old logs. Rejected.
- **Key passthrough by the suspend condition (`on`)** — breaks flows that legitimately
  reuse a condition name across gates, and requires pairing logic the ordered list gets
  for free (suspends and resumes strictly alternate per execution). Rejected.

## Consequences

- Multi-gate human/approval flows are now correct — three regression tests (two-gate
  payload ordering, three-gate completion, legacy single-payload fallback).
- `ctx.sleep` chains (multiple timer gates in one flow) are fixed by the same mechanism.
- The W8 audit's other fixes ship alongside: iterative cycle-safe gc ref walk, depth-
  capped `stableStringify`, symlink-skipping lint walk (see the audit doc for the full
  disposition table, including the DS&A suggestions rejected with rationale).
