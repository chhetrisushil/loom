# ADR 0111 — The execution's principal is durable

- Status: **Proposed** (2026-10-05)
- Date: 2026-10-05
- Closes: R3 kernel half (agentic-readiness audit, governance appendix, principal-propagation rows)
- Builds on: R3 1P half (fail-closed execution authz, `executionAccessPolicy`, `SystemGrant`,
  DISPATCHER_SPI 1.2.0 `ExecutionPackage.principal` — all of which name this ADR as their follow-up),
  K12.1/K12.4 (`PrincipalChain`, delegation), [ADR 0117](0117-approvals-bound-to-what-the-approver-saw.md).
- Placement: **kernel records and rehydrates; 1P decides.** Kernel: a field on the start event,
  a fold key, a resolver seam. 1P: `executionAccessPolicy` reads the recorded owner, the
  delegation re-derivation for supervised children (`@loom/orchestration`), the DelegationAuthorizer
  fail-closed rule (`@loom/effect-runtime`). Shares the Wave 2 bump (EVENT_SCHEMA 1.23.0). **No
  KERNEL_ABI change. DISPATCHER_SPI stays 1.2.0.**

## Context

The kernel threads `PrincipalChain` through `RunOptions.principal` into every effect's
authorization, and does not record it. Grep of `core`, `replay-vm`, `snapshot-runtime` and
`event-runtime` for `principal` finds nothing. Three consequences, one of them worse than the audit
stated.

1. **The principal is lost on every kernel-internal path.** `recoverAbandoned`, `TimerService`
   wakes, the child supervisor's parent resume and `LocalWorkerRuntime` re-drive an execution with
   no principal (R3 1P gave them the system grant to *skip lifecycle authz*; it is not a principal
   and "never reaches an effect's authorization"). After any of them the flow's remaining effects
   run as nobody: tenant policies see tenant `""` (`policy.ts`), a tenant-scoped ALLOW silently
   denies and a tenant-scoped DENY silently does not fire.
2. **A delegation-attenuated child regains base authority after recovery.** The supervisor starts a
   child with `principal = { actor: childId, delegation: token }`. `DelegationAuthorizer` enforces
   the token when present and falls through to `base` when absent. Recovery drops the token, so the
   child continues under `base`, broader than its token. This is a privilege escalation across a
   crash.
3. **The effect principal is the *resumer*, not the owner.** `resume`, `restoreFromState` and
   `resumeAs` all end in `this.execute(…, options?.principal)`: the principal that answers a gate
   (an approver, or nobody for a timer) becomes the principal of the flow's effects for the rest of
   the run. An approval makes the flow act as the approver, and a timer wake makes it act as no one.
   That conflates two different questions — *who may perform this lifecycle op* and *whose
   authority does this execution act under* — which the R3 1P half also had to keep apart
   (`authzApplies(principal, system)` is the former only).

Execution ownership has the same root: `executionAccessPolicy` remembers who started an execution in
a process-local table filled from `ExecutionAuthorizer.committed`, lost on restart unless the app
supplies `resolveOwner`.

## Decision

### D1 — Record a `PrincipalRecord` on `EXECUTION_STARTED`

`EXECUTION_STARTED.payload.principal` (additive, optional) holds:

```ts
interface PrincipalRecord {
  v: 1;
  ref?: string;                                  // opaque, app-chosen, non-secret (D3)
  identity?: { tenant?: string; actor?: string; onBehalfOf?: string }; // bounded strings, 256 chars
  delegation?: { id: string; exp?: number };     // a DIGEST of the token + its expiry; never the token
}
```

The fold keeps it verbatim under the reserved key `variables._principal`; it rides snapshots, forks
and the worker `ExecutionResult.state` for free. Nothing else of `PrincipalChain` is persisted:
extra fields (`[k: string]: unknown`) are dropped, because a log is permanent and readable by
everyone who can read the log, and K10 forbids PII and bearer secrets in it. In particular **a
delegation token is never written**: it is a bearer capability (HMAC-signed, possibly long-lived)
and an append-only log cannot revoke it.

`parent` (the supervisor's `parentExecutionId`, today descriptive and only reported on
`committed`) is recorded beside it as `EXECUTION_STARTED.payload.parent`. It is lineage, not
identity; ADR 0109's `continuedFrom` and R8k's pin predicate use it.

### D2 — Rehydration: the execution runs as its recorded principal

A kernel `PrincipalResolver` seam: `resolve(record, { executionId }) → PrincipalChain | undefined |
Promise<…>`. The default (no configuration) rebuilds `{ tenant, actor, onBehalfOf }` from
`identity` and, when `delegation` is recorded but unresolved, marks the chain
`delegationUnresolved: <id>`. The app may supply its own resolver (D3). The runtime calls it once per
`execute()` start-up and uses the result as the effect principal for the whole run, on **every** entry
path — `start`, `resume`, `resumeAs`, `restoreFromState`, recovery, timer, supervisor — replacing the
`options.principal` argument that `execute()` takes today. `options.principal` keeps exactly one
job: the *lifecycle caller* for `ExecutionAuthorizer` and `ResumeAuthenticator`
(`verify(event, { principal })`).

