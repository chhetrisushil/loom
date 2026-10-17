# ADR 0039 — Execution-Lifecycle Authorization (`ExecutionAuthorizer` + `EXECUTION_DENIED`)

- Status: Accepted (2026-07-11)
- Date: 2026-07-11
- Builds on: the K2 `CapabilityAuthorizer` (gates effects) and the K12.1 `PrincipalChain` threaded
  from the trust boundary (`RunOptions.principal`).
- Part of: the three-direction kernel arc, multi-tenant isolation (Direction C), Phase 3.

## Context

Loom gated **effects** inside a running execution (K2 `GrantTable`/`CapabilityAuthorizer` → durable
`EFFECT_DENIED`), but the **execution lifecycle itself** — who may `start`, `resume`, `cancel`, or
`query` an execution — was ungated. Any caller reaching the runtime API could start, resume, cancel,
or read any execution by id. For multi-tenant hosting that is a real gap.

## Decision

Add a pluggable **`ExecutionAuthorizer`** — `authorize({ op, executionId, workflowId, principal })
→ { allowed } | { allowed: false, reason }` — wired via `WorkflowRuntimeDeps.executionAuthorizer`.
It mirrors the K2 capability authorizer one level up. `start`/`resume`/`cancel` and the public
`loadState` (query) consult it; a denial throws **`ExecutionDeniedError`**.

