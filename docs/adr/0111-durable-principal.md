# ADR 0111 — The execution's principal is durable

- Status: **Proposed** (2026-10-05) — design approved after 4 review rounds; Accepted per item at implementation
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
- Revision: round 2 — identity is never written verbatim under strict/compliance without crypto or a codec
  (D1); the resolver reads sequence 0 of the log, not a caller-supplied state, and `_principal` survives a
  migration (D2). Round 1 (Opus review of PR #495). A fork now acts as the forker (D7); `delegationUnresolved` is
  enforced by the kernel before any authorizer, and a start that cannot be restored is refused (D4); a
  shredded principal denies (D2); every 1.23 start writes an explicit record (D1); `defineConfig` registers
  the identity paths as sensitive when crypto is composed (D1). **First in lane A**; a stop-gap
  CHANGELOG/usage note records today's behaviour until it lands.

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

**Every start on 1.23.0 writes a record, even an anonymous one: `{ v: 1 }`.** "Absent" then means exactly
one thing — a legacy log started before this ADR — and the fall-back to `options.principal` (D2) applies to
legacy logs only. An anonymous 1.23.0 start can no longer be confused with a legacy one, and nothing can
strip a record to regain the resumer's authority.

**Crypto.** The identity subset is PII-adjacent. When a crypto plugin (K10) is composed, `defineConfig`
registers `principal.identity.*` (tenant, actor, onBehalfOf) with the same sensitive-path seam the plugin
uses for other payload fields (`@loom/classify` `sensitive()` markers feed `@loom/plugin-crypto`), so the
subset is encrypted at rest and **shredded** with the subject (`PAYLOAD_SHREDDED`, D2 handles the result).

**Plaintext identity without crypto — a decided policy, not an accident.** The `{ tenant, actor,
onBehalfOf }` subset is PII-adjacent, a log is permanent, and `eraseSubject` cannot redact a plaintext
field (it appends `PAYLOAD_SHREDDED` tombstones, which only mean something over encrypted fields). So:
(1) **under `security.strict`, or when a compliance/erasure plugin is composed, a principal's identity is
never written verbatim.** If crypto (K10) is composed the subset is encrypted and shreddable (above);
otherwise `defineConfig` requires `principalCodec` (D3 `ref` mode: the log carries `{ v: 1, ref }` only) and
**refuses to compose** with a typed error naming the three ways out (compose crypto, supply a codec, or
turn strict/compliance off) rather than silently writing identity into a log it was told can be erased.
(2) **Outside strict/compliance the verbatim subset remains the zero-config default**, and the trade-off is
a documented non-goal: such a deployment has said it does not erase, K10's PII rule is satisfied by the
operator's choice not to compose crypto, and nothing is promised about redaction of those three fields.
Rationale for the split: refusing everywhere would force a resolver on every app (rejected below), while
defaulting to plaintext under a stated erasure obligation is exactly the silent contradiction K10 exists to
prevent. Test: strict with no crypto and no codec refuses at composition; strict + codec writes no actor in
the log; non-strict default writes the subset and the docs state the limit.

`parent` (the supervisor's `parentExecutionId`, today descriptive and only reported on
`committed`) is recorded beside it as `EXECUTION_STARTED.payload.parent`. It is lineage, not
identity; ADR 0109's `continuedFrom` and R8k's pin predicate use it.

### D2 — Rehydration: the execution runs as its recorded principal

A kernel `PrincipalResolver` seam: `resolve(record, { executionId }) → PrincipalChain | undefined |
Promise<…>`. The default (no configuration) rebuilds `{ tenant, actor, onBehalfOf }` from
`identity` and, when `delegation` is recorded but unresolved, marks the chain
`delegationUnresolved: <id>`. The app may supply its own resolver (D3). **The record is read from the log, never from a caller-supplied state.** `restoreFromState` takes a
caller-supplied `ExecutionState` (`WorkflowRuntime.ts:1441`, whose comment already treats it as unverified),
so the resolver reads `principal` from **sequence 0 of the execution's own log** (a point read; or the
fold the runtime itself built), and ignores `preloadedState.variables._principal`: a caller cannot forge or
strip the owner by restoring a doctored state. A `resumeAs` code migration appends `EXECUTION_MIGRATED`,
whose handler spreads `...state.variables` (`replay-vm/src/eventHandlers.ts:672-692`) and so does not reset
`_principal`; a test pins that `_principal` is identical before and after a migration. The runtime calls it once per
`execute()` start-up and uses the result as the effect principal for the whole run, on **every** entry
path — `start`, `resume`, `resumeAs`, `restoreFromState`, recovery, timer, supervisor — replacing the
`options.principal` argument that `execute()` takes today. `options.principal` keeps exactly one
job: the *lifecycle caller* for `ExecutionAuthorizer` and `ResumeAuthenticator`
(`verify(event, { principal })`).

**A shredded principal denies; it never falls back.** If the recorded identity was crypto-shredded
(`PAYLOAD_SHREDDED` covering `_principal`), the resolver result is the explicit `principalShredded` marker
and every effect is denied (journaled `EFFECT_DENIED`, like D4), never evaluated under `options.principal`:
an erased subject's executions must not silently run as whoever resumes them.

An execution with **no `principal` field at all** (a pre-1.23.0 log only; every 1.23.0 start writes at
least `{ v: 1 }`, D1) falls back to today's behaviour (`options.principal`), so legacy executions are
unchanged. A start that carries a
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

### D4 — Fail closed when a delegation cannot be restored: in the kernel, and at start

