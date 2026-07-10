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
