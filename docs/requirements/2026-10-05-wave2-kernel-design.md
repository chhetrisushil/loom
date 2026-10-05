# Wave 2 — the coordinated kernel design (agentic-readiness, Part R)

- Status: **Proposed** — design only; no runtime code in this change.
- Date: 2026-10-05, against `main` at e880d0e.
- ADRs (all **Proposed**, accepted one by one at implementation): [0109](../adr/0109-bounded-history-and-continue-as-new.md)
  R1b · [0110](../adr/0110-durable-inbox-and-receive-select.md) R2 · [0111](../adr/0111-durable-principal.md) R3k ·
  [0112](../adr/0112-structured-concurrency.md) R6 (+ R9k) · [0113](../adr/0113-body-aware-code-fingerprint-and-dynamic-id-migration.md) R7 ·
  [0114](../adr/0114-ctx-ui-leaves-the-kernel.md) R14 · [0115](../adr/0115-open-vocabularies.md) R15 ·
  [0116](../adr/0116-late-outcome-attach.md) R11 · [0118](../adr/0118-acquire-if-parked-fence.md) R8k.
  (0117 is R13, already implemented.)
- Evidence: the readiness evaluation and its kernel / capabilities / governance appendices in this directory
  (`2026-10-05-agentic-readiness-*.md`), and the probes in `2026-10-05-agentic-readiness-experiments/`.
  Paths below are relative to `packages/`; they are cited by symbol where a line number would rot.

## 0. Why one document

The Part R plan (sequencing step 3) asks for the kernel-primitive ADRs to be written together "so the
EVENT_SCHEMA/KERNEL_ABI bumps are planned once". The eight items are not independent. They share three
things: the **start event** (`EXECUTION_STARTED` gains the principal, the lineage and the fingerprint),
the **park condition** (R2 widens it, R13's `viewDigest` and R8k's `locatePark` read it), and the
**scope identity** that R6 mints and R2 consumes to key a wait. Designing them one at a time would bump
the version once per item, and would let the first one fix a shape the next one needs to change.

The bias of the repo is against kernel growth (P10, ADR 0083). For each item the question asked first is
"does this have to be in the kernel, and how little of it?". The answers are in §1; the net is **two new
syscalls' worth of ABI (three entries), two new event kinds, no new store SPI beyond one optional method,
and four items that are mostly or wholly 1P.**

## 1. What Wave 1 already did (not redesigned here)

| Shipped | Where | What this design relies on |
|---|---|---|
| **R1a** fold / live-commit / resume cost | ADR 0104 amendment, CHANGELOG | The quadratic constants are gone: `_decisions` is a fold-owned container, `ReplayVM` keeps ownership across `applyEvent`, `resume` folds snapshot + tail, the stray scanner is incremental. **The perf half of R1b is already fixed** (re-measure before claiming otherwise); what remains is structural (§2). |
| **R3 1P** fail-closed execution authz | `executionAccessPolicy`, `SystemGrant`, `executionAuthz.requirePrincipal`, DISPATCHER_SPI 1.2.0 `ExecutionPackage.principal` | The interim identity model R3k replaces: the system grant skips lifecycle authz only, and ownership lives in an in-process table filled by `ExecutionAuthorizer.committed`. |
| **R9** strict mode, kill switch, spawn caps | `security.strict`, `KillSwitchRegistry` | Feature flags in §3 hang off `kernel.features`, under `defineConfig`. |
| **R12** authenticated A2A/MCP ingress | A2A task namespacing, `authenticate` | The ingress that supplies the principal R3k now records. |
| **R13** ADR 0117 | `viewDigest` on suspend conditions, `signedResumeAuthenticator`, `locatePark` | R2 keeps the digest per wait; R8k's conditional fence takes its sequence from `locatePark`. |
| **R8** restart-safe supervisor | `@loom/orchestration` | Parks on `CHILD_DONE` with `viewDigest = correlationKey`; its README names the residual R8k closes. |

Current contracts: `KERNEL_ABI_VERSION` **1.2.0** (`workflow-runtime/src/abi.ts`), `EVENT_SCHEMA_VERSION`
**1.22.0** (`replay-vm/src/eventHandlers.ts`), `EVENT_STORE_SPI_VERSION` **2.0.0**, `DISPATCHER_SPI_VERSION`
**1.2.0**, `WIRE_ABI_VERSION` **1.0.0**, 30 folded event types, 10 syscalls.

## 2. Placement triage, one line each

