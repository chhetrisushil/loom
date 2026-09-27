# ADR 0022 — K10: log lifecycle — retention, redaction & encryption

- Status: Accepted (implemented 2026-07-10 — K10.2 `@loom/store-crypto`:
  `EncryptingEventStore` + `EncryptingSnapshotStore` (field-level AES-256-GCM under
  per-subject keys, A4/A1), `shredSubject` destroys the key and tombstones `PAYLOAD_SHREDDED`
  at shred time (A3; event schema 1.8.0), reads of a shredded subject throw
  `PayloadShreddedError` and the fold records `variables._shredded`; fork key-lineage via
  `subjectOf` (A2); decoupled seam (A5). K10.1 retention + K10.4 compaction: `LogLifecycle`
  (`@loom/workflow-runtime`) with `EventStore.deleteExecution`/`truncatePrefix` +
  `SnapshotStore.deleteExecution` optional SPI (in-memory / SQLite / Postgres);
  `applyRetention` reclaims terminal-and-aged executions **archive-before-delete** (A6);
  `compact` checkpoints then truncates the prefix (sequence 0 preserved) with
  `fold(snapshot, suffix) === fold(events)` conformance-tested. K10.3 redaction markers:
  `secretRef` + `SecretResolver` + `redactionMiddleware` (`@loom/middleware`) — a step's I/O
  carries a deterministic reference, resolved to the real value at effect execution (the
  middleware seam, kernel-side of any K7 boundary, A5), so the secret NEVER enters the log
  (verified end-to-end); the effect-middleware `next(input?)` contract was extended (backward-
  compatibly) to let a middleware transform the value the effect receives without touching the
  logged input. K10.5 encryption-at-rest configuration documented for both SQLite and Postgres
  backends — [11-encryption-at-rest.md](../loom-2.0/11-encryption-at-rest.md) — framed as the
  third, storage-layer protection distinct from (and stacking with) K10.2 field-level crypto
  and K10.3 redaction. **K10 complete.** Amendments below applied.)
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
  with **`PAYLOAD_SHREDDED`**, never silently diverges (G1) (K10.2). A read may opt into a
  **tolerant mode** (`onShredded: "tolerate"`) that substitutes a `{ $shredded }` placeholder
  instead of throwing — for OFF-log consumers only (deploy-sim, eval, export), never the
  authoritative fold (K10-R4; see amendment A7).
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
  envelope encryption with cached data keys. The *marked-vs-unmarked* append benchmark is now
  shipped (`plugins/crypto/src/append.bench.ts`, K10-R7): a wrapper with an empty sensitive
  map is within ~1.3x of an unwrapped `append` (a single map lookup, no crypto — G2), while
  one encrypted field costs ~20x (the honest opt-in price, paid only per marked field).
- **A5 — SecretResolver decoupling** (applied in Consequences above): the MUST is "secrets
  never enter the log", not "K7 is a prerequisite".
- **A6 — retention posture**: archive-before-delete is the documented default — naive
  deletion starves the learning plane (`OUTCOME_RECORDED` mining,
  [ADR 0018](0018-learning-seam-outcome-recorded.md)) and the deploy-sim historical corpus.
- **A7 — K10-R5 completion** (2026-07-13): `applyRetention` now (1) journals its own pruning
  as pinned control facts `EXECUTION_ARCHIVED`/`EXECUTION_DELETED` to a reserved
  `__loom_lifecycle__` stream (P9 — structure survives even as values are deleted;
  `EVENT_SCHEMA_VERSION` → 1.13.0), and (2) refuses to delete a terminal execution while a
  **live descendant branch** still depends on its copied prefix (`blocked-by-branch`, wired
  off the `BranchRegistry`) — a latent-correctness fix. `defineConfig({ retention })` is now
  real and exposes `app.lifecycle` for an explicit, non-background pass (no timer prunes the
  log). `loom retention run` (dry-run by default, `--apply` to reclaim) is **shipped**, on the
  `listExecutions` store-SPI enumerator (EVENT_STORE_SPI 1.1.0).

## Amendment (2026-09-27) — the compaction/archive key rule

`EncryptingEventStore` used to drop `deleteExecution` and `truncatePrefix`, and
`EncryptingSnapshotStore` dropped `deleteExecution`. So `applyRetention` reported every
encrypted execution `unsupported`, `compact` was a silent `null`, and encrypted logs grew
forever (ADR 0074 Amendment, same date). Both are now forwarded, because deleting or truncating
ciphertext only removes data. Forwarding is not enough on its own, though. Two lifecycle
operations move data OUT of the store they read:

- `applyRetention` archives the events it read through the decorator, which are plaintext,
  along with the latest snapshot, into `archive.eventStore` and `archive.snapshotStore`.
- `compact` saves the decrypted fold as a snapshot and then truncates the ciphertext.

If the destination does not encrypt under the same keys, shreddable ciphertext becomes
plaintext at rest, and destroying the subject's key no longer erases it. That is A1's "erasure
theater" hole reached through a different door.

Decided. Checks are structural (identity of the `keys` object an encrypting store exposes, the
probe `loom doctor` already uses) and run before anything is read, copied, saved or truncated:

- **`compact` throws `UnsafeCompactionError`** when the event store has `keys` and the snapshot
  store's `keys` is not that same object. It throws rather than returning `null`, because
  `null` already means "nothing to compact", and a guard that answers like a no-op is a guard
  nobody notices firing.
- **`applyRetention` and `evaluate` return `"unsafe-archive"`** when an archive is configured,
  the source encrypts, and `archive.eventStore` or `archive.snapshotStore` does not share the
  source's `keys`. The dry run and the apply agree.
- **The marker survives decoration.** `installOptional` carries `keys` up through every
  decorator built on it, and `ShardedEventStore` exposes one shared KeyStore. If its shards
  disagree it exposes a marker that no snapshot store can match, so the guard fails closed.
  Without this, forwarding `truncatePrefix` would have made `Coalescing(Encrypting(pg))`
  compactable into a plaintext snapshot store. The decorator conformance kit asserts that the
  marker survives.
- **Not checkable structurally:** whether the destination's `sensitive` paths cover every copy
  of a value in the fold. A step input held in `frames`, for example, is outside the default
  `variables._input` path. This is the same limit as the original K10.2 design and
  `loom doctor`'s encryption check. Declaring coverage stays the operator's job.

Adjacent fix in the same file: `evaluate` folded only the surviving log. A log compacted
through its tip is just the bootstrap event, so a compacted execution read as `not-terminal`
forever and could never be reclaimed. The fold now resumes from the latest snapshot when the
log has a gap or only the bootstrap left.

Tests: `log-lifecycle.test.ts` compacts and retains an encrypting store over SQLite. It then
shreds the subject and asserts that the compaction snapshot and the archive both throw
`PayloadShreddedError`. The negative cases assert that a plaintext snapshot store and an archive
under different keys are refused and that nothing is copied, saved or truncated.