An execution with no recorded principal (every pre-1.23.0 log, and an anonymous start) falls back to
today's behaviour (`options.principal`), so legacy executions are unchanged. A start that carries a
principal but ran on a node that predates this ADR leaves the log without a record; that is the same
legacy case, and the 1P `executionAccessPolicy` still honours `resolveOwner`.

### D3 — Opaque `ref` mode

An app that must not put even an actor id in its log supplies
`principalCodec: { toRef(chain): string; fromRef(ref): PrincipalChain | undefined | Promise<…> }`
(`WorkflowRuntimeDeps`). The start records `{ v: 1, ref }` only — no `identity` — and rehydration
asks `fromRef`. This is the mode for delegation: `fromRef` can re-issue the narrowed token from the
app's own grant table, which the supervisor in `@loom/orchestration` does from the spawn decision it
already journals plus the delegation secret it holds (so a recovered child gets the *same*
attenuation back, not a fresh one). The kernel never interprets `ref`.

### D4 — Fail closed when a delegation cannot be restored

`DelegationAuthorizer` (1P, `@loom/effect-runtime`) gains one rule: a principal carrying
`delegationUnresolved` is **denied** for every capability, never allowed through `base`. (A
`delegationUnresolved` chain is the only way the kernel can say "this execution was attenuated and
the attenuation is unrecoverable"; authorizing it as `base` is the escalation of consequence 2.)
A missing/undefined resolver result for a record that has `delegation` is the same refusal. The
failure is the ordinary journaled `EFFECT_DENIED`, so an operator sees it and can `resumeAs` with a
restored principal.

### D5 — Execution authz reads the recorded owner

`ExecutionAuthzRequest` gains an optional `owner?: { tenant?, actor?, onBehalfOf? }`, filled by the
kernel from the record for `resume`/`cancel`/`query` (read from sequence 0 of the log, one indexed
point read, performed after the existence-hiding order the runtime already uses so a denial is still
judged before "not found" is revealed). `executionAccessPolicy` uses it directly, so its in-process
owner table, `committed`, `maxTracked` and the "ownership is NOT durable" caveat go away; `committed`
stays on the interface (additive SPI) for policies that want it, and the conformance kit gains a case
that `owner` is supplied for an existing execution. A system-started execution (timer-started
schedule occurrence, supervisor child with no principal) has no `owner`, and the policy's existing
`unknownOwner` rule applies.

### D6 — Dispatcher and wire

`ExecutionPackage.principal` (DISPATCHER_SPI 1.2.0) stays and keeps its meaning: the **lifecycle
caller** for the dispatch. A remote worker needs nothing more to act as the owner: the owner is in
the log it reads (D1), so no second principal field crosses the seam and the SPI does not change.
`wire-abi` gains fold vectors for `_principal`.

### D7 — Fork and continuation

A fork copies the prefix, hence the recorded principal: a counterfactual run keeps the authority of
the run it forks. The forker's identity is the lifecycle caller and is already in the fork's metadata
and authz request. (Open question 6 asks whether a fork may run as the forker.) A continuation
(ADR 0109) copies the record into the successor's start; attenuation can narrow, never widen.

## Replay and migration

A new optional payload field and a reserved fold key: logs without them replay byte-identically.
No re-write of existing executions. The behavioural change is D2's: after upgrade, effects after an
approval run as the *owner*, not the approver, **for executions that recorded a principal** (i.e.
started on 1.23.0). Apps that relied on "the approver's principal reaches the effects" must pass the
approver explicitly as data; the CHANGELOG states this as BREAKING for the new executions only.

## Tests

Start with principal → crash → `recoverAbandoned` → effect sees the same principal (and a tenant
policy fires); timer wake and supervisor resume likewise; approval by a *different* actor → the effect
principal is the owner; attenuated child → crash → recovered child is still attenuated (resolver
present) or **denied** (resolver absent / `delegationUnresolved`), never `base` (the negative test:
the same scenario on `main` passes `base`); `ref` mode writes no actor into the log (assert the
payload); a delegation token string appears nowhere in any recorded event; `owner` supplied to the
authorizer for an execution started before a process restart; wire-abi vectors; the ExecutionAuthorizer
and PrincipalResolver conformance cases.

## Rejected

- **Persisting the whole `PrincipalChain`**: stores bearer tokens and arbitrary fields in a permanent
  log.
- **Persisting only `ref` always**: forces every app to run a resolver to get tenant-scoped policy
  right; the verbatim identity subset is the zero-config path.
- **A principal event after sequence 0** (`PRINCIPAL_BOUND`): not needed while the principal is
  immutable for an execution; it would also be a new forged-kernel-event surface.