| # | Item | Kernel | 1P / SPI | 3P / not at all |
|---|---|---|---|---|
| R1b | bounded history | `ctx.continueAsNew`, `EXECUTION_CONTINUED`, deterministic successor, recovery sweep | chain lineage queries (analytics), supervisor follow-through, `continueEvery` helper (agent) | frame pruning rejected |
| R3k | durable principal | `principal` + `parent` on `EXECUTION_STARTED`, `_principal` fold key, `PrincipalResolver` seam, effect principal = owner | `executionAccessPolicy` reads the owner, delegation re-derivation (orchestration), DelegationAuthorizer fails closed | the delegation token is never persisted |
| R2 | inbox, receive, select | `ctx.receive` / `ctx.select`, `MESSAGE_CONSUMED`, multi-wait park condition, `InboxSource` seam | **`@loom/inbox`**: stream, `send`, routing by name, pub/sub | content-predicate receive rejected |
| R6 | structured concurrency | scopes, park barrier, `STEP_CANCELLED` writer | cancel cascade to children (orchestration), **not** kernel | scoped `Promise.all` impossible |
| R7 | fingerprint | SHA-256 structural hash, `codeHash`, divergence detector, family-aware replay-check | code-by-hash registry / bundler (compiler) | hashing `toString()` rejected |
| R11 | late reward | one runtime method `recordOutcome` (authz + fence), two payload fields | reward pipeline (`attachOutcomes`) | side table rejected (new SPI) |
| R14 | `ctx.ui` | removes a dependency and an import | `surface(ctx)` in agent-surface, injected factory | — |
| R15 | open vocabularies | open string kinds, `RESOURCE_METERED.custom` | `a2a` effect to its plugin | no unit/price registry |
| R8k | conditional fence | none beyond the runtime option | **EventStore SPI optional `acquireFenceIf`**, retention pin predicate (orchestration) | LeaseStore park-lease rejected |

## 3. The single version plan

One bump per contract, shared by every item. Nothing here is a MAJOR.

| Contract | Now | Target | Driven by | Nature |
|---|---|---|---|---|
| **KERNEL_ABI** | 1.2.0 | **1.3.0** | R1b `continueAsNew`; R2 `receive`, `select`; R14 `ui` marked `deprecated` and `negotiateBudget` added to the table | additive MINOR; **removal of `ctx.ui` is a later MAJOR** |
| **EVENT_SCHEMA** | 1.22.0 | **1.23.0** | new kinds `EXECUTION_CONTINUED` (R1b), `MESSAGE_CONSUMED` (R2); additive payload fields: `EXECUTION_STARTED.{principal, parent, continuedFrom, chainId, generation, codeHash}` (R3k, R1b, R7), `EXECUTION_SUSPENDED.condition.waits[]` and `EXECUTION_RESUMED.waitId` (R2), `RESOURCE_METERED.custom` (R15), `OUTCOME_RECORDED.{recordedBy, late}` (R11); new reserved fold keys `_principal`, `_continuedTo`, `_inbox`, `_waitAnswers`, `_codeHash`, `_resources.custom` | additive MINOR; folded types 30 → 32 |
| **EVENT_STORE_SPI** | 2.0.0 | **2.1.0** | R8k optional `acquireFenceIf` (+ conformance case, decorators decide it) | additive MINOR |
| DISPATCHER_SPI | 1.2.0 | 1.2.0 | R3k deliberately adds nothing: the owner is read from the log | unchanged |
| SNAPSHOT_STORE_SPI, BRANCH_REGISTRY_SPI, LEASE_STORE_SPI, MEMORY / CONTENT SPI | — | unchanged | | |
| WIRE_ABI | 1.0.0 | 1.0.0 | gains fold test vectors only (fold vectors are not the wire protocol) | unchanged |
| `ExecutionAuthorizer` / `ExecutionOp` | — | `owner?` on the request, `"annotate"` op | R3k, R11 | additive type members (not a versioned SPI constant today; the conformance kit gains cases) |
| `InboxSource` | — | 1.0 (a function seam, not yet a versioned SPI) | R2 | new |

### How one bump lands across nine PRs

The constants move **once**, in the first PR (**W2-0**, small): it sets `KERNEL_ABI_VERSION` 1.3.0,
`EVENT_SCHEMA_VERSION` 1.23.0, `EVENT_STORE_SPI_VERSION` 2.1.0, regenerates the compatibility matrix
(`loom kernel-manifest --emit-docs`), adds the **fold handlers and wire-abi vectors** for every new kind and
field (pure folds; no writer), and adds a `pnpm test` fitness assertion that each new kind has both a handler
and, by the end of the wave, a writer. Each later item PR adds its writer, its syscall table entry, its
conformance cases and its ADR acceptance. The version has never been released (the monorepo is lockstep
and unpublished), so a reserved kind that no item ends up writing is deleted from W2-0's set before the
wave closes. That is the answer to the audit's R8 complaint (three kinds with handlers and no emitter,
`PARALLEL_STARTED`, `PARALLEL_COMPLETED`, `STEP_RETRYING`): the assertion makes a handler without a writer a
failing test at wave close instead of a permanent ABI member.

### Rolling upgrade: writers behind flags

A pre-1.23.0 node folds an unknown event kind as a no-op, so it would read an execution that ended in
`EXECUTION_CONTINUED` as still running, and would ignore `waits[]`. Therefore the **writers** of the new
shapes are off until the fleet is on 1.23.0: `defineConfig({ kernel: { features: { continueAsNew, inbox } } })`,
default false, turned on by the operator after the rollout. The optional payload fields that are harmless to
ignore (`principal`, `parent`, `codeHash`, `custom`, `late`) are written unconditionally from 1.23.0. This is
the same one-way-door discipline as every additive-kind bump (ADR 0102, 0107); the flags make the door explicit.

