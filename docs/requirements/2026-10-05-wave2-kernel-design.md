# Wave 2 — the coordinated kernel design (agentic-readiness, Part R)

- Status: **Proposed** — design only; no runtime code in this change.
- Date: 2026-10-05, against `main` at e880d0e.
- ADRs (all **Proposed**, accepted one by one at implementation): [0109](../adr/0109-bounded-history-and-continue-as-new.md)
  R1b · [0110](../adr/0110-durable-inbox-and-receive-select.md) R2 · [0111](../adr/0111-durable-principal.md) R3k ·
  [0112](../adr/0112-structured-concurrency.md) R6 (+ R9k) · [0113](../adr/0113-body-aware-code-fingerprint-and-dynamic-id-migration.md) R7 ·
  [0114](../adr/0114-ctx-ui-leaves-the-kernel.md) R14 · [0115](../adr/0115-open-vocabularies.md) R15 ·
  [0116](../adr/0116-late-outcome-attach.md) R11 · [0118](../adr/0118-acquire-if-parked-fence.md) R8k.
  (0117 is R13, already implemented.)
- **Revision: round 1** (Opus review of PR #495, NOT APPROVED, twelve P1s). Every P1/P2 is fixed in the
  ADRs and in §§2–6 below; the §7 open questions now carry a **Decided (default, pending user
  confirmation)** answer each (the user may override any of them); §9 lists the P3 notes. A stop-gap
  CHANGELOG "Known issue" and a `docs/usage.md` / README security note record today's principal behaviour
  until R3k lands (§4.2).
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
"does this have to be in the kernel, and how little of it?". The answers are in §1; the net is **three new ABI entries (`continueAsNew`, `receive`, `select`), two new runtime methods
(`send`, `recordOutcome`, both authorized), two new event kinds, one new execution status (`continued`), no
new store SPI beyond one optional method, and four items that are mostly or wholly 1P.**

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
| R1b | bounded history | `ctx.continueAsNew`, `EXECUTION_CONTINUED`, `continued` status, deterministic successor started FIRST (existing recovery repairs a crash; no new sweep) | chain lineage queries (analytics), supervisor follow-through, `continueEvery` helper (agent) | frame pruning rejected |
| R3k | durable principal | `principal` + `parent` on `EXECUTION_STARTED`, `_principal` fold key, `PrincipalResolver` seam, effect principal = owner | `executionAccessPolicy` reads the owner, delegation re-derivation (orchestration), DelegationAuthorizer fails closed | the delegation token is never persisted |
| R2 | inbox, receive, select | `ctx.receive` / `ctx.select`, `MESSAGE_CONSUMED`, multi-wait park condition, `InboxSource` seam, authorized `runtime.send` (the only inbox writer) | **`@loom/inbox`**: routing by name, pub/sub, retry, over `runtime.send` | content-predicate receive rejected |
| R6 | structured concurrency | scopes, park barrier, `STEP_CANCELLED` and `PARALLEL_COMPLETED` writers | cancel cascade to children (orchestration), **not** kernel | scoped `Promise.all` impossible |
| R7 | fingerprint | SHA-256 structural hash, `codeHash`, divergence detector, family-aware replay-check | code-by-hash registry / bundler (compiler) | hashing `toString()` rejected |
| R11 | late reward | one runtime method `recordOutcome` (authz + sequence CAS, terminal-only, no fence), two guarded payload fields | reward pipeline (`attachOutcomes`) | side table rejected (new SPI) |
| R14 | `ctx.ui` | removes a dependency and an import | `surface(ctx)` in agent-surface, injected factory | — |
| R15 | open vocabularies | open string kinds, `RESOURCE_METERED.custom` | `a2a` effect to its plugin | no unit/price registry |
| R8k | conditional fence | none beyond the runtime option | **EventStore SPI optional `acquireFenceIf` (CAS on the fence token)**, retention pin predicate (orchestration) | LeaseStore park-lease rejected |

## 3. The single version plan

One bump per contract, shared by every item. Nothing here is a MAJOR (the `ExecutionStatus` union widens
by one value; see the schema row).

| Contract | Now | Target | Driven by | Nature |
|---|---|---|---|---|
| **KERNEL_ABI** | 1.2.0 | **1.3.0** | R1b `continueAsNew`; R2 `receive`, `select`; R14 `ui` marked `deprecated` and `negotiateBudget` added to the table | additive MINOR; **removal of `ctx.ui` is a later MAJOR** |
| **EVENT_SCHEMA** | 1.22.0 | **1.23.0** | new kinds `EXECUTION_CONTINUED { successorId, chainId, generation }` (R1b), `MESSAGE_CONSUMED { waitId, topic, messageId, inboxSeq, sender, payload }` (R2); a **writer and payload for the existing `PARALLEL_COMPLETED { scopePath, failedBranch, error, cancelled[] }`** (R6); additive payload fields: `EXECUTION_STARTED.{principal (always `{ v: 1 }` at least), parent, continuedFrom { executionId, carried }, chainId, generation, codeHash}` (R3k, R1b, R7), `EXECUTION_SUSPENDED.condition.waits[]` and `EXECUTION_RESUMED.waitId` (R2), `RESOURCE_METERED.custom` (R15), `OUTCOME_RECORDED.{recordedBy, late}` (R11, guarded); new reserved fold keys `_principal`, `_continuedTo`, `_inbox`, `_waitAnswers`, `_waits`, `_scopes`, `_codeHash`, `_resources.custom`; **new `ExecutionStatus` value `"continued"`** (R1b) | additive MINOR; folded types 30 → 32. The widened status union is a source-level change for exhaustive switches (the consumer list is in ADR 0109 D2) and is listed in the CHANGELOG |
| **EVENT_STORE_SPI** | 2.0.0 | **2.1.0** | R8k optional `acquireFenceIf(id, { fence })` (+ conformance case, decorators decide it) | additive MINOR |
| DISPATCHER_SPI | 1.2.0 | 1.2.0 | R3k deliberately adds nothing: the owner is read from the log | unchanged |
| SNAPSHOT_STORE_SPI, BRANCH_REGISTRY_SPI, LEASE_STORE_SPI, MEMORY / CONTENT SPI | — | unchanged | | |
| WIRE_ABI | 1.0.0 | 1.0.0 | gains fold test vectors only (fold vectors are not the wire protocol) | unchanged |
| `ExecutionAuthorizer` / `ExecutionOp` | — | `owner?` on the request; new ops `"annotate"` (R11), `"send"` (R2), `"actAsOwner"` (R3k fork) | R3k, R2, R11 | additive type members (not a versioned SPI constant today; the conformance kit gains cases) |
| Reserved ids | — | `~` refused in caller-chosen execution ids at creation | R1b | behavioural; existing ids stay resumable |
| `InboxSource` | — | 1.0 (a function seam, not yet a versioned SPI) | R2 | new |

### How one bump lands across nine PRs

**Round-1 change.** The first draft had W2-0 land every fold handler first, with writers following. That
leaves reserved kinds that no writer uses and, worse, changes how **existing logs** fold: the guard's
`KERNEL` set is `knownEventTypes()` (`userspaceEmit.ts`), derived from the handler table, so once
`MESSAGE_CONSUMED` or `EXECUTION_CONTINUED` has a handler (a) an app that already emits an application
event with that name is refused at runtime from then on, and (b) such an event *already in a log* would
fold as a kernel fact (an app-emitted `EXECUTION_CONTINUED` would flip an execution to `continued`).
Therefore:

- **W2-0 moves only the constants and the compatibility matrix**, once (`KERNEL_ABI_VERSION` 1.3.0,
  `EVENT_SCHEMA_VERSION` 1.23.0, `EVENT_STORE_SPI_VERSION` 2.1.0; `loom kernel-manifest --emit-docs`). It
  adds no handler and no writer.
- **Each fold handler lands in the same PR as its writer, its syscall/method entry, its wire-abi vectors,
  its conformance cases and its ADR acceptance.** A handler without a writer is then impossible by
  construction, and the fitness assertion ("every kind with a handler has a writer") is a one-line test in
  W2-0 that every later PR keeps green.
- **The new kinds fold only kernel-written instances.** The journal stamps every envelope it writes for a
  new kind with `metadata.kernel: true` (operational metadata, the channel `fence` and `flowEmit` already
  use; copied by `copyPrefix` and compaction), and the new handlers ignore an envelope without the stamp.
  A pre-existing app event named `MESSAGE_CONSUMED` therefore folds as the no-op it always was, byte-
  identically. Emitting those names from userspace is refused from 1.23.0 (the guard does it automatically)
  and listed as a behaviour change; the implementation PRs grep `loom-examples`, `loom-plugins` and
  `loom-demo` for emits of the new names first (names an app could plausibly use are the reason for the
  stamp; renaming to `LOOM_…` was considered and rejected as inconsistent with the 30 existing kinds).
- The version has never been released (the monorepo is lockstep and unpublished), so a kind that no item
  ends up writing is never added. `PARALLEL_STARTED` and `STEP_RETRYING` remain reserved with handlers and
  no writer from before this wave (§7 question 12); the assertion lists them as the known exceptions.

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
  own turns. Legal only when running, outside any open `parallel` scope, with **no outstanding wait**, and
  after the **R6 park barrier** has drained every in-flight step (bounded by `parkDrainMs`).
- **Order (reversed in round 1): successor first, then the commit.** (1) Idempotently start the successor at
  `<chainId>~<n>` (ADR 0103) with `EXECUTION_STARTED { input: carry, chainId, generation, principal,
  continuedFrom: { executionId, carried: { resources, inbox{cursors, dedupe window}, chainDeadline } } }`;
  (2) commit `EXECUTION_CONTINUED { successorId, chainId, generation }` to the predecessor under its fence.
  The predecessor stays `running` until the commit, so the **existing `recoverAbandoned`** (which scans only
  `running`/`pending`, `recoverAbandoned.ts:218`) re-drives it after a crash: replay reaches the same
  `continueAsNew` with the same carry, the start is a no-op, the commit lands. **No new sweep, no
  `continuedFrom.sequence`.** The first draft committed first and made the predecessor terminal, which
  nothing would ever revisit.
- **Successor-id squatting is closed twice.** `~` is reserved in caller-chosen ids at creation (today
  `assertNotReserved`, `WorkflowRuntime.ts:277`, refuses only `__loom_` and the blank id), and the
  continuation start verifies that an existing sequence 0 has `continuedFrom.executionId ===` the
  predecessor, else a typed `ContinuationConflictError` (ADR 0103 D2 alone would treat any existing seq 0
  as success).
- **New status `"continued"`**, not `completed`. Consumers that read `completed` as "returned an output"
  would be wrong (`orchestration.ts` settle and status checks ~735, ~777, ~1154/1234–1243, `LogLifecycle`
  `TERMINAL` at line 35, analytics, learning `trajectories`, `eraseSubject`, `InProcessA2ABus`,
  `LocalWorkerRuntime`, `executeGraph`, `strayPassthroughs`, `blankStream`). ADR 0109 D2 lists them and each
  gets a test; the supervisor *follows* a continued child to its head rather than settling.
- The successor runs the code registered *now* (a clean re-versioning point). It inherits principal (R3k),
  tenant, tags and `chainId`; running `_resources` totals and the **absolute chain deadline** are carried,
  so a rotation cannot reset a quota or outlive a deadline.
- **Outstanding children:** on the commit, the supervisor cascade-cancels the predecessor's non-`detached`
  children (R9k); a child that must survive is `detached` and its id travels in the carry.
- `chainId` is the stable address; `resume`/`send` to a continued id walk `_continuedTo` (≤ `maxChainHops` 8)
  to the head and are authorized against the chain's owner. The inbox stream is keyed by chain (R2); the
  successor reads from the carried cursors and the **dedupe window travels with them**, so a message
  between the predecessor's last consumption and the successor's start is delivered exactly once and a
  sender retry after rotation is still deduplicated.

**Delta.** ABI `+continueAsNew`. Schema `+EXECUTION_CONTINUED`, `EXECUTION_STARTED.{continuedFrom, chainId,
generation}`, `_continuedTo`, status `continued`. SPI none. Reserved `~`.

**Replay and in-flight migration.** Existing logs have no such kind and replay byte-identically; nothing is
rewritten. A pre-1.23.0 node would see a continued predecessor as still `running` and re-drive it, so the
writer is behind `kernel.features.continueAsNew`.

**Interactions.** R3k (successor inherits the record), R2 (inbox cursors and dedupe window travel in the
successor's start), **R6 (the park barrier is a precondition; R6 lands first)**, R7 (successor re-versions),
R15 (resources carried), R8/R8k (the supervisor follows `_continuedTo`; `parent` on the successor start).

**Verification.** The frozen DST criterion at **both** crash points (before the successor start, and between
the start and the commit), message in flight; recover; assert one successor and one delivery; `exp.cjs`
with `continueEvery(500)` flat to 20k turns and bounded snapshots; negatives (over-cap carry, open scope or
wait, double continuation, pre-started `foo~1`, foreign seq 0); children cascade and detached carry;
deadline and dedupe survive rotation; a test per status consumer; wire-abi vectors.

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

**Known issue on `main` today (stop-gap documented in this change).** Until R3k lands, effects after a
resume run under the **resumer's** principal: the approver's grants after an approval; **no principal** after
a timer wake or recovery, so tenant DENY rules never fire (and a tenant-scoped ALLOW silently denies); and a
delegation-attenuated child regains `base` authority (`DelegationAuthorizer` falls through to `base` when
the token is absent, `authz.ts:198–200`). This is recorded as a CHANGELOG "Known issue" and a security note
in `docs/usage.md` and `README.org`, with the interim guidance (carry the authority you rely on as flow
data; do not rely on tenant DENY rules across a park; do not use delegation across a recovery). **R3k is
first in lane A**.

**Mechanism.** `EXECUTION_STARTED.payload.principal: PrincipalRecord { v, ref?, identity?{tenant,actor,
onBehalfOf}, delegation?{id, exp} }`, folded to `_principal`. Never the delegation token (bearer, permanent log,
K10). Rehydrate once per `execute()` through a `PrincipalResolver`; default rebuilds the identity subset and marks
`delegationUnresolved` when a delegation was recorded; an app may supply `principalCodec` so the log holds only an
opaque `ref` (the mode that can re-issue a narrowed token from the app's grant table — the supervisor does so
from the spawn decision it already journals). The effect principal becomes the recorded one on **every** entry
path; `options.principal` keeps one job, the lifecycle caller for `ExecutionAuthorizer` / `ResumeAuthenticator`.
**The kernel denies a `delegationUnresolved` principal itself** — `EFFECT_DENIED` before any authorizer is
consulted, because `PolicyAuthorizer` and 3P authorizers would otherwise authorize it — and **refuses a
`start` whose principal carries a delegation when no codec/resolver can restore it**
(`PrincipalUnrestorableError`); `defineConfig` auto-composes the orchestration codec when
`superviseChildren` is wired, so the supported path needs no configuration. **Every 1.23.0 start writes a
record (`{ v: 1 }` at least)**, so "absent" means legacy only. A **crypto-shredded principal denies** (never
falls back to `options.principal`), and `defineConfig` registers `principal.identity.*` as sensitive when
crypto is composed. **A fork acts as the forker** (`forkedBy` stamped into `forkMeta`, the resolver prefers
it; acting as the owner needs an explicit, separately authorized `{ actAs: "owner" }` / op `"actAsOwner"`),
because a fork is authorized only as `query` + `start` (`WorkflowRuntime.ts:2329–2368`) while `copyPrefix`
copies sequence 0 — the first draft would have given a reader the owner's authority. `ExecutionAuthzRequest.owner` is
filled from the record so `executionAccessPolicy` drops its in-process table. `parent` is recorded beside the
principal (lineage; used by R6's cascade sweep and R8k's pin predicate).

**Interaction with the Wave 1 pieces.** The `committed` hook stays (additive SPI) but stops being load-bearing;
the `SystemGrant` stays (it authorizes the lifecycle op of a timer or recovery, which still is not a principal),
but the *effect* identity of those paths is now the owner. DISPATCHER_SPI 1.2.0's `ExecutionPackage.principal`
keeps meaning "lifecycle caller for this dispatch"; a remote worker reads the owner from the log, so **no
dispatcher or worker SPI change is needed**.

**Delta.** ABI none. Schema `EXECUTION_STARTED.{principal, parent}`, `_principal`. Types: `owner?` on the authz
request, ops `"actAsOwner"`, `PrincipalResolver`/`principalCodec` deps. DISPATCHER_SPI unchanged.

**Replay and migration.** Absent in every existing log: such executions fall back to today's behaviour
(`options.principal`). The change lands for executions *started* on 1.23.0 — and is BREAKING for them in one
respect (effects after an approval run as the owner, not the approver), stated in the CHANGELOG.

**Verification.** (Round 1 adds: delegated start without a restorer refused; `delegationUnresolved` denied
under a `PolicyAuthorizer` and a permissive 3P authorizer; shredded principal denies; crypto composition
encrypts the identity paths; anonymous start records `{ v: 1 }`; fork runs as the forker.) Principal survives crash-recovery, timer and supervisor resume (tenant policy fires);
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
(`__loom_inbox__:<chainId>`), the owner **pulls** and journals consumption into its own log. Routing, pub/sub
and fan-in are 1P (`@loom/inbox`), **but the write is not**: `runtime.send` is the only writer and is
authorized (round 1; see below). The kernel keeps what cannot be 1P: a syscall that waits on several
sources, the fact that records consumption, and the authorized append.

**Mechanism.** `ctx.receive(topic)`; `ctx.select([{gate}, {inbox}, {timer}])` → `{ arm, kind, value }`. These
register waits and return pending promises; the runtime parks when the flow is **quiescent**, defined
operationally: the in-flight set of `ctx` operations is empty and every live branch is blocked on a
registered wait, evaluated at a macrotask boundary after the last settlement. It sees only `ctx`
operations; awaiting a non-`ctx` promise is outside the model (the existing determinism rule). Each wait has
a `waitId = <scopePath>#<ordinal>` (R6 mints the scope path as `<parent>/<k>.<branch>`, with `k` the ordinal
of the `parallel` call, so two sequential `parallel` calls cannot collide); answers are keyed by `waitId`
(`EXECUTION_RESUMED.waitId`, fold `_waitAnswers[waitId] = { kind, name, payload }`). Because a body edit can
shift an ordinal, the **answer stores the wait's kind and topic/gate name**; a re-run registering that
`waitId` with a different kind/name raises `FlowDivergenceError` instead of mis-delivering.
`EXECUTION_SUSPENDED.condition.waits[]` lists every wait (the legacy single-gate fields are still written for
a single-gate park, byte-identically, so `locatePark` and old readers are unaffected). **A timer arm's
`wakeAt` is recorded at first registration** (fold `_waits[waitId]`) and served on every re-registration, so
traffic on a sibling arm cannot push a deadline out. The first answered arm settles a `select`; a later
answer to a sibling arm is refused (`wait-settled`). `assertResumable` matches a resume to **some** gate
wait; with `waitId` it checks *that wait's* `viewDigest` (ADR 0117 preserved per wait); ambiguous names are
refused. **R13 signatures bind to (`executionId`, `waitId`, the sequence of the park that first recorded the
wait)** in multi-wait parks (an additive `verify` context field), so a signature for one arm cannot answer
another. Consumption: `MESSAGE_CONSUMED { waitId, topic, messageId, inboxSeq, sender, payload }` in the
owner's log (payload copied so the log is self-contained), per-topic cursor in the fold, FIFO per topic,
topic-only selection. Dedupe: bounded window (default 1,024 consumed ids, configurable) carried across
continuation — at-least-once send, exactly-once consume within the window; `appendIfAbsent` is deferred
(§7 question 4). `ctx.suspend` is untouched.

**Round-1 closures.**
- **No lost wakeup.** (1) At the quiescence commit the runtime reads each inbox wait's topic past its cursor
  and, if a message is there, satisfies the wait **live** (`MESSAGE_CONSUMED`) instead of parking. (2) After
  the park is durable it reads once more and, if something arrived in the gap, **self-resumes** using
  `acquireFenceIf(id, { fence: <park's fence> })` (R8k, so R8k lands before R2). (3) A cross-process send
  finishes by scheduling a **due-now `TimerStore` row** for the chain's head (no SPI change); `TimerService`'s
  fire path, which today resumes only a park whose recorded wake matches, is widened to run the notify path
  for a park with an inbox wait.
- **`send` is authorized.** `runtime.send(chainId, msg, { principal })` is judged as a new `ExecutionOp`
  `"send"` against the R3k owner of the chain head; the sender's identity subset is recorded on the message
  and in `MESSAGE_CONSUMED`; the delivered payload is **tainted** (ADR 0085). `@loom/inbox` builds on it.
  This also removes the contradiction between ADR 0109 D4 (`runtime.send`) and the first draft of ADR 0110
  (a 1P `send`), and mirrors the argument ADR 0116 makes against a 1P append.
- **The stream is bounded.** Sequence allocation uses `head()` (O(1)) instead of `read().length` (the reason
  compaction refuses reserved streams, `LogLifecycle.ts:607`); the stream is truncated below the **minimum
  consumed cursor** with `truncatePrefixKeeping` (safe because `MESSAGE_CONSUMED` copies the payload);
  `send` refuses past `inboxMaxBacklog` (10,000) with `InboxFullError`; the stream is deleted with the chain.

**Relationship to R13 and `locatePark`.** `viewDigest` stays on the gate wait and is checked per wait; the park
event is still the newest `EXECUTION_SUSPENDED`, so `locatePark` and the signed-approval binding work
unchanged for a single-gate park; the multi-wait binding is the `waitId` extension above.

**Delta.** ABI `+receive`, `+select`. Schema `+MESSAGE_CONSUMED`, `waits[]`, `waitId`, `_inbox`,
`_waitAnswers`, `_waits`. Runtime method `send`; op `"send"`. SPI none (`InboxSource` is a function seam).
New 1P package `@loom/inbox`. **Needs R6, R3k and R8k first.**

**Replay and migration.** Existing logs have no new keys; replay is identical. An execution that parked with
`waits` cannot be driven by an older node (feature flag `kernel.features.inbox`).

**Verification.** `exp2` inverted; two parallel receives park once with two waits; select with each arm
winning; stale arm answer refused; **lost-wakeup interleavings** (send between pre-park read and park, between
park and re-read, cross-process with an idle owner); unauthorized send refused with the stream untouched;
tainted delivery; send cost flat in stream length, trim and backlog bound; timer `wakeAt` pinned under
sibling traffic; sequential `parallel` scopes mint distinct `waitId`s and an ordinal shift diverges loudly;
signature for arm A does not answer arm B; DST crash points (inbox append → consume → next park, duplicate
send, across a continuation); `viewDigest` still refuses a stale approval on a gate arm; per-topic FIFO under
concurrent senders.

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
(`"<parent>/<k>.<branch>"`, `k` = the ordinal of the `parallel` call in its parent scope, so sequential
`parallel` calls cannot collide). Branches may be tuples or functions `(b: BranchContext) => Promise<T>` (the audit's "arbitrary
sub-flows" gap). Fail-fast aborts the scope, aborted steps record `STEP_CANCELLED`, the call rethrows the first
real error; a `SuspendError`/park is **not** a failure for fail-fast. **The scope outcome is journaled**
(round 1): `execute()` serves only completed frames and typed failures on replay (`WorkflowContext.ts:254–273`),
so a `STEP_CANCELLED` or untyped `STEP_FAILED` frame re-executes and fail-fast would be timing-dependent on
replay. The scope therefore appends `PARALLEL_COMPLETED { scopePath, failedBranch, error, cancelled[] }`
once before rethrowing (the existing reserved kind gets its first writer and folds `_scopes`); a re-run
serves the scope from it, rethrows the recorded error and does not start cancelled branches. **Park
barrier:** a park is committed only after every in-flight step has settled (drain, default) or
been aborted (`onPark: "abort"`), bounded by `parkDrainMs` (30 s); past the bound the journal is *sealed* and a
late sibling append is dropped (its effect re-runs on resume under the same idempotency key). Once a park is decided, **new step starts are frozen** (they wait for the resume). Result: no event
from this execution's own siblings follows `EXECUTION_SUSPENDED`. **R1b and R2 both depend on this barrier**,
so R6 lands before them.

**Delta.** ABI: none beyond `parallel` options (a behavioural change, MINOR). Schema: `scopePath` reaches it
through R2's `waitId`; writers for `STEP_CANCELLED` and `PARALLEL_COMPLETED` (with a payload and the
`_scopes` fold key). `PARALLEL_STARTED` stays reserved (no writer).

**Replay and migration.** Writes change; the folds of every existing kind do not, and a log with a
post-park completion folds as before. `_scopes` is absent in every existing log.

**Verification.** `exp3` inverted; fail-fast cancels a running sibling; `drain` vs `abort`; `parkDrainMs` expiry
seals and the dropped step re-runs once; scope paths stable across re-runs and distinct for sequential scopes; **fail-fast replay** (a cancelled
branch is not restarted and the same error is rethrown under different timing); park is not a failure;
nested scopes; DST crash between a
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

**Mechanism.** (D1) structural hash → SHA-256 (`sha256:`) computed by a small **pure-JS SHA-256 kept in
`core`** (platform-neutral; `flowContentHash` is also used by `app/src/verifyAdapter.ts:365`), `fnv1a:`
recordings still accepted. (D2) optional
`FlowDefinition.codeFingerprint` from the toolchain (`@loom/compiler` already hashes handler chunks),
recorded as `codeHash`; a mismatch is `FlowCodeMismatchError` unless the registered flow lists the recorded value
in `compatibleWith` (an explicit author assertion, reviewed in the diff). The kernel does not hash
`toString()`. (D3) **replay-divergence detection**: before the **first live journal append of any kind** (a step, but
also a `decide`, `emit`, timer, suspend or spawn) and at completion, every recorded completed frame
(outside an open parallel scope, which compares as a set; frames before an `EXECUTION_MIGRATED` are exempt,
the baseline resets there) must have been visited — **membership only, no order check**; otherwise
`FlowDivergenceError` is raised **before** that append, so nothing runs under a diverged body. `off | warn | fail`, default `warn`, `fail` under strict. (D4) `replay-check` treats `base#…` as the
family `base`, plus `stepFamilies`.

**Delta.** ABI none. Schema `EXECUTION_STARTED.codeHash`, `_codeHash`. Runtime-only otherwise.

**Replay and migration.** Existing `flowHash` values remain valid; absent `codeHash` means "no fingerprint". The
detector is new behaviour on old logs, hence `warn` first: it reports a fault already silently present.

**Interactions.** R1b (a continuation is the clean re-version, so old closures need not ship forever); R6 (scope
sets); R3k none.

**Verification.** Diverging body edit refused *before* the effect runs (assert not invoked), including when
the first divergent append is a `decide`/`emit`; migrated execution not refused; pure reorder passes; `compatibleWith`
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

**Mechanism (round 1).** Authorized as a new `ExecutionOp "annotate"`. **Terminal executions only**
(`completed`/`failed`/`cancelled`/`continued`); a running or parked execution is refused, because the first
draft acquired the fence and `acquireFence` supersedes the holder, which would **kill a live run** — a live
run uses `ctx.emit`. The append is a **sequence compare-and-set** (`DuplicateSequenceError`, bounded retry),
**no fence**. `decisionId` must exist in `_decisions`; `(decisionId, key)` idempotent, conflicting score
refused; the event is the existing `OUTCOME_RECORDED` plus additive `recordedBy` and `late: true`. Those two
fields were forgeable (`OUTCOME_RECORDED` is userspace-emittable, `userspaceEmit.ts:25`), so
**`guardUserspaceEmit` refuses an `OUTCOME_RECORDED` carrying them**. The first draft's claim that a late
outcome "does not refresh retention" was false: `LogLifecycle.ts:320` measures `max(lastEvent.timestamp,
updatedAt)`, so **retention is changed to run from the newest terminal event**. The handler is otherwise
unchanged and status-neutral. 1P keeps the pipeline (`attachOutcomes`). `propensity` range validation is a
separate small PR, no ADR (§7 question 8).

**Delta.** ABI none. Schema: two guarded optional fields on an existing kind. Types: `"annotate"` op.
`LogLifecycle` retention clock.

**Verification.** Late attach on a completed execution; unauthorized principal refused with the log untouched
(the negative); running/parked refused with the holder's next append still succeeding; concurrent identical
calls append once; forged `recordedBy`/`late` from `ctx.emit` refused; late outcome does not extend
retention; unknown/duplicate/conflicting; strict without principal; compaction keeps it; `trajectories`
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
`meterCeilings`; **validated in `guardUserspaceEmit`** (`RESOURCE_METERED` is userspace-emittable), and the
**fold skips a bad key deterministically** rather than throwing); `ResourceDimension` open; budgets, quota and `negotiateBudget` accept any name; descriptive
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

**Mechanism (round 1: the condition is the fence token, not the head).** The first draft compared the log
head, premised on "the park is the last event". That is false: the runtime appends an **unfenced
`EXECUTION_DENIED` after a park** (`WorkflowRuntime.ts:664–700`), and `recordOutcome`/audit append too, so a
head check would strand parents and window 1 would not close. Now
`acquireFenceIf(executionId, { fence }) → { fence } | { stale, fence }` is atomic on the **fence token**; the
caller passes the token under which the park was written (`metadata.fence` of the park envelope, 0 if none),
which moves only when someone acquires. `RunOptions.fenceIfParkedAt` (the park sequence) on `resume`/
`resumeAs`: the runtime derives the token, and on `stale` **re-reads the park and retries (bounded, 3) if
it is the same wait**, else `ResumeRefusedError` `not-suspended`; it also re-checks `assertResumable` under
the acquired fence (closing a legacy unfenced answer path). The winner's acquire moves the token, so both
windows close and the supervisor's bounded loop becomes one attempt. Stores without it keep today's
behaviour. Retention: `@loom/orchestration` `pinParkedChildren` (a `PinPredicate`), auto-composed by
`defineConfig` when `superviseChildren` is wired, using the child's recorded `parent` (R3k; before it, the
supervisor's rebuilt state) and the parent's park. **R8k lands before R2** (inbox notify-resume uses it).

**Delta.** EVENT_STORE_SPI 2.0.0 → 2.1.0; ABI and EVENT_SCHEMA untouched by this item. Sharded and tenant
decorators forward it (ADR 0074 requires every decorator to decide).

**Verification.** Conformance: token matches/moved/concurrent, and **an unfenced `EXECUTION_DENIED` after the
park does not make the acquire stale**; DST: two supervisors with crashes between acquire and append and
between append and read-back — the running parent is never fenced out, one resume is recorded;
`not-suspended` on an answered park with the log untouched; decorator kit lists the method; retention pins a
child while its parent is parked on it and releases it after.

## 5. Interactions, in one table

| | R1b | R3k | R2 | R6 | R7 | R11 | R14 | R15 | R8k |
|---|---|---|---|---|---|---|---|---|---|
| **R1b** | | successor inherits the record | cursors **and dedupe window** travel in the successor's start; chain-keyed inbox | **needs the park barrier**; no rotation in an open scope; children cascade | successor re-versions | outcomes on `continued` | — | `_resources` carried | supervisor follows `_continuedTo` |
| **R3k** | | | `send` authorized as op `"send"` against the owner; sender recorded | cascade uses recorded `parent` | — | `annotate` authz reads owner | — | — | `parent` feeds the pin predicate (works without it) |
| **R2** | | | | scope path (`<k>.<branch>`) keys `waitId` | divergence on a shifted ordinal | — | — | — | **notify-resume uses `acquireFenceIf`**; `viewDigest` per wait, `locatePark` unchanged |
| **R6** | | | | | scope-set comparison | — | — | — | — |
| **R7** | | | | | | — | — | — | — |

Hard couplings (round 1 re-derived them): **R6 before R2 and before R1b** (a wait needs a deterministic
scope identity; both rotation and the park need the barrier); **R3k before R2 and R1b** (`send` is
authorized against the owner; a successor must inherit a record); **R8k before R2** (the notify-resume and
the lost-wakeup self-resume use the conditional fence); **R3k before R11** (the owner for `annotate`).
Everything else can proceed in either order.

## 6. Implementation order

Each item is one PR with its ADR moved to Accepted at implementation (status line, CHANGELOG, a
`NOT_A_CAPABILITY` entry or a `CAPABILITIES` badge); **each fold handler lands with its writer** (§3).
**Opus first review** on every kernel/storage/concurrency/security diff (W2-0, R3k, R6, R2, R1b, R7, R8k,
R11); Sonnet on R14 and R15 and every re-review. Two lanes at most (machine load rule).

| Step | PR | Lane | Needs | Notes |
|---|---|---|---|---|
| 0 | **W2-0** version reservation: constants and compat matrix only, the handler-needs-writer fitness test | — | this design accepted | small, mechanical; **no handlers** |
| 1 | **R3k** durable principal (0111) | A | W2-0 | everything inherits from it; BREAKING note; the stop-gap Known-issue note is already published |
| 2 | **R8k** `acquireFenceIf` (token) + pin predicate (0118) | B | W2-0 | SPI MINOR, conformance + DST; the fence half has no other dependency |
| 3 | **R6** scopes + park barrier + `PARALLEL_COMPLETED` + cascade sweep (0112) | A | W2-0 | mints scope paths; the barrier R2 and R1b need |
| 4 | **R14** `ctx.ui` out (0114) | B | W2-0 | independent; drops the dependency edge early |
| 5 | **R2** inbox, receive, select, `runtime.send` + `@loom/inbox` (0110) | A | R3k, R6, R8k | the largest PR; split `@loom/inbox` into its own PR |
| 6 | **R15** open vocabularies (0115) | B | W2-0 | independent |
| 7 | **R11** `recordOutcome` (0116) | B | R3k (owner for authz) | retention-clock change rides along |
| 8 | **R1b** continue-as-new (0109) | A | R3k, R6 (barrier), R2 (inbox cursors) | measured acceptance on `exp.cjs` |
| 9 | **R7** fingerprint + divergence (0113) | B | R6 (scope sets) | default `warn`, `fail` under strict |
| 10 | wave close: wave-wide DST, docs pass (SPI map, compat matrix, `loom-plugins` notes), flags documented | — | all | |

Consumer suites (`loom-examples`, `loom-plugins`) are run against the built dist for the PRs that tighten
behaviour (R3k, R14, R6, R7, and R2 for the new ops).

## 7. Open questions for the user — each with the DEFAULT decision adopted in round 1

Every item below is **Decided (default, pending user confirmation)**: the answer is the review's
recommendation, adopted so the work is not blocked; the user may override any of them.

1. **One reservation PR, or one bump per item?** *Decided (default, pending user confirmation):* W2-0 moves
   the three constants and regenerates the compat matrix once; **each fold handler lands with its writer**
   (§3). Rationale: "planned once" is kept, and no kind ever exists without a writer or changes how an old
   log folds.
2. **`ctx.ui` and ABI 1.x (R14).** *Decided (default, pending user confirmation):* accept the break now.
   Rationale: the monorepo is lockstep and unpublished; the consumer suites are run to measure it.
3. **R11 placement.** *Decided (default, pending user confirmation):* a runtime method, **terminal-only, no
   fence** (sequence CAS). Rationale: both 1P shapes fail, and a fence would kill live runs.
4. **Inbox exactly-once.** *Decided (default, pending user confirmation):* a bounded dedupe window, **carried
   across continuation** and configurable; `appendIfAbsent` deferred. Rationale: avoids an SPI MINOR without
   evidence of need.
5. **R3k default.** *Decided (default, pending user confirmation):* persist the verbatim identity subset by
   default, **auto-register it as sensitive when crypto is composed, and deny when it has been shredded**;
   `ref` mode for PII-bearing ids. Rationale: zero-config tenant policy that stays erasable.
6. **Fork principal.** *Decided (default, pending user confirmation):* **a fork acts as the forker**
   (`forkedBy` in `forkMeta`); acting as the owner is an explicit, separately authorized option. Rationale:
   the first draft gave a reader the owner's authority.
7. **Continuation details.** *Decided (default, pending user confirmation):* (a) an **absolute chain deadline
   is carried**; (b) `maxCarryBytes` **256 KiB**, `maxChainHops` **8**; (c) the Part R waiver of ADR 0052's
   evidence gate is confirmed and ADR 0052 is amended on 0109's acceptance. Rationale: a rotation must not be
   a way to outlive a deadline, and 1 MiB per generation defeats the bound the feature exists for.
8. **`propensity` validation.** *Decided (default, pending user confirmation):* its **own small PR, no ADR**.
   Rationale: a `ctx.decide` input tightening unrelated to attaching rewards.
9. **R7 default.** *Decided (default, pending user confirmation):* `warn` by default; under strict it
   **fails, on membership only** (no order check). Producing `codeFingerprint` in `@loom/compiler` is a
   **follow-up**, not in the R7 PR. Rationale: detection of a silent fault arrives as a warning first.
10. **R9k placement.** *Decided (default, pending user confirmation):* **1P (`@loom/orchestration`)
    confirmed**; the kernel has no child relation.
11. **`parallel` branch functions (R6).** *Decided (default, pending user confirmation):* branch functions on
    `ctx.parallel` are fine, **with the parallel-call ordinal in `scopePath`** (`<k>.<branch>`). Rationale: no
    second scope API, and sequential scopes cannot collide.
12. **Ghost kinds.** *Decided (default, pending user confirmation):* `PARALLEL_COMPLETED` **gets a writer**
    (R6 fail-fast outcome); `STEP_RETRYING` and `PARALLEL_STARTED` **stay reserved** (an ABI removal is not
    allowed: the schema is additive-only) and are the listed exceptions to the handler-needs-writer test.

## 8. Doc and guard checklist for this change (design PR)

- ADRs 0109–0116 and 0118 exist, each `Status: **Proposed**`. `spec.test.ts` exempts `Proposed` from the
  capability check (`NOT_A_CAPABILITY`); they are added there at acceptance, per item.
- `changelogCoverage` counts a `Proposed` ADR as accepted for its purposes, so the CHANGELOG mentions each by number.
- `adrIndexDocs`: the three range claims (`README.org`, `docs/README.md`, `docs/architecture.md`) move to 0001–0118
  and `architecture.md`'s enumeration names the new records.
- `docCitations`: every relative link here resolves; ADRs and this document cite symbols, not line numbers.
- Round 1 adds no new guard: the docs-only change keeps the ADR range claims, the CHANGELOG coverage and
  the citations green. The CHANGELOG gains a "Known issue" entry and `docs/usage.md` / `README.org` a
  security note (§4.2), which are prose, not new guarded claims.

## 9. Notes carried from review round 1 (P3)

- **SHA-256 in the platform-neutral core.** `flowContentHash` is used in `core`, `workflow-runtime` and
  `app/src/verifyAdapter.ts:365`; `core` may not import `node:crypto`. ADR 0113 D1 keeps it in `core` with a
  small pure-JS SHA-256 pinned by FIPS 180-4 vectors (the alternative, moving it to `workflow-runtime`,
  inverts the `app` dependency).
- **Mixed-fleet effect identity during rollout.** A node that predates R6 derives step ids for scoped
  branches differently from one that has it, so a flow re-run across such a fleet could ask for different
  ids. The writers are behind `kernel.features.*` (§3), so the flag is the fleet-wide marker; the R6
  implementation PR must either keep step ids byte-identical for every non-scoped step (the intent) or gate
  any change to id derivation behind the same flag, and says which in its ADR acceptance.
- **R9k orphan scan.** Finding children whose parent record is gone is a full scan of the child side. The
  guarantee is stated as *a scheduled `recover()`* (it bounds the orphan lifetime), not a live property;
  the supervisor's rebuilt state handles the common path.
- **`EXECUTION_CONTINUED.resources` field-list mismatch** (the first draft listed it in D2 and D3
  differently): resolved by moving every carried item into the successor's
  `EXECUTION_STARTED.continuedFrom.carried`; `EXECUTION_CONTINUED` is `{ successorId, chainId, generation }`.
