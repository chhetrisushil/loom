# ADR 0111 — The execution's principal is durable

- Status: **Accepted — implemented** (2026-10-06; proposed 2026-10-05, design approved after 4 review rounds). See "Implementation (as built)".
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

The fold keeps `parent` as `_parent` and the chain identity as `_chain` (ADR 0109); a fork's `forkedBy`
is read from the **`EXECUTION_STARTED` envelope's metadata** and replaces the payload `principal` in
`_principal`. A malformed record or `forkedBy` (not an object) is ignored, never thrown.

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

## Implementation (as built, 2026-10-06)

Decisions the text above left to the implementation; none changes a shape frozen at W2-0.

- **Where the codec is composed (D4 rule 3).** The child supervisor is app-owned and built AFTER
  `defineConfig`, so `defineConfig` cannot see it. `superviseChildren({ delegation })` itself
  composes `orchestrationPrincipalCodec(secret)` onto its runtime
  (`WorkflowRuntime.composePrincipalCodec`, a composition-time contributor; the newest codec is asked
  first, `toRef`/`fromRef` fall through on `undefined`). The supported path still needs no
  configuration, and a runtime that never saw a supervisor refuses a delegated start (rule 2).
- **The orchestration `ref`.** `loom:orch:v1:` + base64url `{ a: childId, g: grants[], e?: exp }`: the
  SUBSET the spawn conferred (plain effect ids, the description the parent's spawn decision already
  journals), the holder and the expiry. `fromRef` re-signs it with the supervisor's secret, so a recovered
  child gets the same attenuation back; the secret and the token never enter the log. `toRef` handles only
  the supervisor's own shape (a verified, holder-bound token on its own actor, no human identity fields); a
  token that does not verify is never re-signed and falls through to the default record, which is refused.
- **The acting principal is the REHYDRATED record on every path, `start` included.** A first run and a
  recovery must see the same chain, so `start` also runs `rehydratePrincipal(record)`: only
  `{ tenant, actor, onBehalfOf }` reaches the effects (D1: extra fields are dropped); a `principalCodec`
  or `principalResolver` carries anything more.
- **`PrincipalCodec.toRef` may return `undefined`** ("not mine"), so codecs compose and the default record
  applies to everything the codec does not claim. Under `identity: "ref"` (strict/compliance without
  crypto) an unclaimed identified principal REFUSES the start with `PrincipalUnrestorableError`, log empty.
- **A ref no codec restores fails closed.** The D4 text covers a recorded `delegation`; a `{ v: 1, ref }`
  record with no codec (or whose `fromRef` returns `undefined`) is marked `principalUnresolved` and the
  kernel denies the effects exactly like `delegationUnresolved`: anonymous would silently drop tenant rules,
  the bug this ADR exists to fix. A record that is present but malformed or of another `v` denies the same way.
- **`defineConfig` surface.** `security.principalCodec`, `security.principalResolver`, and `security.crypto:
  { events, snapshots? }` (the `EncryptingEventStore` / `EncryptingSnapshotStore`, which gained
  `registerSensitive`). There is no other signal that crypto is composed, so it is passed explicitly. Under
  crypto, `defineConfig` registers `principal.identity.*` on `EXECUTION_STARTED` AND
  `variables._principal.identity.*` on the snapshot store (the fold carries the principal; an encrypted log
  with a plaintext snapshot is the A1 erasure-theatre hole). Strict/compliance with neither crypto nor a codec
  throws `PrincipalRecordingRefusedError`; "a composed compliance plugin" is `security.compliance`.
- **A fork under crypto-without-codec is refused.** `forkedBy` rides ENVELOPE METADATA, which the crypto
  plugin does not encrypt, so a fork of an identified forker with `identity: "encrypted"` and no codec
  refuses (`PrincipalUnrestorableError`, nothing written). With a codec the fork records a `ref`.
- **`parent`** is recorded ONLY at a trusted start, in EVERY mode (superseded by review round 2: the "no
  authorizer records it" carve-out is gone). Trusted = the start presents the runtime's lineage grant
  (`runtime.lineageOptions()`, which the supervisor always spreads) or its system grant. A caller-supplied
  `parentExecutionId` is OMITTED from the log, so a recorded `parent` is always the kernel's/supervisor's and
  needs no separate trust flag. **R8k must read `_parent` as that**: a retention pin may honour any `parent`
  it finds (an untrusted one was never written), but must not be extended to a source that writes `parent`
  without the lineage grant.
- **Owners.** A supervisor child started with no principal has NO owner of its own (D5): it no longer
  inherits its parent's owner from an in-process table (its LIFECYCLE follows the parent's owner by D6
  below, round 2). `executionAccessPolicy` lost `ownerOf`, `adopt`,
  `tracked`, `maxTracked` and `committed` handling; `resolveOwner` answers only for a log that recorded none;
  an owner naming neither tenant nor actor is no owner.
- **Reading the record.** One point read of sequence 0 per `execute()` (resume reuses the envelope it
  already read). A `PayloadShreddedError` from that read, or `$shredded` markers inside the record, is the
  shredded marker (denies). No `kernel.features` flag: the optional payload fields are harmless to an older node
  (rolling-upgrade note in the Wave 2 design).

### Review round 1 (as built)