## 4. Items

### 4.1 R1b — bounded history and continue-as-new (ADR 0109)

**Problem.** Re-measure first: R1a removed the O(n²) *constants* (decision fold 5k/10k/20k = 2.3/10/42 s, live
commit 2.4 s at 5k, whole-log read per resume). What it could not remove: the runner is re-run from the top on
every resume (`WorkflowRuntime.execute` → `runner(ctx, input)`; each syscall is served from the fold), so turn
*n* of a message loop costs O(n) even when all calls hit the fold (`exp.cjs`: 0.14 ms at turn 250, 4.2 ms at
6,000, runner re-run 6,001 times, 1.2 MB state at 6,000 trivial turns), and every suspend writes the whole
state as a snapshot (R1a kept the per-suspend snapshot: it is the only bound on a resume tail when
`snapshotEvery` is unset, and now hands the state to the store by reference, but a serialising store still
pays O(state)). State is monotonic: `frames` (input and output per step id), `_decisions`, `_resumePayloads`,
`_outcomes`, `_resources`, the `_flowEmits` trie. Compaction (ADR 0022/0106) bounds the *log*; it cannot bound
the fold, because the re-run needs each recorded frame to short-circuit. ADR 0051/0052 deferred a chaining
primitive behind an evidence gate; the Part R relaxation of the second-consumer rule waives the gate, and ADR
0052's D2 draft is the starting specification.

