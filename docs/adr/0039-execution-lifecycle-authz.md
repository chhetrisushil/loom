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
(shredded principal, decrypt or storage fault) is an execution that EXISTS with an UNKNOWN owner: the
policy decides exactly as for any unknown-owner execution, so the denied caller gets the ordinary
`ExecutionDeniedError`, never a status-revealing error. A stream-level seal refusal is unchanged
(ADR 0130 D7: `sealedOp` words it as that op's unknown-owner denial). An authorized caller is
unaffected: it proceeds to the same fold and gets the same errors as before (a shredded execution
still raises `PayloadShreddedError`; `cancel` still folds the redacted view and works).

**Writes.** A read denial writes nothing. A denied `resume`/`resumeAs`/`cancel` keeps its best-effort
`EXECUTION_DENIED`, now placed at the folded tip found AFTER the verdict; if that fold cannot be read
(shredded, sealed, bad checkpoint) the audit fact is skipped rather than surface the error to the
denied caller (the thrown denial is the enforcement). `onExecutionDenied` fires as before.

**Missing vs denied (unchanged, intended).** An execution that does not exist is judged by the
authorizer before "not found" is revealed only for an ANONYMOUS caller under `strict`
(`denyMissing`, R3). A caller that presents a principal still tells "not found" from "denied":
`loadState(id, { principal })` returning `null` is how an edge asks whether an id is free before
starting it, and a policy cannot tell a free id from a forbidden one without breaking that. This is
a documented residual, not changed here. `start` of an existing id keeps `ExecutionAlreadyExistsError`
for the same reason.

Verification: `authzBeforeFold.test.ts` runs every gated op as a denied principal against a shredded
execution (steps and checkpoint sealed), one whose recorded principal is sealed too, a sealed stream,
a key-unavailable checkpoint and a foreign-identity checkpoint, and demands the shape (error class,
message, reason, audit callback) of the ordinary denial, no `transformState` call, and no append
beyond the write ops' `EXECUTION_DENIED`; a counting store asserts a denied `loadState` performs no
`read`, no `readFrom` and no checkpoint load; an authorized caller still gets `PayloadShreddedError`
(and a working `cancel`). No event shape changes: `EVENT_SCHEMA` and `KERNEL_ABI` are unchanged.