**Trust-boundary model.** The authorizer is consulted only when it is configured **and the call
carries a `principal`** — the edge (HTTP/API/A2A server) attaches the authenticated principal, and
principal-less kernel-internal calls (TimerService, recovery, `cancel`'s internal fold) are
unaffected, byte-identically (G2). Internal folds use a new private `foldState`; the public
`loadState` = `foldState` + a query authorization (folding is pure, so authorizing after is safe and
a denied read never writes).

**Durable audit — safely.** A denied `resume`/`cancel` best-effort records a durable
`EXECUTION_DENIED` fact (symmetric to `EFFECT_DENIED`; folds into `_executionDenials`, pure audit).
Crucially it is appended **WITHOUT acquiring a fence**, so it can never fence-out (disrupt) a
running execution; on a fencing store with an active fence the append is simply rejected and skipped
— the enforcement is the thrown error, which never depends on the record. Denied `start` (no
execution yet) and `query` (read-only) throw without a record. An `onExecutionDenied` callback
surfaces every denial for telemetry regardless.

New event type `EXECUTION_DENIED` → **`EVENT_SCHEMA_VERSION` 1.12.0** (added to `knownEventTypes()` +
the pinned list). **No `KERNEL_ABI` change** — this is a boundary check, not a new syscall.

## Consequences

- Multi-tenant hosts can enforce per-tenant/per-principal control over the execution lifecycle, with
  a tamper-evident (Phase 1 hash-chain-compatible) denial trail for the sensitive `resume`/`cancel`
  ops.
- **Opt-in, byte-identical when unwired** (G2): unset authorizer ⇒ every op permitted; the full
  existing suite passes unchanged, and an explicit "no authorizer" test asserts start→query→resume
  is unaffected.
- Honest scope: enforcement is at the trust boundary (principal-bearing calls). Principal-less
  internal calls bypass by design — the kernel stays generic (P10); the edge authenticates. Durable
  denial recording is best-effort (skipped on a fencing store with an active fence) to guarantee it
  never disrupts a running execution; the throw is the invariant, the record is audit.

## Verification

- `c1-lifecycle-authz.test.ts` (6): no authorizer ⇒ start/query/resume unaffected (G2); a permitted
  principal passes start→query→resume; a denied `start` creates no execution (nothing written); a
  denied `resume` throws AND records exactly one `EXECUTION_DENIED { op: "resume", actor }` while the
  execution stays resumable by a permitted principal; denied `cancel`/`query` throw and fire the
  audit callback; a principal-less call bypasses even a deny-all authorizer.
- `eventSchema.test.ts` pins `EXECUTION_DENIED` (schema 1.12.0); `abi.test.ts` unchanged (no
  syscall). `@loom/spec` registers `execution-authz` at L2. Full runtime suite 109/109.

## Amendment (2026-10-17) — the verdict comes before the fold

The Decision above says the public `loadState` is `foldState` plus a query authorization, "folding is
pure, so authorizing after is safe". Folding is pure, but it can **throw**, and the error is
caller-visible: `PayloadShreddedError` for a crypto-shredded execution, a failing or foreign
checkpoint (`SnapshotIdentityMismatchError`, a key-unavailable load), an unreadable sequence 0. A
caller the authorizer would refuse (another tenant) therefore learned that an execution exists and
what became of it (an existence-and-status oracle; no payload content). `resume` and `resumeAs`
leaked the same way (they load the checkpoint and read and fold the log before asking), and
`resumeAs` additionally ran the caller's `transformState` over the RECORDED INPUT before the
authorizer was asked. `send`, `discardInbox`, `quarantineInbox`, `releaseInbox`, `recordOutcome`,
`fork` and `acquireFence` already asked first but read sequence 0 unguarded, which raises the same
erasure error when the recorded principal is itself sealed and shredded.

**Rule.** For every authorizer-gated op the verdict is reached from **sequence 0 alone** (the
plaintext workflow id and the recorded principal, one point read that `ownerForAuthz` reuses), before
any checkpoint load, fold, full read or caller-supplied code. A sequence 0 this node cannot decode
BECAUSE OF AN ERASURE (`PayloadShreddedError`, or a `KeyUnavailableError` whose redacted view records
the erase intent) is an execution that EXISTS with an UNKNOWN owner: the policy decides exactly as for
any unknown-owner execution, so the denied caller gets the ordinary `ExecutionDeniedError`, never a
status-revealing error. A stream-level seal refusal is unchanged (ADR 0130 D7: `sealedOp` words it as
that op's unknown-owner denial; the seal guard also turns a raw `KeyUnavailableError` into that
refusal before `readAnchor` sees it, so the intent test is a defensive second layer). An authorized
caller is unaffected: it proceeds to the same fold and gets the same errors as before (a shredded
execution still raises `PayloadShreddedError`; `cancel` still folds the redacted view and works;
`acquireFence` and `fork` re-read an unreadable sequence 0 so a caller the policy lets through, e.g.
`unknownOwner: "allow"`, gets the original error instead of proceeding).

**Failures that are not erasures.** Any other failure to read sequence 0 (a storage fault, a transient
key-service error, a `KeyUnavailableError` without the erase intent) says nothing about the execution,
so it is NOT an unknown owner: judging it so denied the legitimate owner (a false `onExecutionDenied`,
e.g. a worker's `acquireFence` during a database blip) and reported a missing id as existing. It throws
the new `ExecutionStoreUnavailableError` (`@loom/workflow-runtime`): retryable (`retryable: true`),
carrying only `op` and `executionId`, with no cause, workflow id, subject or redacted view, and
IDENTICAL for the owner and a stranger (a fault must not become a status oracle). The real cause goes
to `onStorageError`. `cancel` of a live execution and `restoreFromState` read the owner through the
same anchor read (they have none in hand), so they follow the same rule. (The earlier residual that
`ownerForAuthz` kept a catch-all "unknown owner" for the lineage walk is superseded by the next
paragraph; one narrower lineage residual remains, recorded there.)

**Owner-resolution faults (2026-10-17, second amendment; FU-B).** `ownerForAuthz` ran AFTER sequence
0 had been read fine and swallowed every failure as an "unknown owner": the principal resolver or
codec throwing, the sequence-0 read it does itself when the caller holds no anchor, or a store
fault on a parent link of the lineage walk. With the default `unknownOwner: "deny"` that falsely
DENIED the real owner (a non-retryable `ExecutionDeniedError`, a false `onExecutionDenied`), and
under `unknownOwner: "allow"` it ADMITTED a stranger on a transient fault. The same rule as the
anchor read now applies to the whole owner-resolution path: only a PROVEN erasure
(`PayloadShreddedError`, or a `KeyUnavailableError` recording the erase intent; one shared
`isErasure` test, applied ONLY to `ownerForAuthz`'s own sequence-0 read, never to a throw of the
principal resolver or codec, which is app code: an error that merely names itself
`PayloadShreddedError` is still a fault and cannot forge an unknown owner) is an unknown owner; a stream-level seal refusal is unchanged; EVERY other
failure is the sanitized, retryable `ExecutionStoreUnavailableError` (same shape and the same
`onStorageError` report of the real cause, for the owner and a stranger alike). A fault is never
an allow, for anyone, and nothing is appended or audited. A legitimately unresolvable record (the
resolver returns `undefined`, a delegation it cannot restore, a shredded or malformed principal
record) is NOT a fault: it still yields the unknown owner and the policy decides, as before. The
`system` grant never reaches this path. Existence oracle: `ownerForAuthz` is reached only once
sequence 0 exists (a missing id returns earlier), so a stranger who now sees
`ExecutionStoreUnavailableError` where they saw a denial learns only that the id exists, which the
denial (versus a missing id's not-found) already told them. Two qualifications. (1) Bounded by an
outage only for a TRANSIENT fault: a principal resolver that throws DETERMINISTICALLY (a bug, a
revoked credential, a record it cannot handle) makes the signal PERSISTENT, for as long as the
resolver stays broken, and it is a per-execution signal if the resolver fails only for some records.
(2) For an ANONYMOUS caller under `requirePrincipal`, a missing id is made to look like a denial
(`denyMissing`), so there the new error IS new information: it distinguishes an existing id (fault)
from a missing one (denial) during the fault. Both are visible only to a caller who already guessed
the id, and are accepted for parity with `readAnchor`: hiding them would deny the legitimate owner a
retry. The fault may also have been in the recorded lineage rather than the execution's own record.
Residual (lineage, precise): a parent that is SEALED or unopenable (`SealedStreamUnreadableError`
on the parent's sequence 0 during the walk) still surfaces to the CHILD's own owner as a
denial-shaped `SealedStreamUnreadableError` (the seal rule above, unchanged), not as the retryable
error, and says something about the parent's stream state; and an erasure on a parent hop is an
unknown parent owner (the walk withholds `parentOwner`).

**Residual (2026-10-17): a bounded existence oracle during a key outage.** While the key service is
down, a stranger asking about an EXISTING encrypted execution id gets `ExecutionStoreUnavailableError`
(its anchor cannot be decrypted, so no verdict is possible), whereas a missing id answers
not-found/denied. That tells a stranger that an id exists, but only during a real fault, only for ids
they already guess, and never the owner, workflow or contents. Accepted: answering the same for both
would mean denying or hiding a fault the legitimate owner must be able to retry.

**Workflow id of an unreadable anchor.** The authorizer and `onExecutionDenied` get the envelope's
plaintext `workflowId` column, taken from the redacted view the erasure error carries (else the
error's own `workflowId`). For an in-tree store this is always present. A THIRD-PARTY decorator whose
erasure error carries neither yields `""`: the authorizer then sees an empty workflow id (an
`allowWorkflows` policy refuses it with `workflow "" is not permitted`). Such a decorator should
attach `redacted` (as `EncryptingEventStore` does). A sealed refusal's callback now carries the
refusal's plaintext workflow id too (it was `""`).

**Reason oracle (documented residual, not redesigned).** What is indistinguishable is the ERROR the
fold or decrypt path throws. The denial REASON is the policy's own and still differs by what the
policy knows: an execution whose owner is unknown (an erased principal, a sealed stream, a legacy log
with no principal) is refused with `UNKNOWN_OWNER_REASON`, an execution with a recorded owner of
another tenant with "the execution belongs to another tenant". A caller who sees reasons can
therefore tell an unknown-owner execution from an owned one. Closing it would mean the policy
answering one reason for both (losing the operator-facing distinction in `onExecutionDenied`, which
carries the same text); left to the integrator, pinned by `authzBeforeFold.test.ts`.

**Reads.** The verdict costs one indexed point read of sequence 0, handed on to the owner lookup and
to the fold (`foldState`'s existence anchor, `resume`'s carried-scanner path), so `loadState` reads
sequence 0 once where it read twice and the carried `resume` path reads it once as before. The first
(uncarried) `resume` and `resumeAs` read the whole log anyway; they pay ONE added point read, the
inherent price of a verdict that must precede that read. Counts are pinned by a counting-store test.

**Orphan checkpoints.** An id with no sequence 0 is "missing" to the authorizer. If a checkpoint
a retention sweep left behind then fails to load, `loadState`, `resume` and `resumeAs` read that as not found
(with `denyMissing` for an anonymous strict caller) instead of surfacing the checkpoint error to a
caller the authorizer is consulted for. The kernel's system grant is not gated and keeps the error.

**Writes.** A read denial writes nothing. A denied `resume`/`resumeAs`/`cancel` keeps its best-effort
`EXECUTION_DENIED`, now placed at the folded tip found AFTER the verdict; if that fold cannot be read
(shredded, sealed, bad checkpoint) the audit fact is skipped rather than surface the error to the
denied caller (the thrown denial is the enforcement). `onExecutionDenied` fires as before. The fact
is therefore absent for a denied `resume`/`resumeAs` of a shredded execution (its strict fold throws)
and for every op whose checkpoint or stream is unreadable; a denied `cancel` of a shredded execution
keeps it (the redacted fold is readable).

**Missing vs denied (unchanged, intended).** An execution that does not exist is judged by the
authorizer before "not found" is revealed only for an ANONYMOUS caller under `strict`
(`denyMissing`, R3). A caller that presents a principal still tells "not found" from "denied":
`loadState(id, { principal })` returning `null` is how an edge asks whether an id is free before
starting it, and a policy cannot tell a free id from a forbidden one without breaking that. This is
a documented residual, not changed here. `start` of an existing id keeps `ExecutionAlreadyExistsError`
for the same reason.

Verification: `authzBeforeFold.test.ts` runs EVERY gated op, one test per (world, op), as a denied
principal against a shredded execution (steps and checkpoint sealed), one whose recorded principal is
sealed too, a sealed stream, a key-unavailable checkpoint and a foreign-identity checkpoint, and
demands the shape (error class, message, reason, audit callback including the workflow id) of the
ordinary denial, no `transformState` call, and the same appended events as the ordinary execution
(the audit-skip exceptions above are stated in the file). The file's header table says which cells
failed before the fix and which are vacuous. A counting store pins the reads; a faulting store pins
the retryable error (owner = stranger, no detail, no denial callback, nothing written) for every op; a
raw `KeyUnavailableError` with and without the erase intent, the workflow-id fallback, the orphan
checkpoint and the `acquireFence`/`fork` re-read each have a test; an authorized caller still gets
`PayloadShreddedError` (and a working `cancel`). No event shape changes: `EVENT_SCHEMA` and
`KERNEL_ABI` are unchanged.

**Amendment (2026-10-17, c) - erasure is a BRAND, never a name.** The kernel classified a failure as a
PROVEN erasure (`isErasure`, the `recordedPrincipal` anchor read, the `cancel` redacted fold) by
`err.name === "PayloadShreddedError"`. Name matching exists because `instanceof` fails across
duplicated package copies, but it also let any store decorator or third-party store (or anything in its
error path) that threw a plain `Error` with that name forge an unknown owner, which
`unknownOwner: "allow"` admits. Erasure is now the realm-safe brand `Symbol.for("loom.payloadShredded")`
(a non-enumerable own property, so `name`, message and serialized shape are unchanged), set by
`@loom/plugin-crypto`'s `PayloadShreddedError` constructor and by the kernel's own synthetic errors
(built from a `PAYLOAD_SHREDDED` tombstone), and read by ONE predicate, `isPayloadShredded` in
`@loom/event-runtime` (beside `KeyUnavailableError`, so no consumer imports the crypto plugin). The
name alone is never enough; the symbol registry makes the brand survive duplicated copies. Consumers
moved: `WorkflowRuntime` (3 sites), `@loom/orchestration` `pinParkedChildren`, `@loom/compliance`
`EraseCoordinator`, `@loom/plugin-content` GC, the CLI lifecycle. A store that throws its own erasure
error adopts `brandPayloadShredded(err)`; until then its error is a fault (retryable, nobody admitted).
A serialized error (JSON, A2A) has lost the brand by design and no boundary re-trusts it by name; where
a boundary needs the fact it reads the log's own `PAYLOAD_SHREDDED` tombstone. Verification:
`shreddedBrand.test.ts` (each claim has a test that fails with the name-only match restored).