**Placement.** Kernel (a terminal fact and a re-versioning point cannot be built from outside: "this execution
is over and its successor is owed" must be one durable event).

**Mechanism.**
- `ctx.continueAsNew(carry)` unwinds with a kernel sentinel (never returns). No `shouldContinueAsNew`: the
  suggestion would read a history length that differs on every re-run (non-deterministic); a flow counts its
  own turns.
- Commit point: `EXECUTION_CONTINUED { successorId, carry, chainId, generation, inbox cursors, resources }`
  appended under the predecessor's fence. It folds to `completed` with `_continuedTo`, so no
  `ExecutionStatus` is added and every 1P status switch stays total.
- Consequence owed: the successor `EXECUTION_STARTED { input: carry, continuedFrom, chainId, generation,
  principal }` at the deterministic id `<chainId>~<n>` using the ADR 0103 durable idempotent start. A crash
  between the two is repaired by `recoverAbandoned` / `runtime.recoverContinuations()`; because id and start are
  deterministic, **exactly one live successor exists after a crash at any point** (ADR 0052's frozen criterion).
- The successor runs the code registered *now* (a clean re-versioning point — this is what lets R7 stop
  pinning old closures forever). It inherits principal (R3k), tenant, tags and `chainId`; running `_resources`
  totals are carried so a rotation cannot reset a quota.
- `chainId` is the stable address; `resume`/`send` to a continued id walk `_continuedTo` (≤ 8 hops) to the head.
  The inbox stream is keyed by chain (R2), which supplies ADR 0052's chain-scoped inbox: a message between the
  predecessor's commit and the successor's start is delivered to exactly one run.

**Delta.** ABI `+continueAsNew`. Schema `+EXECUTION_CONTINUED`, `EXECUTION_STARTED.{continuedFrom, chainId,
generation}`, `_continuedTo`. SPI none.

**Replay and in-flight migration.** Existing logs have no such kind and replay byte-identically; nothing is
rewritten. A continuation is only legal when nothing is parked and no `parallel` scope is open (R6).

**Interactions.** R3k (successor inherits the record), R2 (inbox cursors travel in the commit), R6 (no rotation
inside an open scope), R7 (successor re-versions), R15 (resources carried), R8/R8k (the supervisor follows
`_continuedTo`; `parent` on the successor start).

**Verification.** The frozen DST criterion (kill between commit and successor start, message in flight, recover,
assert one successor and one delivery); `exp.cjs` with `continueEvery(500)` flat to 20k turns and bounded
snapshots; negatives (over-cap carry, open scope, double continuation); wire-abi vectors.

### 4.2 R3k — the durable principal (ADR 0111)

**Problem.** Nothing in `core`, `replay-vm`, `snapshot-runtime` or `event-runtime` mentions a principal; the
runtime threads `RunOptions.principal` in memory only. Three consequences, one beyond the audit's list:
(i) recovery (`recoverAbandoned`), timer wakes (`TimerService`), the supervisor's parent resume and local-worker
re-drives run the rest of the flow with **no principal** (R3 1P gave them a `SystemGrant`, which skips lifecycle
authz only and "never reaches an effect's authorization"); (ii) a delegation-attenuated child **regains `base`
authority** after recovery (`DelegationAuthorizer` enforces a present token and falls through to `base` when
absent; the token is not durable); (iii) **the effect principal is the resumer**: `resume`, `restoreFromState` and
`resumeAs` all end in `this.execute(…, options?.principal)`, so after an approval the flow's effects run as the
*approver*, and after a timer as nobody. Ownership is also in-process only (`executionAccessPolicy` fills a table
from `ExecutionAuthorizer.committed`).

**Placement.** The kernel only *records and rehydrates*; every decision stays 1P. Opaque by design (K12.1).

**Mechanism.** `EXECUTION_STARTED.payload.principal: PrincipalRecord { v, ref?, identity?{tenant,actor,
onBehalfOf}, delegation?{id, exp} }`, folded to `_principal`. Never the delegation token (bearer, permanent log,
K10). Rehydrate once per `execute()` through a `PrincipalResolver`; default rebuilds the identity subset and marks
`delegationUnresolved` when a delegation was recorded; an app may supply `principalCodec` so the log holds only an
opaque `ref` (the mode that can re-issue a narrowed token from the app's grant table — the supervisor does so
from the spawn decision it already journals). The effect principal becomes the recorded one on **every** entry
path; `options.principal` keeps one job, the lifecycle caller for `ExecutionAuthorizer` / `ResumeAuthenticator`.
`DelegationAuthorizer` denies a `delegationUnresolved` principal (never `base`). `ExecutionAuthzRequest.owner` is
filled from the record so `executionAccessPolicy` drops its in-process table. `parent` is recorded beside the
principal (lineage; used by R6's cascade sweep and R8k's pin predicate).

**Interaction with the Wave 1 pieces.** The `committed` hook stays (additive SPI) but stops being load-bearing;
the `SystemGrant` stays (it authorizes the lifecycle op of a timer or recovery, which still is not a principal),
but the *effect* identity of those paths is now the owner. DISPATCHER_SPI 1.2.0's `ExecutionPackage.principal`
keeps meaning "lifecycle caller for this dispatch"; a remote worker reads the owner from the log, so **no
dispatcher or worker SPI change is needed**.

**Delta.** ABI none. Schema `EXECUTION_STARTED.{principal, parent}`, `_principal`. Types: `owner?` on the authz
request, `PrincipalResolver`/`principalCodec` deps. DISPATCHER_SPI unchanged.

**Replay and migration.** Absent in every existing log: such executions fall back to today's behaviour
(`options.principal`). The change lands for executions *started* on 1.23.0 — and is BREAKING for them in one
respect (effects after an approval run as the owner, not the approver), stated in the CHANGELOG.

**Verification.** Principal survives crash-recovery, timer and supervisor resume (tenant policy fires);
approval by another actor leaves the effect principal as the owner; attenuated child after crash is still
attenuated or **denied**, never `base` (negative: passes `base` on `main`); `ref` mode writes no actor; no
delegation token string in any event; `owner` supplied after a process restart; the authorizer conformance kit
gains the `owner` case.

### 4.3 R2 — inbox, `receive`, `select` (ADR 0110)

**Problem.** (`exp2.cjs`) resume during a busy step throws `ResumeRefusedError` `not-suspended`
(`assertResumable`); `ctx.suspend` throws `SuspendError` *synchronously*, so `Promise.all([suspend(A),
suspend(B)])` aborts at the first element and the park records only gate A (`ExecutionState.suspendedOn` is a
single condition); answers are positional (`_resumePayloads[i]` answers the *i*-th call of a re-run), so
independent waits cannot be consumed out of order; a timed suspend has exactly two wakes, no race of
message / timer / approval.

**Placement.** Split. The audit's reason for the kernel is real but narrower than "a kernel inbox": an external
append at sequence *n+1* races the owner's own append, so atomic append-while-running cannot be a 1P wrapper.
The way out is to not append to the owner's log at all: the inbox is a **separate reserved stream**
(`__loom_inbox__:<chainId>`), the owner **pulls** and journals consumption into its own log. That makes the
stream, `send`, routing, pub/sub and fan-in all 1P (`@loom/inbox`), and leaves the kernel with the part that
cannot be 1P: a syscall that waits on several sources and a fact that records the consumption.

**Mechanism.** `ctx.receive(topic)`; `ctx.select([{gate}, {inbox}, {timer}])` → `{ arm, kind, value }`. These
register waits and return pending promises; the runtime parks when the flow is **quiescent** (no step in flight,
every live branch blocked). Each wait has a `waitId = <scopePath>#<ordinal>` (R6 mints the scope path); answers
are keyed by `waitId` (`EXECUTION_RESUMED.waitId`, fold map `_waitAnswers`), so out-of-order answers land on the
right wait. `EXECUTION_SUSPENDED.condition.waits[]` lists every wait (the legacy single-gate fields are still
written for a single-gate park, byte-identically, so `locatePark` and old readers are unaffected). The first
answered arm settles a `select`; a later answer to a sibling arm is refused (`wait-settled`). `assertResumable`
matches a resume to **some** gate wait; with `waitId` it checks *that wait's* `viewDigest` (ADR 0117 preserved
per wait); ambiguous names are refused. Consumption: `MESSAGE_CONSUMED { waitId, topic, messageId, inboxSeq,
payload }` in the owner's log (payload copied so the log is self-contained), per-topic cursor in the fold, FIFO
per topic, topic-only selection. Wake: `runtime.notifyInbox(chainId)` or any recovery sweep, via an ordinary
fenced resume. Dedupe: bounded window (default 1,024 consumed ids) — at-least-once send, exactly-once consume
within the window (open question 4 on `appendIfAbsent`). `ctx.suspend` is untouched.

**Relationship to R13 and `locatePark`.** `viewDigest` stays on the gate wait and is checked per wait; the park
event is still the newest `EXECUTION_SUSPENDED`, so `locatePark` and the signed-approval binding (`executionId`
+ park sequence) work unchanged. A signature binds the park, not a wait; binding a `waitId` into the signed
bytes is an additive `verify` context field, listed for the implementation PR.

**Delta.** ABI `+receive`, `+select`. Schema `+MESSAGE_CONSUMED`, `waits[]`, `waitId`, `_inbox`, `_waitAnswers`.
SPI none (`InboxSource` is a function seam). New 1P package `@loom/inbox`.

**Replay and migration.** Existing logs have no new keys; replay is identical. An execution that parked with
`waits` cannot be driven by an older node (feature flag `kernel.features.inbox`).

**Verification.** `exp2` inverted; two parallel receives park once with two waits; select with each arm
winning; stale arm answer refused; DST crash points (inbox append → consume → next park, duplicate send);
`viewDigest` still refuses a stale approval on a gate arm; per-topic FIFO under concurrent senders.

### 4.4 R6 — structured concurrency, and R9k (ADR 0112)

**Problem.** `ctx.parallel` passes `parallelLimit` only the execution signal; `failFast`'s own controller is never
handed to `run(step, input)`, so siblings are not cancelled. A branch that parks commits `EXECUTION_SUSPENDED`
and the sibling's `STEP_COMPLETED` follows it (`exp3.cjs`); only a fence keeps a *zombie* from corrupting the log,
and the fold carries a flag for the failure flavour (`_failedWhileParked`, ADR 0105). `STEP_CANCELLED` has a
fold handler and readers but **no writer**. Hand-rolled `Promise.all(ctx.execute…)` has no scope. Cancelling a
parent does not cancel supervised children.

**Placement.** Scopes and the park barrier: kernel (`WorkflowContext`, `ExecutionJournal`). **R9k, the cancel
cascade: 1P (`@loom/orchestration`)** — the plan wrote "kernel", but the kernel has no child relation and adding
one would be a new lineage SPI for a policy the supervisor already holds (it journals the spawn decisions and, with
R8, rebuilds them). The kernel supplies the signal (an effect that starts a child receives the abort and must
forward it); the supervisor observes its parent's `EXECUTION_CANCELLED` and cancels non-terminal children with
`reason { kind: "cascade", parent }`, opt-out `detached`.

**Mechanism.** Each `parallel` is a cancellation scope with its own controller and a deterministic `scopePath`
(`"0/2"`). Branches may be tuples or functions `(b: BranchContext) => Promise<T>` (the audit's "arbitrary
sub-flows" gap). Fail-fast aborts the scope, aborted steps record `STEP_CANCELLED`, the call rethrows the first
real error. **Park barrier:** a park is committed only after every in-flight step has settled (drain, default) or
been aborted (`onPark: "abort"`), bounded by `parkDrainMs` (30 s); past the bound the journal is *sealed* and a
late sibling append is dropped (its effect re-runs on resume under the same idempotency key). Result: no event
from this execution's own siblings follows `EXECUTION_SUSPENDED`.

**Delta.** ABI: none beyond `parallel` options (a behavioural change, MINOR). Schema none of its own — `scopePath`
reaches the schema through R2's `waitId`. A writer for `STEP_CANCELLED`; optionally for `PARALLEL_STARTED` /
`PARALLEL_COMPLETED` (carrying the scope path), which would give the analytics parallel-window feature data.

**Replay and migration.** Writes change, folds do not; a log with a post-park completion folds as before.

**Verification.** `exp3` inverted; fail-fast cancels a running sibling; `drain` vs `abort`; `parkDrainMs` expiry
seals and the dropped step re-runs once; scope paths stable across re-runs; nested scopes; DST crash between a
sibling's completion and the park commit; cascade live and via `recover()`, detached survives, child cancel does
not reach the parent.

### 4.5 R7 — body-aware fingerprint and dynamic-id migration (ADR 0113)

**Problem.** `flowContentHash` (`core/src/flowHash.ts`) is **32-bit FNV-1a over the flow id, version, deadline and
the declared steps** — its own comment says a body-only edit "folds an existing log identically", true only if
the edit preserves the id sequence. A branch change, an inserted or reordered step makes the re-run ask for
different ids over the same log: new ids execute live, old frames orphan, an effect that already ran runs
again. And `resumeAs(... "replay-check")` demands every recorded frame id be in `definition.steps`, which refuses
every dynamic-id agent (`id#n`, `agentLoop$` turn ids) — the agents that need the check.

**Placement.** Kernel for hash, field and detector; 1P for the code-by-hash registry and bundler (the registry
already holds several definitions per flow id and pins by hash; the missing part is producing the keys).

**Mechanism.** (D1) structural hash → SHA-256 (`sha256:`), `fnv1a:` recordings still accepted. (D2) optional
`FlowDefinition.codeFingerprint` from the toolchain (`@loom/compiler` already hashes handler chunks),
recorded as `codeHash`; a mismatch is `FlowCodeMismatchError` unless the registered flow lists the recorded value
in `compatibleWith` (an explicit author assertion, reviewed in the diff). The kernel does not hash
`toString()`. (D3) **replay-divergence detection**: at the first live step or at completion, every recorded
completed frame (outside an open parallel scope, which compares as a set) must have been visited, in
first-start order; otherwise `FlowDivergenceError` is raised **before** the live step, so no effect runs under a
diverged body. `off | warn | fail`, default `warn`, `fail` under strict. (D4) `replay-check` treats `base#…` as the
family `base`, plus `stepFamilies`.

**Delta.** ABI none. Schema `EXECUTION_STARTED.codeHash`, `_codeHash`. Runtime-only otherwise.

**Replay and migration.** Existing `flowHash` values remain valid; absent `codeHash` means "no fingerprint". The
detector is new behaviour on old logs, hence `warn` first: it reports a fault already silently present.

**Interactions.** R1b (a continuation is the clean re-version, so old closures need not ship forever); R6 (scope
sets); R3k none.

**Verification.** Diverging body edit refused *before* the effect runs (assert not invoked); `compatibleWith`
opt-in; dynamic-id agent passes `replay-check`, vanished family fails; `fnv1a:` log still resumes; no-fingerprint
flow unchanged.

### 4.6 R11 — late reward attach (ADR 0116)

**Problem.** `OUTCOME_RECORDED` can only be appended by a live run's `ctx.emit`/`EffectContext.emit`
(`analytics/src/outcomes.ts` takes an `OutcomeSink = { emit }`); `resume` refuses a non-suspended execution;
`resumeAs` is a code-migration verb. A reward that arrives days later has no home.

**Placement — decided, with the cost stated.** Bias is 1P; both 1P shapes lose. A **side table** keyed
`(executionId, decisionId)` is a new durable store (SPI + conformance kit + three backends) and forks the truth
about a trajectory, so every consumer joins; that is more surface than an append. A **1P function appending to
the terminal log** needs no new SPI but bypasses `ExecutionAuthorizer`, fencing and tenant scoping: a reward
steers policy learning, so an unauthorized writer is a poisoning channel. So: **one runtime method**,
`runtime.recordOutcome(executionId, { decisionId, key, success?, score? }, opts)`. Not a syscall; no new kind.

**Mechanism.** Authorized as a new `ExecutionOp "annotate"`; fenced first; legal on terminal/parked/running;
`decisionId` must exist in `_decisions`; `(decisionId, key)` idempotent, conflicting score refused; the event is
the existing `OUTCOME_RECORDED` plus additive `recordedBy` and `late: true`. The handler is unchanged and
status-neutral. 1P keeps the pipeline (`attachOutcomes`). `propensity` range validation is a separate tightening
(open question 8).

**Delta.** ABI none. Schema: two optional fields on an existing kind. Types: `"annotate"` op.

**Verification.** Late attach on a completed execution; unauthorized principal refused with the log untouched
(the negative); unknown/duplicate/conflicting; strict without principal; compaction keeps it; `trajectories`
sees it with no join.

### 4.7 R14 — `ctx.ui` out of the kernel (ADR 0114)

**Problem.** `ctx.ui` is `KERNEL_SYSCALLS` entry `ui` (`kind: "accessor"`); `workflow-runtime` depends on
`@loom/agent-surface` (→ `classify`, `projection-runtime`), imports a UI type into the kernel's own
`ExecutionContext`, and the layering guard (ADR 0043) forbids kernel → `plugins/*` but cannot see kernel →
application vocabulary. It is `createSurfaceEmitter((t, p) => this.emit(t, p))`: sugar over `emit`.

**Placement.** Out of the kernel. **Mechanism.** The type moves to agent-surface by declaration merging into an
empty `ExecutionContextExtensions`; the runtime gets the accessor from an injected factory
(`WorkflowRuntimeDeps.surface`), which `defineConfig`, `@loom/testing` and the scaffold supply; `surface(ctx)` is
the documented spelling; `ui` is marked `deprecated` in the ABI table (removal = a MAJOR); `negotiateBudget`'s
table drift is fixed in the same bump; the layering guard gains the inverse rule: **a kernel package depends only
on kernel packages** (red on `main`, green after).

**Delta.** ABI deprecation + table fix (inside 1.3.0). Schema none. **Behaviour:** a bare `new WorkflowRuntime`
with no `surface` dep throws on `ctx.ui` — the one place this is not strictly additive (open question 2).

**Verification.** The new layering invariant; `ctx.ui` in a composed app and a bare runtime with the dep; clear
error without it; table and interface agree; byte-identical events vs the old accessor. About 25 docs/decks that
show `ctx.ui` are updated in the implementation PR.

### 4.8 R15 — open vocabularies (ADR 0115)

**Problem.** `EffectKind = "tool"|"llm"|"human"|"a2a"`: the kernel gives exactly one value meaning (`"human"`
parks), `a2a` is a named protocol whose effect lives in `effect-runtime`; `TaskKind` adds `agent|ui|memory|plan`;
`ResourceDimension` is six names folded into a fixed `_resources` shape with a fixed ceilings table
(`METER_CEILINGS`), so GPU-seconds or API credits cannot be metered, budgeted or negotiated.

**Placement.** Kernel/core types and one fold; `a2a` to its plugin. **Mechanism.** Kinds become
`Known | (string & {})` with a documented pattern, `"human"` pinned as the sole semantic value;
`RESOURCE_METERED.custom: Record<string, number>` folded into `_resources.custom` (null-prototype semantics,
≤ 32 names, pattern, `__proto__` refused, default ceiling 1e15, per-dimension override via
`meterCeilings`); `ResourceDimension` open; budgets, quota and `negotiateBudget` accept any name; descriptive
`estimatedCost` map beside `estimatedCostUsd`. No unit or price registry.

**Delta.** ABI none (types). Schema `RESOURCE_METERED.custom`, `_resources.custom`. **Replay.** Optional, absent
until used; existing logs byte-identical.

**Verification.** custom kind round-trip; a custom `"human"`-kind effect still parks; pattern refusals; custom
dimension folds/snapshots/replays equal and trips `QUOTA_EXCEEDED`; cardinality and prototype negatives.

### 4.9 R8k — acquire-if-parked fence (ADR 0118)

**Problem.** `EventStore.acquireFence` is unconditional. The supervisor reads a park, acquires a fence, appends
the resume; a rival fencing between acquire and append fails the first (noisy), and one fencing between the
durable resume and the read-back **supersedes the holder of the already-running parent body** (dangerous). The
README's "Restart safety (R8)" documents both and names this follow-up. Separately, `LogLifecycle` can delete a
child whose parent is still parked on it.

**Placement.** The fence: **EventStore SPI, optional method** + one `RunOptions` field — the only place the
atomicity can live. The retention half: **1P** over the existing pin seam (ADR 0055). Not the kernel, and not a
new lease primitive.

**Mechanism.** `acquireFenceIf(executionId, { sequence }) → { fence } | { stale, head }`, atomic on the log head
(`locatePark` supplies the sequence). `RunOptions.fenceIfParkedAt` on `resume`/`resumeAs`; a `stale` result is the
existing `ResumeRefusedError` `not-suspended`, nothing appended. The winner's resume moves the head, so a later
conditional acquire sees `stale`: both windows close, and the supervisor's bounded-acquisition loop becomes one
attempt. Stores without it keep today's behaviour. Retention: `@loom/orchestration` `pinParkedChildren`
(a `PinPredicate`), auto-composed by `defineConfig` when `superviseChildren` is wired, using the child's recorded
`parent` (R3k) and the parent's park.

**Delta.** EVENT_STORE_SPI 2.0.0 → 2.1.0; ABI and EVENT_SCHEMA untouched by this item. Sharded and tenant
decorators forward it (ADR 0074 requires every decorator to decide).

**Verification.** Conformance: head matches/moved/concurrent; DST: two supervisors with crashes between acquire
and append and between append and read-back — the running parent is never fenced out, one resume is recorded;
`not-suspended` on an answered park with the log untouched; decorator kit lists the method; retention pins a
child while its parent is parked on it and releases it after.

## 5. Interactions, in one table

| | R1b | R3k | R2 | R6 | R7 | R11 | R14 | R15 | R8k |
|---|---|---|---|---|---|---|---|---|---|
| **R1b** | | successor inherits the record | cursors travel in the commit; chain-keyed inbox | no rotation in an open scope | successor re-versions | — | — | `_resources` carried | supervisor follows `_continuedTo` |
| **R3k** | | | `send` authorized by owner; `annotate`-like op for inbox | cascade uses recorded `parent` | — | `annotate` authz reads owner | — | — | `parent` feeds the pin predicate |
| **R2** | | | | scope path keys `waitId` | — | — | — | — | `viewDigest` per wait, `locatePark` unchanged |
| **R6** | | | | | scope-set comparison | — | — | — | — |
| **R7** | | | | | | — | — | — | — |

Two couplings are hard: **R6 before R2** (a wait needs a deterministic scope identity) and **R3k before R1b**
(a successor must be able to inherit something). Everything else can proceed in either order.

## 6. Implementation order

Each item is one PR with its ADR moved to Accepted at implementation (status line, CHANGELOG, a
`NOT_A_CAPABILITY` entry or a `CAPABILITIES` badge). **Opus first review** on every kernel/storage/concurrency/
security diff (W2-0, R3k, R6, R2, R1b, R7, R8k, R11); Sonnet on R14 and R15 and every re-review.
Two lanes at most (machine load rule); lane B has no dependency on lane A after W2-0.

| Step | PR | Lane | Needs | Notes |
|---|---|---|---|---|
| 0 | **W2-0** version reservation: constants, compat matrix, fold handlers + wire-abi vectors for every new kind/field, handler-needs-writer fitness test | — | this design accepted | small, mechanical, unblocks both lanes |
| 1 | **R3k** durable principal (0111) | A | W2-0 | everything inherits from it; BREAKING note |
| 2 | **R6** scopes + park barrier + cascade sweep (0112) | A | W2-0 | mints scope paths |
| 3 | **R2** inbox, receive, select + `@loom/inbox` (0110) | A | R6 | the largest PR; split `@loom/inbox` into its own PR |
| 4 | **R1b** continue-as-new (0109) | A | R3k, R2 (for the chain inbox) | measured acceptance on `exp.cjs` |
| 5 | **R14** `ctx.ui` out (0114) | B | W2-0 | independent; drops the dependency edge early |
| 6 | **R15** open vocabularies (0115) | B | W2-0 | independent |
| 7 | **R11** `recordOutcome` (0116) | B | R3k (owner for authz) | |
| 8 | **R7** fingerprint + divergence (0113) | B | R6 (scope sets) | default `warn` |
| 9 | **R8k** `acquireFenceIf` + pin predicate (0118) | B | R3k (`parent`) | SPI MINOR, conformance + DST |
| 10 | wave close: wave-wide DST, docs pass (SPI map, compat matrix, `loom-plugins` notes), remove any handler with no writer, flags documented | — | all | |

Consumer suites (`loom-examples`, `loom-plugins`) are run against the built dist for the PRs that tighten
behaviour (R3k, R14, R6, R7).

## 7. Open questions for the user

1. **One reservation PR, or one bump per item?** §3 proposes reserving 1.23.0 / 1.3.0 / 2.1.0 once in W2-0 with
   handlers and vectors landing before writers. The cost is a window where kinds exist with no writer; the
   mitigation is the handler-needs-writer fitness test and deletion of anything unwritten at wave close. The
   alternative is a bump per item (1.23 … 1.30), which is simpler to review and contradicts "planned once".
2. **`ctx.ui` and ABI 1.x (R14).** Dropping the kernel's dependency now means a bare runtime must be given the
   `surface` factory or `ctx.ui` throws — a break for direct-runtime users inside a MINOR. Accept it, or keep the
   dependency until the 2.0.0 that removes `ctx.ui`?
3. **R11 placement.** The design picks a small runtime method because both 1P shapes fail (a side table is a new
   store SPI; a 1P append bypasses authz). Confirm, or choose the side table and accept the SPI.
4. **Inbox exactly-once.** Bounded dedupe window (default 1,024) vs an `EventStore.appendIfAbsent(id)` method
   (SPI 2.1.0, one more conformance case) that makes duplicates impossible at the stream.
5. **R3k default.** Persist the bounded identity subset (`tenant`, `actor`, `onBehalfOf`) verbatim by default
   (zero-config, tenant policy works after recovery) or require `principalCodec`/`ref` mode for any app handling
   PII-bearing actor ids? The design defaults to the subset and offers `ref` mode.
6. **Fork principal.** A fork copies the prefix and so keeps the original owner's authority. Should a fork be
   allowed to run as the forker (an explicit option that would need an event)?
7. **Continuation details.** (a) The flow deadline is not carried — should a chain-level deadline exist?
   (b) `maxCarryBytes` default 1 MiB, `maxChainHops` 8 — right numbers? (c) Confirm the Part R waiver of ADR
   0052's evidence gate, and that ADR 0052 is amended on 0109's acceptance.
8. **`propensity` validation** (audit §2i: range (0, 1], unvalidated free-form `context`) is a tiny `ctx.decide`
   tightening that I left out of ADR 0116 to keep it about attaching rewards. Bundle it with R11, or its own ADR?
9. **R7 default.** The divergence detector defaults to `warn`. Should strict apps get `fail` by default?
   And producing `codeFingerprint` needs `@loom/compiler` work — in scope for the R7 PR or a follow-up?
10. **R9k placement.** I moved the cancel cascade from "kernel" (as the plan wrote it) to 1P orchestration,
    because the kernel has no child relation. Confirm.
11. **`parallel` branch functions (R6).** `ctx.parallel` accepting `(b: BranchContext) => Promise<T>` branches
    is the proposed shape; the alternative is a separate `ctx.scope(fn)`. Preference?
12. **Ghost kinds.** R6 would give `STEP_CANCELLED` a writer and optionally `PARALLEL_STARTED`/`PARALLEL_COMPLETED`;
    `STEP_RETRYING` still has none. Delete the unwritten kinds (an ABI removal is not allowed: the schema is
    additive-only) or document them as reserved?

## 8. Doc and guard checklist for this change (design PR)

- ADRs 0109–0116 and 0118 exist, each `Status: **Proposed**`. `spec.test.ts` exempts `Proposed` from the
  capability check (`NOT_A_CAPABILITY`); they are added there at acceptance, per item.
- `changelogCoverage` counts a `Proposed` ADR as accepted for its purposes, so the CHANGELOG mentions each by number.
- `adrIndexDocs`: the three range claims (`README.org`, `docs/README.md`, `docs/architecture.md`) move to 0001–0118
  and `architecture.md`'s enumeration names the new records.
- `docCitations`: every relative link here resolves; ADRs and this document cite symbols, not line numbers.