- **P1 — a resolver cannot widen a delegated child.** `rehydratePrincipal` now answers a `ref` record
  from the composed `principalCodec` FIRST (the codec is the ref's author; `superviseChildren` composes
  one), then the resolver, then `principalUnresolved`. A resolver returning `undefined` for ANY non-empty
  record (ref, identity, delegation) denies (`principalUnresolved` / `delegationUnresolved`); only the empty
  `{ v: 1 }` record means "no principal". Test: orchestration with a real `superviseChildren` + an
  identity-only resolver.
- **P2-a — the owner of a live execution is known before sequence 0 is durable.** A minted-id start journals
  sequence 0 behind the fold, so a prompt `cancel`/`query` point-read nothing and read "legacy" (owner
  undefined, owner denied). The runtime keeps the start's `PrincipalRecord` in a map keyed by live
  execution (set at start, cleared when the handle settles or the start throws; bounded by live executions)
  and `recordedPrincipal` answers from it. A read that fails is never legacy: `ownerForAuthz` reports an
  unknown owner and the policy's `unknownOwner` rule decides (deny by default).
- **P3-1 — the orchestration ref is MACed.** `loom:orch:v2:<body>.<mac>`; `mac = HMAC(K, "loom:orch:ref:v1|" + body)`
  with `K = HMAC(secret, "loom:orch:ref-key:v1")`, so a ref MAC is never a delegation signature. `fromRef`
  verifies (constant time) BEFORE re-signing; unsigned (v1) / malformed / foreign-secret refs return
  `undefined` and the child is denied.
- **P3-2 — `storedPrincipalOf` asserts its input** is sequence 0 / `EXECUTION_STARTED`; any other envelope is
  `malformed` (deny), never `legacy`.
- **P3-3 — `fork(…, { actAs: "owner" })` with no `executionAuthorizer`** is unrestricted, like every other
  op without an authorizer; the default-deny `actAsOwner` op exists only when an authorizer is configured.

**Follow-up (not in this PR).** A fork under crypto without a codec is refused (the forker's identity rides
unencrypted envelope metadata), which makes forks unusable for an identified forker under crypto unless
the app wires a codec. Either the scaffold always generates a codec, or the crypto plugin encrypts the
metadata paths (`forkedBy`). Decide before crypto-by-default ships.

### Review round 2 — decided (user, 2026-10-06)

**Decided (user, 2026-10-06) — a principal-less supervised child's lifecycle is authorized via its recorded
parent.** On main an owner-tracking policy let the parent's owner query/cancel its supervised child; round 1
removed that with the in-process table. Restored durably: `ExecutionAuthzRequest` gains the optional
`parentOwner` (additive; an authorizer that ignores it is unaffected). The kernel fills it when the
execution's own record is ANONYMOUS (no identity at all — a shredded, unrestorable or delegation-only record
stays unknown) by walking the child's recorded `parent` (sequence 0, written only at a trusted start) to the
nearest recorded owner: at most **8 hops**, cycle-safe, an unreadable link or a chain that ends / runs out is
an unknown owner (deny by default). Cost: one sequence-0 read per hop, only for an anonymous child under an
authorizer. `executionAccessPolicy` uses `parentOwner` as the owner for every op EXCEPT `actAsOwner`, so
query/cancel/resume of the child follow the parent's owner, a stranger is refused, and a caller-supplied
`parentExecutionId` confers nothing (it is never recorded). The child's EFFECTS stay anonymous: nothing about
`actingPrincipal` changes. Residual: a child started WITH a delegation records `{ actor: <childId> }` as its
owner, so it has an own owner and the parent's owner does not inherit it (the delegated child is the
supervisor's, reachable through the system grant).

**The trust token (closing the gap).** After round 1 `parent` was recorded only with a valid system grant, but
the runtime mints that grant only under `requirePrincipal`, so with an authorizer and no `requirePrincipal`
the supervisor could not prove itself and no lineage was recorded. Options weighed: (a) mint the system grant
whenever an authorizer is configured — rejected: that grant also gates the timer wake (`TIMER_FIRED` is refused
without it), so it would silently tighten every non-strict deployment's resume path, and it bypasses the
authorizer; (b) a separate **`LineageGrant`**, minted in every mode (even with no authorizer), handed out by
`WorkflowRuntime.lineageOptions()`, accepted for one purpose — recording `parent` (and reporting it on
`committed`). It bypasses no authorizer, gates nothing else, is identity-compared (a structurally equal object
is ignored), and is not a principal. (b) is chosen: the narrowest. Like the system grant it is a runtime-held
reference: anything in the process that can call `lineageOptions()` can record a `parent`; the public edge
never receives it (it is not part of any wire type). `superviseChildren` spreads it with `systemOptions()`.
Tested in all three modes (no authorizer / authorizer / authorizer + `requirePrincipal`).

**Decided (user, 2026-10-06) — threat model.** Write access to the event store is INSIDE the principal trust
boundary: whoever can append to the log can already forge any event and outcome, including a principal
record, a `parent` or an `APPROVAL_GRANTED`. Integrity of the recorded principal therefore comes from the
store's access control, plus the audit chain and crypto where they are composed — not from the record. The
orchestration `ref` stays MACed (defence in depth against a ref altered in transit or at rest), but nothing
here claims protection from a principal-record forger with store write access.