The first draft put the rule only in `DelegationAuthorizer`, which is not the only authorizer (a
`PolicyAuthorizer`, a `GrantTable`, or a 3P authorizer is asked about a `delegationUnresolved` chain and
authorizes it on its own terms; and the default resolver cannot restore any delegation, so an attenuated
child would be denied only by luck of composition after its first ordinary park/resume). Three rules:

1. **The kernel enforces it.** A principal marked `delegationUnresolved` (or whose resolver result is
   `undefined` for a record that has `delegation`) makes the effect call end in `EFFECT_DENIED` **before any
   authorizer is consulted** (in the step pipeline, ahead of the K2 ring). `DelegationAuthorizer` keeps its
   own deny as defence in depth, but correctness no longer depends on which authorizer is composed.
2. **Refuse at `start`.** A start whose principal carries a delegation is refused
   (`PrincipalUnrestorableError`, nothing appended) unless a `principalCodec` / resolver able to restore it
   is wired. That moves the failure from "the child is mysteriously denied after its first park" to the one
   call that can still report it.
3. **`defineConfig` composes it.** When `superviseChildren` is wired, `defineConfig` auto-composes
   `@loom/orchestration`'s principal codec (the one that re-issues the narrowed token from the journaled
   spawn decision, D3), so the supported path needs no configuration and rule 2 only fires for apps that
   hand-build a runtime.

The failure is the ordinary journaled `EFFECT_DENIED`, so an operator sees it and can `resumeAs` with a
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

### D7 — Fork acts as the forker; continuation inherits

The first draft let a fork keep the owner's authority, but a fork is authorized only as `query` on the
parent and `start` on the child (`WorkflowRuntime.fork`, around line 2329) and `copyPrefix` copies sequence
0, so a caller who may merely *read* a run and *start* a flow would obtain an execution that runs the
owner's remaining effects under the owner's grants: a privilege escalation. Now:

- **A fork acts as the forker by default.** `fork` stamps `forkedBy: PrincipalRecord` (the forker's
  record, built exactly as D1 builds a start record) into `forkMeta`, which the copy merges into every
  copied envelope's metadata, sequence 0 included (the same mechanism that carries `forkedFrom`). The
  resolver prefers `forkedBy` over the copied `principal` when the log's sequence 0 carries it. Ownership
  for authz (D5) of the fork is the forker too, which is what `executionAccessPolicy` documents today.
- **Acting as the owner is an explicit, separately authorized option:** `fork(…, { actAs: "owner" })`,
  authorized as a new `ExecutionOp` **`"actAsOwner"`** on the parent (default policy: `deny`), recorded as
  `forkedBy` omitted and `forkActAs: "owner"` in the metadata, so the log shows who chose it.
- A **continuation** (ADR 0109) copies the record into the successor's start; attenuation can narrow,
  never widen.

## Replay and migration

A new optional payload field and a reserved fold key: logs without them replay byte-identically.
No re-write of existing executions. The behavioural change is D2's: after upgrade, effects after an
approval run as the *owner*, not the approver, **for executions that recorded a principal** (i.e.
started on 1.23.0 — now every 1.23.0 start, since an anonymous one records `{ v: 1 }`). Apps that relied on "the approver's principal reaches the effects" must pass the
approver explicitly as data; the CHANGELOG states this as BREAKING for the new executions only.

## Tests

Start with principal → crash → `recoverAbandoned` → effect sees the same principal (and a tenant
policy fires); timer wake and supervisor resume likewise; approval by a *different* actor → the effect
principal is the owner; attenuated child → crash → recovered child is still attenuated (resolver
present) or **denied** (resolver absent / `delegationUnresolved`), never `base` (the negative test:
the same scenario on `main` passes `base`); `ref` mode writes no actor into the log (assert the
payload); a delegation token string appears nowhere in any recorded event; `owner` supplied to the
authorizer for an execution started before a process restart; wire-abi vectors; the ExecutionAuthorizer
and PrincipalResolver conformance cases. Round-2 additions: strict without crypto or codec refuses at composition, strict with a codec writes no actor;
`restoreFromState` with a doctored `_principal` in the supplied state runs as the log's recorded owner;
`_principal` survives `resumeAs` + `transformState` migration; a fork of a chain member gets a fresh
chain (ADR 0109 D7) while `forkedBy` still governs its authority. Round-1 additions: a delegated start with no restorer is refused
with the log empty; a `delegationUnresolved` principal is denied under a `PolicyAuthorizer` and under a 3P
authorizer that allows everything (the kernel rule fires first); a shredded principal denies and never runs
as the resumer; the crypto composition encrypts `principal.identity.*`; an anonymous 1.23.0 start records
`{ v: 1 }` and a log that strips it is not mistaken for a legacy one; a fork's remaining effects run as the
forker, `actAs: "owner"` is refused without `"actAsOwner"`, and the fork does not inherit the owner's
tenant ALLOW.

## Rejected

- **Persisting the whole `PrincipalChain`**: stores bearer tokens and arbitrary fields in a permanent
  log.
- **Persisting only `ref` always**: forces every app to run a resolver to get tenant-scoped policy
  right; the verbatim identity subset is the zero-config path.
- **Refusing the verbatim identity subset everywhere**: forces a resolver on every app; the split in D1
  (refuse only under an erasure/strict obligation) keeps the zero-config path.
- **Letting a fork inherit the owner's authority** (the first draft): an escalation; see D7.
- **Enforcing `delegationUnresolved` only in `DelegationAuthorizer`**: other authorizers authorize it.
- **A principal event after sequence 0** (`PRINCIPAL_BOUND`): not needed while the principal is
  immutable for an execution; it would also be a new forged-kernel-event surface.
