# ADR 0022 — K10: log lifecycle — retention, redaction & encryption

- Status: Proposed (amended 2026-07-10 — see [Amendments](#amendments-code-grounded-evaluation-2026-07-10))
- Date: 2026-07-10
- Requirements: [K10 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#k10--log-lifecycle-retention-redaction--encryption) — priority **P2**

## Context

The event log is an unbounded, immutable accumulation of every payload — including secrets
and PII — with no retention, archival, redaction, or encryption story. "Replay forever"
(P2) collides head-on with GDPR erasure and credential rotation. A kernel reclaims
resources; ours currently only accumulates them. This must be answered before Loom holds
regulated or production data, though it can be designed in parallel with the P0/P1 items.

## Decision

Give the log a lifecycle without ever creating a *silent* third behavior between "replays
identically" and "fails loudly":

- Stores support **terminal-execution retention policies** (archive/delete completed
  executions after N days), exposed through `defineConfig({ retention })`; replay of an
  archived execution may require rehydration but remains byte-identical (K10.1).
- **Crypto-shredding**: payload fields marked sensitive in a step/tool schema are encrypted
  per-execution (or per-subject) at append; destroying the key satisfies erasure while
  leaving the log structurally intact. Replay of a shredded execution fails *explicitly*
  with **`PAYLOAD_SHREDDED`**, never silently diverges (G1) (K10.2).
- Field-level redaction markers (`z.string().brand("secret")` or equivalent) keep secrets
  out of the log entirely, substituting a deterministic reference resolved only inside the
  K7 boundary (K10.3).
- Snapshot + prefix-truncation ("compaction") for very long executions, with the invariant
  `fold(snapshot, suffix) === fold(events)` conformance-tested (K10.4).
- Encryption-at-rest configuration documented for both SQLite and Postgres backends (K10.5).

## Acceptance criteria

A conformance suite proves: retention removes eligible executions and only those; a shredded
field is unrecoverable from disk; replay of shredded/compacted logs either reconstructs
identically or fails loudly with the designated fact — never a third behavior.

## Consequences

- "The log remembers" gains the qualifier a real system needs: *until policy says forget* —
  and forgetting is itself explicit, durable, and replay-honest.
- New durable fact `PAYLOAD_SHREDDED` enters the K5-governed schema (additive → MINOR); the
  fold reference must be updated.
- Redaction references (K10.3) resolve through a `SecretResolver` seam — inside the K7
  boundary ([ADR 0019](0019-k7-data-plane-isolation-and-egress-control.md)) when isolation
  is wired, in-process otherwise (see Amendments — this decoupling is what keeps K10
  parallelizable at P2).
- Unwired (no retention config, no sensitive markers), storage behavior is byte-identical
  (G2).

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [K10 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#k10--log-lifecycle-retention-redaction--encryption--accept-with-amendments)
(verdict: **Accept with amendments**):

- **A1 — shred × snapshots (closes a hole in this ADR's own acceptance criterion)**:
  snapshots store *folded plaintext*; shredding event payloads while snapshots survive is
  erasure theater, and compaction (K10.4) would institutionalize it — replay-from-snapshot
  would *succeed silently with the erased data*, the forbidden third behavior. Shredding
  covers snapshots (delete or re-encrypt affected executions' snapshots); the conformance
  suite tests shred × snapshot × compaction jointly.
- **A2 — fork lineage**: `fork()`/`copyPrefix` copies a parent prefix into a child
  execution. Key management defines lineage explicitly: per-subject keys (shared ciphertext
  is jointly shredded *by design*) or fork-registered key lineage — shredding a parent is
  never an undocumented effect on children.
- **A3 — tombstone timing**: `PAYLOAD_SHREDDED` is appended **at shred time** by the
  lifecycle service (a tombstone into the affected execution's log), never at replay time —
  replay stays pure/read-only (P2) and deterministically *encounters* the tombstone.
- **A4 — perf guardrails**: encryption is field-level, opt-in per marked field only;
  envelope encryption with cached data keys; ships an append-path benchmark (marked vs
  unmarked) plus the unwired bench (no markers ⇒ byte-identical append, G2).
- **A5 — SecretResolver decoupling** (applied in Consequences above): the MUST is "secrets
  never enter the log", not "K7 is a prerequisite".
- **A6 — retention posture**: archive-before-delete is the documented default — naive
  deletion starves the learning plane (`OUTCOME_RECORDED` mining,
  [ADR 0018](0018-learning-seam-outcome-recorded.md)) and the deploy-sim historical corpus.
