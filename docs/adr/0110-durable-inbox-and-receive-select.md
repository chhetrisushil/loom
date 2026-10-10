# ADR 0110 — A durable inbox, `ctx.receive` and `ctx.select`, and concurrent waits

- Status: **Accepted** (2026-10-07) — design approved after 4 review rounds (Proposed 2026-10-05); implemented by R2 (this PR). See "Implementation notes" at the end for what was built, the deviations and the measurements.
- Date: 2026-10-05
- Closes: R2 (agentic-readiness audit, kernel appendix §2d/§2e, gap 2)
- Builds on: [ADR 0057](0057-multi-gate-suspend-passthrough.md) (gate *i* receives the *i*-th
  recorded resume payload), [ADR 0077](0077-typed-resume-payloads.md), [ADR 0104](0104-recovery-never-answers-a-gate.md)
  (every `_resumePayloads` entry answers exactly one suspend point),
  [ADR 0117](0117-approvals-bound-to-what-the-approver-saw.md) (`viewDigest`, `locatePark`),
  [ADR 0112](0112-structured-concurrency.md) (scope identity, which keys a wait),
  [ADR 0109](0109-bounded-history-and-continue-as-new.md) (the chain the inbox is keyed by),
  [ADR 0111](0111-durable-principal.md) (the owner `send` is authorized against),
  [ADR 0118](0118-acquire-if-parked-fence.md) (the conditional fence a notify-resume uses),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (delivered payloads are tainted).
- Placement: **split.** Kernel: `ctx.receive` / `ctx.select`, the `MESSAGE_CONSUMED` fact, the
  multi-wait park condition, the reader seam, and an **authorized `runtime.send`** (the only writer of the
  inbox stream). **1P** (new `@loom/inbox`): routing by logical name, pub/sub, fan-in, retry helpers, all
  built on `runtime.send`. Shares the Wave 2 bump (KERNEL_ABI 1.3.0, EVENT_SCHEMA 1.23.0).
- Revision: round 2 — the due-now notify row is coalesced (D5.3), the stream trim before a continuation
  commits is conservative (D1), the chain head is resolved with a successor probe (ADR 0109 D4), a fork
  leaves the chain and never reads the owner's inbox (D1), the `metadata.kernel` stamp's guarantees are
  stated and tested (Marker). Round 1 (Opus review of PR #495) closed a lost-wakeup window (D5), moved `send` behind
  authorization (D1; this also fixes the contradiction with ADR 0109 D4, which already called it
  `runtime.send`), bounded the inbox stream (D1), pinned timer `wakeAt` (D4), disambiguated `scopePath` and
  `waitId` (D3), defined quiescence (D2), and bound R13 signatures to the wait (D4). **Needs ADR 0118
  (`acquireFenceIf`), ADR 0112 and ADR 0111 first.**

## Context

Four measured limits (`exp2.cjs`):

1. **Resume while the agent is busy is refused.** `assertResumable` rejects any resume unless
   `status === "suspended"` and the event name equals the single recorded gate
   (`ResumeRefusedError`, `not-suspended`). A message that arrives while the agent is mid-step is
   lost or must be retried by the sender.
2. **One wait per park.** `ctx.suspend` *throws* `SuspendError` synchronously, so
   `Promise.all([ctx.suspend(A), ctx.suspend(B)])` unwinds at the first array element and records
   only gate A. `ExecutionState.suspendedOn` is a single condition.
3. **Answers are positional.** `_resumePayloads[i]` answers the *i*-th `suspend` call of a re-run.
   Two logically independent waits cannot be consumed out of order, and a re-run that reaches its
   waits in a different order (a parallel scope) hands each the other's answer.
4. **No race.** A timed suspend has exactly two wakes (the gate, or `TIMER_FIRED`); there is no
   "message OR timer OR approval, whichever first".

The audit's placement note: a per-execution inbox cannot be built in userland with atomicity,
because an external append at sequence *n+1* races the owner's own append (optimistic
`DuplicateSequenceError` on the OWNER). The design below avoids that race instead of making
the external append atomic with the fold.

## Decision

### D1 — The inbox is a separate stream, written only by an authorized `runtime.send`; the owner PULLS

Messages live in a reserved control stream `__loom_inbox__:<chainId>` (ADR 0109: keyed by chain, so it
survives a continuation). The owner never has its own log appended to by a sender, so there is no sequence
race with it (the rejected design below); the owner **pulls** and journals consumption into its own log.

**The only writer is `runtime.send(chainId, { topic, payload, messageId }, { principal, system? })`.** The
first draft had `@loom/inbox` append to the stream directly, which is a 1P writer holding no authorization:
exactly the argument ADR 0116 makes against a 1P append for outcomes. Now:

- `send` is authorized as a new `ExecutionOp` **`"send"`** (additive union member; `executionAccessPolicy`
  maps it with a default scope of `"tenant"`), judged against the **owner of the chain's head** read from the
  log (ADR 0111 D5) — a continued id is resolved to the head first (ADR 0109 D4) — before "not found" is
  revealed, in the runtime's existing existence-hiding order. Under `security.strict` a call with no
  principal is refused.
- The runtime records the **sender** on the message (`sender: { tenant?, actor?, onBehalfOf? }`, the same
  bounded identity subset as ADR 0111 D1) and copies it into `MESSAGE_CONSUMED` (D5). The **payload is
  delivered tainted** (ADR 0085): the flow receives `tainted(payload, "inbox:<topic>")`, so it is refused in
  every prompt instruction position by `@loom/llm` unless a step explicitly unwraps it. A message is
  untrusted content from another party by construction.
- `@loom/inbox` (1P) keeps routing by logical name, pub/sub fan-out, dead-lettering, sender-side retry and
  the A2A / orchestration adapters; each of them calls `runtime.send`. This also resolves the
  contradiction between ADR 0109 D4 (`runtime.send`) and the first draft of this ADR (a 1P `send`).
- The kernel defines the reader seam: `InboxSource.read(chainId, topic, afterSeq, limit)`, passed as
  `WorkflowRuntimeDeps.inbox`; the default implementation is the runtime's own stream reader over its
  `EventStore`. A function type, not a versioned SPI, until a second implementation exists.

**The stream is addressed by chain, and a fork is not the chain.** `send` resolves its target to the head
of the chain (ADR 0109 D4, including the start-to-commit probe) and the stream is keyed
`__loom_inbox__:<chainId>`. A fork of a chain member stamps a **fresh `chainId` and generation 0 and ignores
`continuedFrom`** (ADR 0109 D7), so a fork has its own, empty inbox: it is never a second reader of the
owner's stream (no double consumption, no cursor interference), and a caller holding only `query` on the
member plus `start` cannot read the owner's inbox payloads through it (the payloads live in the owner's
`MESSAGE_CONSUMED` events and the owner's stream, neither of which the fork's chain addresses; the copied
prefix up to the fork point is the ordinary `query`-level disclosure the fork authorization already
accounts for).

**The stream is bounded and cheap to write.** Reserved control streams are refused by compaction
(`LogLifecycle.ts:607`: their writers "take their next sequence from `read().length`"), and a writer that
allocates from `read().length` is O(stream) per send. Two changes: (a) the inbox allocates its sequence
from the store's `head()` (optional method, `event-runtime/src/types.ts`; the `read().length` fallback only
where a store lacks it), an O(1) point read; (b) the runtime **trims** the stream with
`truncatePrefixKeeping` (the same optional method compaction uses, ADR 0106) below the **minimum consumed
cursor across the chain's topics**, which is safe because `MESSAGE_CONSUMED` copies the payload into the
owner's log (the log stays self-contained). A topic nobody consumes would pin the stream forever, so `send`
refuses beyond `inboxMaxBacklog` unconsumed messages per chain (default 10,000) with a typed
`InboxFullError` (the sender sees backpressure, the owner's log is untouched). Trimming runs on the owner's
consume path and on `recover()`. **Across a continuation the trim is conservative:** until the successor's
`EXECUTION_STARTED` is durable the trim uses the **predecessor's** cursors (they are the only ones that
exist), which can only be *lower* than the successor's carried ones (the carry is a snapshot of them), so a
trim never removes a message the successor has yet to consume; the successor's own cursors take over from
its sequence 0. The stream is **deleted with the chain**: when retention reclaims the head
of a chain (ADR 0109 D6), `LogLifecycle` deletes `__loom_inbox__:<chainId>` in the same sweep.

### D2 — `ctx.receive(topic)` and `ctx.select(arms)`

`ctx.receive(topic, opts?)` is `select([{ inbox: topic }])` returning the payload. `ctx.select` awaits the
first of several arms:

```ts
const r = await ctx.select([
  { gate: "Approval", viewDigest },        // a resume answers it (ADR 0117 binding preserved)
  { inbox: "user-message" },               // the next message on this topic
  { timer: { afterMs: 3_600_000 } },       // or { at: epochMs }; the wake is recorded once (D4)
]);
// r = { arm: 1, kind: "inbox", value: ... }
```

Unlike `suspend`, these are *registering* waits: they return a pending promise and record the wait with the
current scope. `ctx.suspend` is unchanged (throwing, single-wait, positional) and stays the legacy syscall;
a flow that does not use the new calls is unchanged.

**Quiescence, defined.** The runtime parks when the flow is *quiescent*: the in-flight set of `ctx`
operations (steps started through `execute`/`parallel`, which `WorkflowContext` tracks per ADR 0112 D3) is
empty and every live branch is blocked on a registered wait, evaluated at a **macrotask boundary** after
the last settlement (so continuations that run in microtasks after a settlement are given the chance to
register their next wait or start their next step before the park is decided). The definition covers only
`ctx` operations. A flow that awaits a **non-`ctx` promise** (a bare `fetch`, a timer of its own) is
invisible to it and can appear quiescent while it is pending; that is not a new hazard (a `ctx.suspend` park
also cannot know), it is the existing determinism rule (flow code does no I/O outside `ctx`, enforced by the
verify rules), and the park barrier (ADR 0112) still drains any in-flight `ctx` step first. Stated here so
the rule is a documented precondition and not an accident.

### D3 — A wait has an identity: `waitId = <scopePath>#<ordinal>`, and the answer proves the wait

ADR 0112 gives every `parallel` branch a deterministic `scopePath`. Two sequential `parallel` calls in the
same scope would both mint `"0/2"` for their branch 2, so the path is now
`<parent path>/<k>.<branch>` with `k` the ordinal of the `parallel` call within its parent scope (ADR 0112
D1); a wait's id is that path plus its ordinal within the scope, a pure function of the flow's control flow,
stable across re-runs. Answers are keyed by `waitId`: `EXECUTION_RESUMED` gains an additive optional
`waitId`, and the fold keeps `_waitAnswers: { [waitId]: { kind, name, payload } }`.

**The wait-addressed resume (frozen at W2-0).** `EXECUTION_RESUMED` is a bare answer today (its payload
IS the gate's answer), so the `waitId` cannot ride in the payload of a bare resume. A resume that
addresses ONE wait of a multi-wait park is written by the kernel with `metadata.kernel: true` and the
payload `{ waitId, payload }`. The fold recognises it only with the stamp, unwraps it (the flow receives
the inner `payload`, which may be `null`), and records `_waitAnswers[waitId] = { kind, name, payload }`
with kind and name taken from that wait in the park's `waits[]` (first answer wins), drops the wait's
`_waits` entry, and never touches `_resumePayloads`. A stamped resume naming no wait of the current
park re-opens status-only. An unstamped object that merely looks like `{ waitId, payload }` is an
ordinary answer. **The park's `waits` is stamp-gated too (W2-0 review).** `condition.waits` is
honoured only on a kernel-stamped `EXECUTION_SUSPENDED`: the runtime's commit site strips `waits`
(and an unearned `stepId`) from every userspace park, the R2 writer adds `waits` after the strip and
stamps the event, and the fold drops `waits` from an unstamped park. The lookup the resume does is
against the fold-owned `suspendedOn.waits` of a stamped park only, and is total (malformed entries
are skipped). **R13's pre-append `viewDigest` check** (ADR 0117) reads a wait-addressed resume's
**inner** payload: it echoes `payload.viewDigest` of the unwrapped value and is compared with the
`viewDigest` of THAT wait in `waits[]` (per wait; ambiguous names are refused as above); a bare resume is
checked against the single gate's digest exactly as today, and the signed-approval binding is
unchanged.

**Ordinals shift when a body is edited** (an inserted `receive` renumbers every later wait on the same
scope). So the fold stores, with each answer, the wait's **kind and its topic / gate name**; when a re-run
registers `waitId` X with a different kind or name than the recorded one, the runtime raises
`FlowDivergenceError` (ADR 0113's error, raised here without the detector so it works with the detector
off) instead of handing a message to the wrong wait. The positional `_resumePayloads` list remains for
`ctx.suspend`; the two mechanisms do not share entries (the ADR 0104 invariant holds per mechanism).

### D4 — The park condition lists every wait; timers are pinned; signatures bind to the wait

`EXECUTION_SUSPENDED.condition` gains `waits?: Wait[]`, each `{ waitId, kind: "gate" | "inbox" | "timer",
on?, topic?, viewDigest?, correlationKey?, wakeAt? }`. The legacy fields are still written for a
single-gate park, byte-identically, so an older reader and `locatePark` are unaffected. `assertResumable`
accepts a resume whose event name matches **some** gate wait; with `waitId` it checks that wait's
`viewDigest` (R13 preserved per wait); without one it refuses as `ambiguous-wait` when more than one gate
wait matches the name. A `select` is settled by its FIRST answered arm; a later answer to a sibling arm
is refused (`wait-settled`). Timer arms get one `TimerStore` row each; a stale fire for a settled arm is
refused the same way.

**`wakeAt` is recorded at first registration.** A timer arm's `afterMs` is relative, and in a multi-wait
park every sibling answer re-runs the flow, which would recompute `wakeAt = now + afterMs` each time and so
push the deadline out indefinitely under steady traffic. The wake time is therefore stored in the fold:
`_waits[waitId] = { kind, wakeAt }`, set from the first park whose condition lists the wait, and every later
registration of the same `waitId` is served the recorded `wakeAt` (an `afterMs` is a request, the recorded
instant is the fact). The entry is removed when the wait settles.

**R13 signatures bind to the wait.** In a multi-wait park the signature covering (`executionId`, park
sequence) no longer identifies which wait it approves, and a stale signature for one arm could answer
another. `signResume` / the authenticator context gains `waitId` and `waitRegisteredAtSequence` (the
sequence of the park that first recorded the wait); a resume carrying a `waitId` whose signature does not
bind both is refused. A single-gate park keeps today's binding byte-identically.

### D5 — Consumption is a journaled fact, and a send can never be lost

When a `receive` / inbox arm is satisfied, the owner appends `MESSAGE_CONSUMED { waitId, topic, messageId,
inboxSeq, sender, payload }` to its OWN log (payload copied in: the log is self-contained for replay,
independent of inbox retention). The fold keeps a per-topic cursor (`_inbox.cursors[topic] = inboxSeq`) and
the delivered payload under `_waitAnswers[waitId]`. Replay serves the answer from the fold and never reads
the inbox. Delivery is **FIFO per topic**; selection is by topic only (no content predicates).

**The lost-wakeup window.** A `send` while the owner is not parked appends to the stream and has nothing to
wake; if that append lands after the owner's pre-park inbox check and before its `EXECUTION_SUSPENDED`
commit, the message sits in the stream with nobody resuming for it. Three closures, in order:

1. **At the quiescence commit** the runtime reads each inbox wait's topic past its cursor (`InboxSource`).
   If a message is there it **satisfies the wait live** — appends `MESSAGE_CONSUMED` and continues running —
   instead of parking.
2. **After the park is durable** the runtime reads each inbox wait once more. If something arrived in the
   gap it **self-resumes**: a fenced resume using `acquireFenceIf(id, { fence: <park's fence>, parkSeq })`
   (ADR 0118), so a rival notifier cannot both resume. If it comes back `ResumeContendedError` it writes
   a backed-off re-drive row (ADR 0118 D4) instead of waiting for `recover()`, so the park-time self-resume
   has a live re-driver.
3. **Cross-process senders get a durable wake.** `runtime.send` finishes by scheduling a **due-now row in
   the existing `TimerStore`** — **coalesced**: the row is skipped when the chain head is not parked on an
   inbox wait (nothing to wake: the running owner's quiescence commit, closure 1, reads the stream) or when
   a due-now row for that head already exists, defined as `wakeAt <= now AND redrive IS NULL` (a supervisor
   redrive row, ADR 0118 D4, must not suppress an inbox wake; one row wakes the notify path, which drains every message
   past the cursors; N sends in a burst cost one row, not N). The notify path appends `[MESSAGE_CONSUMED, EXECUTION_RESUMED]` as ONE atomic `appendMany` under the
   fence acquired with `acquireFenceIf` (the resume is the only answering event; `MESSAGE_CONSUMED` stays
   ignorable, ADR 0118 D1); DST adds "crash mid-notify, the redrive completes with exactly one delivery".
   The check-then-insert race is benign (at worst
   two rows; the second fire is a no-op under the fenced resume). A timer's row is retired only when ITS wait is no longer
   pending in a multi-wait park, not merely when `status !== "suspended"` (ADR 0118 review round 2). The R2 implementation plan **must include
   a load test** (a burst of 10,000 sends to one parked chain: timer rows written, TimerService fires,
   wake latency) before the PR is merged, and records the measured row count in its ADR acceptance.
   The row for the chain's head (`TimerRecord { executionId, wakeAt: now }`; no SPI
   change). `TimerService`'s fire path today resumes only a park whose recorded wake matches
   (`suspended-on-this-wake`); it is widened to "parked with an inbox wait → run the notify path (read past
   the cursors, consume, resume)", otherwise a no-op. A same-process `runtime.notifyInbox(chainId)` is the
   fast path to the same code; the row is the guarantee that survives a sender or owner crash, and any
   node's `recover()` sweep runs it too.

Exactly-once consumption is a property of the owner's log (CAS on sequence plus the fenced resume), not of
the stream.

**Frozen fold shapes (W2-0).** `_inbox = { cursors: { [topic]: inboxSeq }, dedupe: string[] }`; the
cursor is monotone; `_waitAnswers[waitId] = { kind: "inbox", name: topic, payload }` (first answer wins);
a `messageId` already in the window advances the cursor and delivers nothing. Cursor reads are
own-property (`Object.hasOwn`): a topic named `toString` keeps a numeric cursor.

### D6 — Bounded dedupe, carried across continuation

Senders retry, so `messageId` is the idempotency key. The fold keeps the last **1,024** consumed
keys; a duplicate inside the window is skipped (its cursor advances without a consumption); one beyond the
window is delivered. The window is **fixed in the fold** and there is no setting for it: a pure fold cannot
read a runtime setting, so a smaller runtime window made the live run deliver a message the fold treated as
a duplicate (the log then replayed differently from the run that wrote it). The runtime's duplicate test
is exactly the fold's, "the key is in the folded window". **The key is `(sender, messageId)`**, not the bare
id: two senders that both number their messages `1, 2, 3` do not swallow each other's. It is journaled in
`MESSAGE_CONSUMED.messageId` as an opaque string (`dedupeKeyOf`: the lowercase hex SHA-256 of the JSON
array `[tenant, actor, onBehalfOf, messageId]`, a FIXED 64 characters however long the principal's fields
are), so the frozen fold and event shape are unchanged. **What an external projection of the log sees:**
`MESSAGE_CONSUMED.messageId` holds that per-sender dedupe KEY, not the sender's raw `messageId` (the raw id
is in the inbox stream entry only, and is gone once trimmed), and a DUPLICATE's event carries
`payload: null` (it advances the cursor and delivers nothing). A projection that needs the raw id or the
payload of a duplicate cannot read either from the owner's log. `messageId` is at most 256 characters (a longer one is refused: it lands in folded
state and every snapshot). **`sender` is only as trustworthy as the principal that sent it**: with no
`executionAuthorizer` wired it is whatever the caller claimed, and the keying inherits that. The contract:
*at-least-once send, exactly-once consumption within the window, per sender*. The window **travels across a continuation**
(`EXECUTION_STARTED.continuedFrom.carried.inbox`, ADR 0109 D4), so a retry after a rotation is still
deduplicated. An `EventStore.appendIfAbsent(id)` SPI method, which would make duplicates impossible at the
stream, is **deferred** (design document §7 question 4: adopt the bounded window; revisit with evidence).

### D7 — What stays 1P (`@loom/inbox`)

Routing by logical name (name → chain), pub/sub topics fanned out to several chains, dead-lettering,
sender-side retry and idempotency-key helpers, and the A2A / `@loom/orchestration` adapters that today do
this over `resume`, all over `runtime.send`. `runtime.resume` keeps its meaning (answer a parked gate);
the "message while busy" case becomes `send`.

## Marker

`MESSAGE_CONSUMED` (like every new kind) folds only when the envelope carries `metadata.kernel: true`
(design document §3). **No ingress accepts caller-supplied metadata for these kinds**: `ctx.emit`,
`runtime.send` and `recordOutcome` build the envelope in the kernel (the userspace guard also refuses the
kind by name), so the stamp cannot be forged from outside. The stamp must survive every path that re-appends
or rewrites an envelope, each with a test: `eraseSubject` (`compliance/src/eraseSubject.ts:156-158` only appends
`PAYLOAD_SHREDDED` tombstones and rewrites no envelope; the test pins that it stays so), `LogLifecycle` compaction and archive re-appends, `copyPrefix` (fork), and the
`EncryptingEventStore` / `ContentResolvingEventStore` decorators (they transform `payload`, never
`metadata`). A stripped stamp makes the event fold as the no-op a pre-existing app event always was, which is
loud in the conformance tests rather than silent in production.

## Replay and migration

All new fold keys are absent in an existing log, so every existing log replays byte-identically. An
in-flight execution that parks with `ctx.suspend` keeps today's single-wait condition. The new calls are
available only on 1.23.0 nodes (feature flag `kernel.features.inbox`, off until the fleet is upgraded). An
execution that has ever parked with `waits` cannot be driven by an older node (its fold ignores `waits`
and `MESSAGE_CONSUMED`): the same one-way door as any additive-kind schema bump, and the flag is the guard.

## Tests

`exp2.cjs` inverted (message during a busy step is delivered; two parallel receives park once with two
waits; answers consumed out of order land on the right wait); a `select` of gate+timer+inbox with each arm
winning in turn, and a stale answer to a losing arm refused; **lost wakeup**: a deterministic interleaving
(DST) where the send lands between the pre-park read and the park commit, and between the park commit and
the second read, and from another process with the owner idle (the due-now row fires), each asserting
exactly one `MESSAGE_CONSUMED`; **authz**: an unauthorized sender is refused with the stream untouched, the
sender is recorded, and the delivered value carries a taint; **bounds**: send cost does not grow with
stream length, trim below the minimum cursor keeps unconsumed messages, `InboxFullError` at the backlog, the
stream is deleted with the chain; **timer pinning**: a three-arm park with traffic on a sibling does not
move the timer arm's `wakeAt`; **identity**: two sequential `parallel` scopes mint distinct `waitId`s, and a
body edit that shifts an ordinal raises `FlowDivergenceError` rather than mis-delivering; **signatures**: a
signature for arm A does not answer arm B; DST: crash between inbox append and `MESSAGE_CONSUMED`, between
`MESSAGE_CONSUMED` and the next park, duplicate send (and across a continuation); ADR 0117 `viewDigest` still
refuses a stale approval on a gate arm; per-topic FIFO under concurrent senders; **fork × chain**: a fork of a chain member does not consume (or
advance the cursors of) the owner's inbox and cannot read its payloads; **coalescing**: a send to a running
(unparked) owner writes no timer row, a burst writes one; **trim before commit**: kill between the
successor start and the commit, with unconsumed messages, and assert none is trimmed; **marker** (below); topic with `__loom_` prefix
refused; payload over the inline cap refused at `send`.

## Rejected

- **Making `resume` legal while running** (buffer it in the execution's own log): the external append races
  the owner's sequence, and the positional passthrough would misalign.
- **A 1P-only `send`** (the first draft): bypasses `ExecutionAuthorizer`; a message steers an agent, so an
  unauthorized writer is an injection channel.
- **Content-predicate selective receive** (Erlang-style `receive` with patterns): non-deterministic on
  re-evaluation and a scan per call.
- **An inbox inside `@loom/orchestration`**: orchestration is parent/child; an inbox is the addressing
  primitive for every pair of parties.

## Consequences

- An agent can be addressed while it is busy, wait on several sources, and never lose a message to the
  park transition, at the cost of a second reserved stream per chain and one kernel runtime method.
- `runtime.send` is a kernel entry point (authz op `"send"`), so the inbox's security boundary is the
  kernel's; `@loom/inbox` is convenience, not trust.
- Order: this PR requires R8k (ADR 0118: `acquireFenceIf`), R6 (scope paths, barrier) and R3k (owner).

## Implementation notes (R2, accepted 2026-10-07)

What landed: `ctx.receive` / `ctx.select` (KERNEL_ABI 1.3.0 table entries; the shapes frozen at W2-0 were
sufficient, nothing in them changed), `runtime.send` and `runtime.notifyInbox`, the multi-wait park, the
wait-addressed resume (`ResumeEvent.waitId`), per-wait `viewDigest` and signature binding, the due-now
wake row, the owner-side trim and the stream's deletion with its chain, behind `kernel.features.inbox`
(`WorkflowRuntimeDeps.inboxEnabled`). Not in this PR: the 1P `@loom/inbox` package (routing by name,
pub/sub, dead-lettering, retry helpers). The design plan split it into its own PR; it calls only
`runtime.send`, so nothing here waits on it.

**Deviations from the text above, and why.**

1. **The notify path delivers ONE message per resume (D5.3).** The ADR said it "drains every message past
   the cursors". The park lists waits but not which of them belong to one `select`, and a `select`'s first
   answered arm settles it: consuming two messages for two arms of one `select` would lose one. The resumed
   run's quiescence commit (closure 1) knows the groups and drains the rest live without parking, so a
   backlog costs one wake, not one per message.
2. **`[MESSAGE_CONSUMED…, EXECUTION_RESUMED]` is ONE atomic `appendBatch`, and the inbox REFUSES a store
   without one** (new `ExecutionJournal.commitAtomic`; memory, SQLite and Postgres all have it). With
   `kernel.features.inbox` on, `WorkflowRuntime` throws at composition naming the requirement; there is no
   sequential fallback and no healing path is claimed for one. (The notify path still resumes a park whose
   wait is already answered, consuming nothing again, as a defensive no-op.)
3. **A contended post-park self-resume writes (or keeps) the due-now row, not a `redrive` row (D5.2).** A
   registered re-driver re-derives ITS resume and answers `noop` for an inbox wake, which would retire the
   row. The plain row is judged by the notify path, and `TimerService` backs off in process (the same
   schedule and attempt cap as a contended timed wake).
4. **The due-now row has a fixed `wakeAt` (`INBOX_WAKE_AT = -1`, a sentinel no timed park can collide with: `0` was a real instant).** The store's upsert per
   `(executionId, wakeAt)` then coalesces a burst without a query (the ADR's "a due-now row already
   exists" test, made free), and the skip-when-not-parked rule is sharpened: `send` writes the row only when
   the owner is parked on an UNANSWERED inbox wait for THAT topic. The row is retired only after the notify
   pass, and the park is looked at once more after retiring it, so a send that coalesced into the row just
   before is never stranded (the race the ADR called "benign").
5. **`send` classifies its target from the log's tail, not from a fold.** A running owner in a message loop
   holds thousands of events and possibly no recent snapshot; a fold per send is O(its log) (measured: the
   first build was quadratic). `send` reads sequence 0 and the newest 8 events, walks back past the kinds
   `EVENT_KIND_CLASS` calls ignorable (a `TIMER_FIRED` or discard `DECISION_RECORDED` whose resume never
   landed, an `APPROVAL_GRANTED` / `OUTCOME_RECORDED` / `EXECUTION_DENIED` audit row) to the newest ANSWERING
   kind, and folds only when that is a park (a parked owner took a snapshot at its park, so the fold is a
   short tail). A resume reads "running". **A window with NO answering kind at all (eight app emits,
   parallel `STEP_*`, timer fires, duplicate-only `MESSAGE_CONSUMED`) is AMBIGUOUS, never "running"**
   (unless the window reaches sequence 0, where the whole log was read): the park may lie further back,
   so `send` treats it as "maybe parked", writes the coalesced due-now row and runs the notify path,
   which judges the real state and no-ops for a running owner. **The wake decision is
   taken from a SECOND read after the append** (lost-wakeup protocol: the owner parks durably and then
   re-reads the stream, the sender appends and then reads the owner, so one always sees the other); the
   first read serves authorization and the closed-owner refusal only.
6. **`waitRegisteredAtSequence` is the sequence of the park that LISTS the wait, not the first park that
   registered it.** The frozen fold keeps only timer waits in `_waits`, so "first registration" is not
   recoverable for a gate wait. The binding is therefore stricter than the ADR's (a later re-park of the
   same wait needs a fresh signature), never weaker.
7. **`FlowDivergenceError` is defined here** (ADR 0113's detector is not merged); the check is intrinsic
   to a recorded answer's kind and name, so it needs no detector. R7 may extend the class.
8. **A message for a finished, failed or cancelled execution is refused** with `InboxClosedError`, nothing
   appended (the ADR was silent). `InboxMessageRefusedError` covers a bad topic or an oversize payload
   (`inboxMaxPayloadBytes`, default 64 KiB).
9. **`ctx.receive` / `ctx.select` inside `ctx.parallel` need `kernel.features.scopes`.** Without it every
   branch shares the root scope and waits would be numbered by timing; the branch context refuses the call.
   A root-scope `Promise.all([ctx.receive(a), ctx.receive(b)])` registers synchronously and is fine.
10. **The default `InboxSource` reads bounded range chunks**, not the whole tail, so a hot topic costs one
    `head()` and one small range read however long the stream has been.
11. **Latent bug fixed on the way:** `recoverAbandoned`, `orphanCensus` and `reconcileTimers` did not skip
    reserved control streams (`isReservedStream`), so an inbox stream (it folds to `pending`) was reported
    as an orphan and re-driven. `recoverAbandoned` also runs the notify path for a parked execution with an
    inbox wait (`inboxWoken`), and `reconcileTimers` re-asserts a multi-wait park's timer rows and the
    inbox row.

**Mixed flows.** A `ctx.suspend` / `ctx.sleep` park beside registered waits (a mixed park) keeps its legacy
fields and adds `waits`; a bare resume of the positional gate answers it as ever (the fold's
`_resumePayloads`), a bare `TIMER_FIRED` for a positional sleep is the legacy timed wake.

12. **Review round 1.** (a) A fork seeds its inbox stream with a floor marker at its highest inherited
    cursor, written BEFORE the child exists, so a send to a fork allocates above every inherited cursor
    (it used to land at a sequence the copied cursors had passed: skipped forever, then trimmed). The
    cursors stay what the fold computed (replay of the copied prefix needs them); a fork leaving the chain
    by a stamped `forkChain` is ADR 0109 D7's writer, not part of this change. (b) The notify path pages
    past duplicates (they carry no payload) and journals them in the same atomic batch as the real
    delivery, in chunks of 1,024; duplicates alone are journaled under the fence with no resume. (c) A
    refused send costs one bounded scan per 250 ms per chain, not a fold plus a full backlog read; trim
    scans from the known floor and stops at the first unconsumed message. (d) **When the head turns
    terminal its inbox stream is deleted**, after the terminal event is durable; a `send` re-reads the
    owner after its append and, seeing a terminal, deletes the stream again and reports `InboxClosedError`,
    so a send racing the completion leaves no orphan. (e) A node with the inbox flag off leaves the due-now
    rows alone (a flag-on node in a mixed fleet still needs them). (f) A second `ctx.receive` / `ctx.select`
    registered in a scope after any ctx operation started or finished while an earlier wait in that scope is
    unanswered is refused with a clear error (best effort: its ordinal would be completion order); waits
    registered in one synchronous turn, and branches of `ctx.parallel`, are unaffected. (g) A kernel-stamped
    park drops `_waits` entries for timer arms it no longer lists (their select was settled by another
    arm), so a loop of `select([inbox, timer])` does not grow folded state. (h) `inboxMaxPayloadBytes`
    measures UTF-8 bytes.

13. **Review round 2.** (a) `send` that finds the owner terminal on its post-append re-read first checks
    whether the message was DELIVERED (the owner's folded cursor for the topic is at or past its inbox
    sequence, or its dedupe key is in the window): then it returns the normal `SendResult`. Only an
    undelivered message is deleted with the stream and reported as `InboxClosedError` with `discarded:
    true` and text saying so (the pre-append refusal still says "Nothing was appended"). (b) **Backlog
    accounting is amortized O(1)**: the last exact count bounds every later one from above (+1 per send),
    so a chain far below the cap rescans once per (cap - backlog) sends. Measured on 1 cold message + 20,000
    hot sends (in-memory, sends only): 35.9 s (1,795 us/send, 3-4 ms past the 10k bound) before,
    0.98 s (49 us/send) after. (c) **One unconsumed message pins every entry above it**: the `EventStore`
    SPI deletes by PREFIX only (`truncatePrefix` / `truncatePrefixKeeping`), so a consumed hot-topic entry
    above an unconsumed cold one cannot be reclaimed. Storage is therefore bounded by refusal:
    `inboxMaxRetained` (default 4 x `inboxMaxBacklog`) is the most entries the stream keeps above its trim
    floor; past it `send` refuses with `InboxFullError` naming the pinning message, and consuming that
    message (or the chain's retirement) releases the stream. A per-topic stream would remove the pin and is
    the follow-up if a workload needs a cold topic beside a hot one. (d) A flag-off `TimerService` passes
    `due(..., { inbox: false })` (new, mirrors `redrive: false`; all three stores and the conformance kit),
    so inbox rows (sorted first) cannot fill its batch and starve real timers. Round 3: the sentinel was
    `0`, a real instant, so a flag-off node never fired `ctx.sleep(0)` at clock 0 (the default config's
    clock-zero case); it is now `-1` (the feature is unreleased, so no row of the old value exists), which
    no timed park can carry. (e) **A terminal execution stays terminal for
    senders, but `resume` / `resumeAs` CAN re-open a failed or completed one (ADR 0104).** Its stream was
    deleted when it finished, so a message not consumed by then is gone, and a re-opened execution would
    restart allocation at sequence 0 under the cursors its log still holds (every new message skipped).
    Re-open therefore seeds the allocation floor at the highest cursor (as for a fork) before the run
    starts. Unconsumed messages at the moment of the terminal are discarded, by design. (f) An inbox stream
    whose owner is terminal and whose id maps to an execution (`recoverAbandoned` enumerates reserved
    streams) is reclaimed by the sweep (`inboxReclaimed`): the orphan a crash between a sender's append and
    its re-read leaves. A fork's chain id is not an execution id and there is no chain-to-execution index,
    so a crash orphan of a fork chain is NOT swept (best effort: the normal terminal path still deletes it;
    only a crash in the sender's append-to-reread window leaves one, and it holds undelivered payloads of a
    finished execution until `eraseSubject`/retention reaches the reserved stream). (g) **The notify path answers under a conditional
    fence only when the park was written under a token.** A fencing store refuses an append with NO token
    once any token exists, so acquiring one on the first inbox delivery of a never-fenced deployment made
    every later plain `resume` / `resumeAs` / recovery of that execution fail as a stale fence (found by
    the re-open test). Unfenced, a rival notifier loses at the `(executionId, sequence)` uniqueness of the
    atomic batch. The dedupe key is a fixed-size hash (see D6).

**Review round 3 (R2, ADR 0110).**
- **The unfenced delivery is a loop, not a single shot, and a handle means the append LANDED.** An inbox
  delivery's batch is awaited before the runner starts (`ExecutionHandle` is still returned by `resumeCore`
  first, so the kernel keeps a private "landed" promise per handle and the notify path awaits it). A batch
  that loses is classified: (1) `StaleFence` on an unfenced attempt means a fence was acquired since the
  park was written (the documented re-dispatch path acquires without appending), so the next attempt
  answers under `acquireFenceIf` (recorded token 0, retried on the store's current one); (2) a
  `DuplicateSequence` / `StaleFence` with the park still the unanswered one means an ignorable event
  (`TIMER_FIRED`, an app emit, `EXECUTION_DENIED`) landed between the fold and the batch, so the pass refolds
  and retries (4 attempts), and out of attempts reports `contended` so the due-now row is kept; (3) the
  same error with the park already answered is a rival that won: a quiet "lost the race" (`{ contended:
  false }`, no handle, NOT reported to `onStorageError`). The loser's runner never starts. Duplicate-only
  journaling (`advanceInbox`) gets the same loop.
- **A caller that arrives while a pass is in flight gets a FOLLOW-UP pass**, not the in-flight one's
  result: that pass may have read the stream before this caller's append (a `send` landing just after the
  owner's own post-park read was answered "nothing to do" by a pass that never saw its message). Every
  mid-pass caller shares ONE follow-up.
- **`inboxMaxRetained` is configurable** as `kernel.inbox.maxRetained` (`defineConfig`), beside
  `maxBacklog`.
- **Pinned-stream DoS: an accepted, documented interim, now observable.** A topic nothing consumes pins the
  stream; the cap refuses further sends for the whole chain (including the hot topic). That is a bounded
  failure, not a leak, and a flow that never receives a topic it is sent has a bug. `onWarn` fires once per
  chain when the stream retains 50% of `inboxMaxRetained` above the oldest unconsumed message, naming that
  message's topic and inbox sequence (re-armed when the pin clears). Per-topic refusal was deliberately
  not built. Follow-ups: (1) a journaled, authorized operator discard (advance one topic's cursor up to a
  sequence, as a log event, so it replays) — **shipped by the 2026-10-11 amendment (D8)**; (2) per-topic
  streams, with an optional TTL via a journaled expiry — **designed in the amendment (D10), not built**.
- **`resume` / `resumeAs` re-open a terminal owner's inbox only after every refusal passed** (replay-check,
  migration, authz, not-suspended); a refused resume used to leave an empty stream behind for an execution
  that stays terminal.
- **Ambiguous-tip sends still write the due-now row BEFORE notifying** (considered and left): writing it
  only if notify finds an unanswered inbox park would save one coalesced upsert for a running owner, but
  the row-first order is what makes a sender's crash between its append and its notify recoverable, and a
  notify that sees "running" proves nothing about a park that lands a moment later. The write is one
  idempotent upsert per `(execution, instant)`; the row is not worth weakening the no-lost-wakeup argument.

**Residuals (documented, not closed).**
- A message consumed for a branch that is then aborted by a sibling's failure is consumed: it is recorded
  in the log and the flow never sees it (the same as a gate answer in an aborted scope).
- The inbox stream holds payloads until they are consumed and trimmed or the head turns terminal (the
  stream is deleted then). ~~**`eraseSubject` does not reach payloads still in flight in the stream**~~ **CLOSED
  by the 2026-10-11 amendment (D9)**: erasure now reaches the reserved stream, cryptographically and physically.
- **The park-per-message loop is quadratic until the flow rotates (R1b, ADR 0109, now Accepted).** A slow-sender loop re-parks between messages and
  every park snapshots (and every wake re-runs) a state holding one answer per consumed message: turn n is
  O(n), the whole conversation O(n^2). The inbox itself is flat (measured below); continue-as-new (R1b,
  ADR 0109: a loop rotates every N turns, `@loom/agent`'s `continueEvery`) is what bounds the history.
- A refused send may keep being refused for up to 250 ms after the owner drains the backlog (the full
  verdict is cached per chain and head).
- A message whose owner never waits on its topic pins the stream: `send` refuses (`InboxFullError`) at
  `inboxMaxBacklog` unconsumed messages, or at `inboxMaxRetained` retained entries above the pin (see
  round 2, c).
- Each wake of a long-lived message loop re-runs the flow from the top and the park serializes a state
  that holds one answer per consumed message: turn n is O(n) until continue-as-new (R1b, ADR 0109)
  bounds the history. Measured below.
- A flow that awaits a non-`ctx` promise is invisible to quiescence (the existing determinism rule).
- A cross-process wake needs a `TimerStore` on the sender's runtime; without one only the same-process fast
  path and `recoverAbandoned`'s sweep wake a parked owner (a warning says so).

**Measurements** (`tools/bench-throughput`, `pnpm --filter @loom/bench-throughput bench:inbox`; Apple
silicon, local Postgres 17 over TCP; medians):

| | memory | Postgres |
|---|---|---|
| A. `send` vs stream length 0 / 1k / 5k / 10k / 20k | 26 / 18 / 17 / 17 / 17 us | 601 / 534 / 517 / 524 / 532 us |
| B. fold per `MESSAGE_CONSUMED`, 1k -> 64k events | 1.7 -> 2.75 us/event | (same code) |
| C. send + live consume, 500 -> 4 000 messages | 0.058 -> 0.057 ms/message | grows with the park's snapshot (see below) |
| D. wake per message, turn 50 / 200 / 400 | 0.12 / 0.82 / 1.73 ms | 2.7 / 3.2 / 3.75 ms |

A and B are flat: the send is `head()` plus one append and the fold keeps its cursor, dedupe window and
answer map in place. C is flat in memory (the live consume path is O(1) per message). Where the sender is
slower than the consumer the owner re-parks between messages, and each park snapshots a state that holds
every answer so far; on Postgres that snapshot (2-3 ms at 3 000 answers) is the whole growth in C, and it
is D's growth too. That is the O(n) turn R1b removes; it is not a property of the inbox.

**The load test** (`r2-load.test.ts`, the one D5.3 asks for): 10 000 sends to ONE parked chain from another
process wrote **one** timer row (a burst coalesces into the fixed-instant upsert); one `TimerService` tick
woke the owner, which then drained all 10 000 in order in about 0.8 s in memory (the sends themselves took
0.25-0.3 s, about 35 000/s); the consumed prefix was trimmed to 2 retained rows.

**Verification** (all in `packages/workflow-runtime/src/r2-*.test.ts`): send-before-receive and
receive-before-send each deliver once; a crash-point SWEEP kills the owner at every append of a
two-message conversation (atomic batch store; the inbox refuses any other), reboots a fresh runtime, drives
`TimerService` + `recoverAbandoned`, and requires both messages, once each, in order; explicit
interleavings for a send between the quiescence read and the park commit, between the park commit and the
second read, and from another process with an idle owner; two notifiers racing one park; a contended fence;
per-topic FIFO under concurrent senders (two runtimes racing the store's sequence uniqueness); `select`
with each arm winning and a stale arm refused; timer pinning under sibling traffic; ordinal shift ->
`FlowDivergenceError`; per-wait `viewDigest` and a signature for arm A refused at arm B; an unauthorized
send refused (strict) with the stream, the owner's log and the timer store untouched; tainted delivery;
bounds (send cost, trim below the oldest unconsumed message never touching the head, `InboxFullError`,
the stream deleted with its chain); a fork leaves the chain. The protocol tests run on memory and SQLite
and, with `LOOM_TEST_POSTGRES_URL`, on Postgres.

**Live `onEvent` order (review round 4).** An inbox delivery's batch (and a duplicate-only advance) fires `onEvent` only once it is durable, so a retried or lost batch is never shown to live subscribers. Because projections and the compliance subject index fold in sequence order, the journal holds every LATER envelope's `onEvent` behind a pending deferred batch and releases them in sequence order when it lands; a lost batch's envelopes are dropped and what queued behind it is delivered. With nothing deferred, `onEvent` stays synchronous, exactly as before.

## Amendment 2026-10-11 — erasure into the stream, an operator discard, and the per-topic design

- Status: **Accepted** (D8, D9, **D10a implemented**); **D10b (per-topic streams) is a design only** (not implemented in this section, see why below).
- Closes the logged follow-ups of the 2026-10-07 "Residuals" and "Pinned-stream DoS" bullets.
- **Wire and ABI: nothing changes.** `EVENT_SCHEMA` stays 1.23.0, `KERNEL_ABI` stays 1.3.0, the `EventStore` SPI is
  untouched, no fold handler changes, no syscall is added. `ExecutionOp` gains one additive member (`"discard"`),
  exactly as `"send"` and `"annotate"` did, and the conformance kit gains its case. `@loom/event-runtime` exports
  `INBOX_STREAM_PREFIX`, `inboxChainOf` and `chainIdOfFirst` (the stream's addressing, moved down so the crypto
  plugin and the compliance package can name it without depending on the runtime).
- **Consumers (ADR 0083, named).** The second-consumer rule gates *speculative surface*; these close known safety
  and operability gaps, and each has consumers that exist today: **D8** — any agent or conversation app with a
  hot topic and a cold one (a chat agent that receives `user-message` all day and is also addressed on a
  `telemetry` or `admin` topic it reads once), and the **operator of any deployment that uses the inbox** (the
  pin is otherwise cleared only by the owner finishing); **D9** — **GDPR/CCPA erasure for any app** that puts
  personal data in a message (every conversation or agent app does).

### D8 — a journaled, authorized operator discard (`runtime.discardInbox`)

`runtime.discardInbox(executionId, { topic, throughSeq, reason? }, { principal })` skips every unconsumed
message of ONE topic with `inboxSeq <= throughSeq`, and so releases a pinned stream.

- **A principal is REQUIRED, always.** A discard is an operator action that destroys messages a sender was told
  were accepted. The authorizer is consulted only for a call that carries a principal or runs under `strict`
  (`authzApplies`), so without this rule an anonymous call on a non-strict runtime skipped the policy and landed
  with an empty `sender` in the audit fact. `discardInbox` therefore refuses a principal-less call, whatever the
  policy or `strict`, with `ExecutionDeniedError` (`op: "discard"`) before anything is read (so it is no
  existence oracle either), and not even the kernel's system grant stands in for the operator.

- **The fact is `MESSAGE_CONSUMED`, not a new kind.** The fold already has exactly the semantics a discard needs:
  the cursor advances monotonically and the id joins the dedupe window. What it must NOT do is deliver, so the
  fact carries `payload: null` and the reserved `waitId` `__loom_discard__`: no `ctx` wait can carry that id
  (they are `<scopePath>#<ordinal>`), and the fold's first-answer-wins rule means a chain's log records ONE answer
  under it however many discards run (no unbounded state; pinned by a wire vector). The payload of the skipped
  messages is never copied into the log. Extra fields (`discarded: true`, `skipped`, `reason`) ride in the
  payload and the fold ignores them, so an older node folds the same log identically. A discard that skips
  messages journals one such fact PER skipped message (its own dedupe key, no payload) in a single atomic batch,
  the last carrying the whole discard (`inboxSeq: throughSeq`, `skipped`, `reason`); with nothing of the topic to
  skip, one fact under the hash of `["discard", topic, throughSeq]` advances the cursor. `through <= cursor`
  appends nothing, so a repeat is idempotent.
- **A discarded `messageId` resent is a duplicate.** Each skipped message's dedupe key enters the fold's
  dedupe window, so a sender that retries an id the operator discarded is accepted into the stream (it was
  appended) and then skipped as a duplicate by its owner instead of being delivered as a fresh message. The
  window is bounded (`INBOX_DEDUPE_CAP`, 1024 ids, shared with every consumed message): a discard of more than
  1024 messages remembers the NEWEST 1024, and a resend of an id that has since left the window is delivered as a
  new message, exactly as for a consumed one. `skipped` still counts them all.
- **A discard racing a delivery wins.** A notifier builds its `MESSAGE_CONSUMED` batch from the cursors it
  folded; a discard is an ignorable kind, so it lands under the park's fence without superseding that notifier,
  and the notifier's own fence acquisition only re-checks that the park is unanswered. The fold would accept a
  consumption at or below the cursor as an answer, delivering a message the operator discarded (and logging both
  facts). The runtime now judges the batch against the cursors of the VM it will run from, AFTER the fence is
  held, and refolds instead of writing it when any entry is at or below its topic's cursor
  (`staleInboxBatch`). This is a runtime-side guard on the delivery path only: **the fold is unchanged**, so
  existing logs replay identically (a log that already holds such a pair, written before this fix, still folds
  as it always did). Tested with a paused notifier on memory, SQLite and Postgres, parked fenced and unfenced.
- **Authorized as `ExecutionOp "discard"`**, against the recorded owner of the chain's head (resolved like
  `send`), before "not found" is revealed; a denial appends nothing (no `EXECUTION_DENIED`, as for `send`: an
  outsider never writes the owner's log). `executionAccessPolicy` maps it to **`"deny"`**: it destroys messages
  a sender was told were accepted, so the integrator opens it deliberately (`rules: { discard: "tenant" }` for
  a tenant's operators, `"any"` for a platform operator). `@loom/conversation` polices it with the other ops
  (owner or deny). The operator's identity subset is recorded as the fact's `sender`.
- **The owner must be parked.** The fact lands in the owner's OWN log, which only a parked owner accepts without
  racing its own appends (the race the separate stream exists to avoid). It is written by the existing
  duplicate-only path (`advanceInbox`): one atomic batch under the park's conditional fence (ADR 0118), an
  *ignorable* kind, so the park stays unanswered and a later delivery still resumes it. A running owner is
  `InboxDiscardRefusedError` `not-parked` (retryable); so is one that resumes while the call is in flight. A hot
  topic is not what pins the stream, so an owner that is busy on it parks again within a turn, and the retry
  lands (tested racing a live delivery). A finished owner is `InboxClosedError` (its stream is already gone).
- **Bounded to what exists.** `throughSeq` may not exceed the stream's head (a later message would take a skipped
  sequence and vanish), nor be negative or fractional; a bad or reserved topic and an over-long reason are
  refused (`invalid`, nothing appended). Other topics' messages are untouched (cursors are per topic).
- **It releases the pin.** After the fact is durable the runtime forgets its cached full-verdict and backlog
  count and forces a trim past the old floor, so the stream accepts sends again and the consumed prefix is
  reclaimed in the same call.
- **Rejected:** a discard that works on a running owner (an external append races its sequencer; routing it
  through the live in-process journal covers one process and misleads the rest); a new `INBOX_DISCARDED` kind
  (an `EVENT_SCHEMA` bump for a semantic `MESSAGE_CONSUMED` already has); deleting the entries from the stream
  directly (not journaled, so a replay and a second node disagree, and the store deletes only by prefix).

### D9 — erasure reaches payloads still in flight in the stream

The 2026-10-07 residual: erasure reached `MESSAGE_CONSUMED` in the owner's log but not an unconsumed message in
`__loom_inbox__:<chainId>`. Two halves, because neither alone is complete.

- **Cryptographic (the erasure itself).** `EncryptingEventStore` resolves a chain's inbox stream to the erasure
  subject of its OWNER: `subjectOf` is asked about the chain id, which is the generation-0 execution id (or a
  fork's fresh one). `defineConfig` registers `INBOX_MESSAGE: ["payload"]` when `security.crypto` and
  `kernel.features.inbox` are both on, so an in-flight payload is sealed at rest under the owner's key and
  `shredSubject` makes it unreadable. A read of an inbox stream **never throws** `PayloadShreddedError`
  (senders scan it for their backlog and the trim reads it; a destroyed key must not break `send` for the chain):
  a payload whose key is DESTROYED reads as the `{ $shredded: true }` marker, never as ciphertext and never as
  the raw value. Only a destroyed key maps to the marker: ciphertext that a key which EXISTS cannot open
  (corruption, a tampered row, a `subjectOf` that drifted since the stream was sealed) throws the typed
  `PayloadUndecryptableError`, so a defect cannot pass for an erasure (a `subjectOf` that drifts to a subject
  with no key still reads as erased: that is indistinguishable from a shred, so keep it stable). A `KeyStore`
  must never re-mint a destroyed subject's key. `subscribe` on an inbox stream hands the marker, not
  ciphertext, once the key is gone. `subjectOf` is asked with the OWNER's workflow id (read once from the
  owner's first event and cached), handed LAZILY: a `subjectOf` that reads it while it is unresolved (a transient read error, no log yet) makes the write THROW `OwnerUnresolvedError` (retryable), never a guessed `""`
  subject; the crypto layer also refuses `""` as a sealing subject. Never the stream's reserved
  `__loom_inbox__`. **The marker cannot be forged.** A flow tells "erased" from "sent" by the marker's shape,
  and the delivered envelope has no field a flow could check instead without an `EVENT_SCHEMA` change, so
  `runtime.send` refuses (`InboxMessageRefusedError`) a payload that IS the marker (a top-level
  `$shredded: true`); a look-alike (`{ $shredded: false }`, a nested one) is an ordinary payload. A consumer that reaches it delivers the marker (tainted like any
  delivery), journaled in `MESSAGE_CONSUMED` in the owner's log, so **a replay of that log is identical** and
  consults neither the stream nor the key. **The consumed copy is sealed too:** the same condition registers
  `MESSAGE_CONSUMED.payload`, so a consumed payload is not left in plaintext in the owner's log (new writes
  only; a log mixing old plaintext consumptions and new sealed ones reads and replays unchanged, and a `MESSAGE_CONSUMED.payload`
  that is exactly the marker is stored verbatim so a shredded owner can still journal the erasure; that
  exception is scoped to that one path, the same bytes on any other sensitive path are data and are sealed).
  **Not covered:** a snapshot's `variables._waitAnswers` holds an answered payload under a DYNAMIC key (the
  `waitId`), which a sensitive path (fixed keys and array elements) cannot name, so a snapshot taken while an
  answered wait is in the fold holds it verbatim unless the app's snapshot store seals the whole state. The
  topic, message id and sender are not sealed (routing and dedupe
  need them); the sender is the SENDER's identity, not the owner's, and declaring it sensitive is the app's
  choice. A `send` after the shred is refused by the key store (`InMemoryKeyStore` never recreates a destroyed
  key; a `KeyStore` must not, because a re-minted key would make the older payloads an undecryptable-key defect rather than an erasure).
- **Physical (the orphan).** `EraseCoordinator`, once the subject's executions are all terminal (its existing
  liveness gate, unchanged), deletes the inbox stream of every execution that is the HEAD of its chain
  (terminal and not `continued`, chain id read from the log with `chainIdOfFirst`, so a fork's own chain is
  found by its stamp). The runtime already deletes a finished chain's stream; this reaches the orphan a crash
  between a sender's append and its re-read leaves, which the sweep cannot map back to an owner for a fork's
  chain (13.f). The chains are resolved BEFORE the shred, because a decrypting store cannot read the logs
  afterwards. A store without `deleteExecution` skips this half; the key still erases the payload.
- **What stays true, exactly.** The coordinator's liveness gate treats every NON-TERMINAL execution as live, a
  `suspended` (parked) one included, so by default an erasure whose subject has a parked owner is DEFERRED
  (`parked`, naming it, durable as `ERASURE_PENDING`) and lands when that owner finishes. A chat agent parked
  forever on `receive` therefore blocks the coordinated erasure forever; the caller gets an honest `parked` +
  `pending`, never a silent success. The cryptographic half works on a parked owner when `shredSubject` is
  called directly (the tests do, parking the owner on a gate while the message is in flight).
- **Opt-in: `eraseSubject(subject, tenant, { parked: "shred" })`: leaves NO stuck owner (review round 2).** When
  every non-terminal execution is parked, the coordinator first CANCELS each one (`EraseCoordinatorOptions.cancel`,
  wired by `defineConfig` to `runtime.cancel(id, "erased", runtime.systemOptions())`: the runtime's own authority,
  the same fenced path a normal cancel takes, the reason journaled), then shreds, and reports the cancelled owners
  in `parkedShredded`. Every owner is therefore terminal and the terminal-head purge of the reserved inbox streams
  runs for them too, which also closes the plaintext-before-crypto edge below for those owners. A RUNNING owner still
  defers (its fold would read the key as it is destroyed, and the tombstone append races its sequencer); a cancel that
  fails, or an owner that woke up before the key was destroyed, defers the subject exactly as `"defer"` does (owners
  already cancelled stay cancelled). Without the `cancel` option the call throws. **An owner shredded some other way**
  (a direct `shredSubject`) can still be cancelled: `cancel` folds the REDACTED view that `PayloadShreddedError.redacted`
  carries (each sealed field `{ $shredded: true }`; status, tip and workflow id are plaintext), appends
  `EXECUTION_CANCELLED` under the fence and retires the inbox. `resume` and `loadState` remain strict and reject with
  the typed error, appending nothing (a resume off a redacted fold would diverge; the orchestration supervisor relies on
  `loadState` throwing so a shredded parent is not pinned). A compacted log whose checkpoint is sealed keeps the
  error. A deferred request completes only when every owner is terminal (the option is not stored with it); re-issue the
  call to shred once the running owner parks. Re-running the erasure over an already-shredded log is idempotent.
- **Migration edge: plaintext written before crypto was enabled survives a shred.** A decrypting read passes an
  unsealed payload through unchanged, so an inbox message appended (or a consumption journaled) before
  `security.crypto` was composed is plaintext, and destroying the key does not touch it. It is erased only by
  deleting the stream, which the coordinator does for a TERMINAL chain head. **Operator remedy:** before relying
  on the key for such a chain, cancel the owner and run the erasure (its stream is then deleted), or delete the
  stream yourself; there is no re-seal API, and the coordinator does not delete a PARKED owner's stream (the
  owner still reads it). The opt-in does not change this.

### D10 — per-topic streams with an optional journaled TTL (D10a implemented; D10b a design, not built)

**Not built, and why.** It needs no `EVENT_SCHEMA` or `KERNEL_ABI` change and can keep existing data readable
(below), so the gate is not the ABI. It is not built here because it rewrites the stream layout across at least
ten sites in four packages (the sender's allocation, the default `InboxSource`, the notify scan, the trim, the
backlog accounting, the reclaim sweep and the delete-with-chain, fork and re-open floor seeding, the
`@loom/conversation` `inboxBargeIn` subscription, the erasure purge of D9, the load test and the bench) and adds a
reserved-id rule and a fleet flag; that wants its own review round, and D8 already closes the *operational* hole
(an operator can release a pin) while D10 only removes the *need* to. Recommended order when a workload asks:
D10a first (cheap, no layout change), D10b only if hot/cold traffic is routine rather than exceptional.

**D10a — journaled TTL expiry on today's layout.** `kernel.inbox.messageTtlMs` (off by default). A sweep
(`recoverAbandoned`, already enumerating reserved streams) finds a chain whose stream is *pinned* (retained
entries above the oldest unconsumed message past half of `inboxMaxRetained`, the condition that already warns)
whose pinning message is older than the TTL, and discards as a kernel service principal with `reason: "ttl"` (a discard needs a principal; the system grant alone no longer suffices, D8, so D10a must define that principal).
Pinned-only, so a slow but healthy consumer is never expired merely for being slow; journaled, so it replays;
parked-only, so it retries on the next sweep. The message's age is its envelope timestamp.

### D10a — implemented: journaled TTL expiry on today's layout

`kernel.inbox.messageTtlMs` (`WorkflowRuntimeDeps.inboxMessageTtlMs`): a number (every topic) or
`{ default?, topics? }` (per topic, own-property lookup). **Off by default**: with it unset no row is written,
`expireInbox` answers `"off"`, `TimerService` and `recoverAbandoned` take no new branch, and behaviour is
byte-identical. A TTL that is not an integer of at least `MIN_INBOX_TTL_MS` (60 000 ms, the floor, like ADR 0055's
`MIN_ORPHAN_ERASE_MARGIN_MS`) is refused at composition (and so at `defineConfig`). **Wire and ABI: the log and the fold
are unchanged** (`EVENT_SCHEMA` 1.23.0, `KERNEL_ABI` 1.3.0, no fold handler). The only SPI change is the review-round
clock fix below: an OPTIONAL `EventStore.storeNow()` (EventStore SPI 2.3.0 to 2.4.0, additive).

- **The fact is D8's.** An expiry is `MESSAGE_CONSUMED` under the reserved `__loom_discard__` wait, `payload: null`,
  one per skipped message (its id joins the dedupe window, so a sender's retry of an expired id is a duplicate),
  the last of each topic carrying `inboxSeq: <through>`, `skipped`, `reason: "expired"` and `expired: true`. The
  fold ignores the extras, so an older node folds the same log identically and a replay needs neither the clock
  nor the stream (tested: a fresh runtime folds the identical `_inbox` and `_waitAnswers`).
- **Authorized as the runtime, not an operator.** An expiry is the kernel acting on configuration the integrator
  wrote, so it takes no principal and no `ExecutionOp` (D8's operator rule stays: `discardInbox` still requires a
  principal). The fact's `sender` is `{ actor: "__loom_inbox_ttl__" }` (`INBOX_TTL_ACTOR`), which no operator
  identity can be mistaken for in an audit.
- **Driven by the durable timer service, never the fold.** `send` of a topic with a TTL writes one `TimerStore` row
  at `ceil((now + ttl) / 1000) * 1000` (whole seconds, so messages expiring together share a pass), coalesced per
  chain while a pending one is known (a per-process map, so N nodes may each write one row; harmless, every pass
  is idempotent and retires its own row). `TimerService.fire` treats a row that is no timer of the park as an
  expiry row when a TTL is configured and calls `runtime.expireInbox`; `done`/`closed` retire it. A `not-parked`/
  `contended` pass (a running owner) with an unconsumed TTL'd message still PENDING re-arms DURABLY: the next row
  is written at a later instant (in-process exponential backoff, capped like a re-drive, never reported as
  exhausted: a long turn is not a failure) and only then is this one retired. Review fix (P1): the first cut
  kept the row in place, so it stayed at the head of `TimerStore.due()` (oldest first) and a batch of busy-owner
  rows starved every real timer behind it. A row with nothing TTL'd pending (an obsolete plain-timer row of an
  owner that is now running) takes the ordinary path and is retired. Review fix (P3-1): an expiry row and a real
  timer on the SAME instant are one row (`(executionId, wakeAt)`, expiry rows on whole seconds, as is
  `ctx.sleepUntil(W)`), so a fired timer also runs the pass for its chain before the row is retired. The age is
  `envelope.timestamp + ttl <= now` evaluated in the pass; the fold reads no clock. Each pass re-arms the next (the earliest still-unexpired message,
  or "now" when it was cut short). `recoverAbandoned` runs one pass per inbox stream as the safety net for a row a
  crashed sender never wrote (`summary.inboxExpired`; a fork's chain, which maps to no execution, is skipped).
- **No race with a delivery.** The pass journals through `advanceInbox`: one atomic batch under the park's
  conditional fence, an *ignorable* kind, so the park stays unanswered. A notifier whose batch was built from the
  pre-expiry cursors is refused by `staleInboxBatch` (D8's guard) and refolds; a delivery that won first has
  consumed the message and leaves nothing to expire. So an expired message is never delivered after its fact is
  durable, and never twice. A message consumed before its pass ran was simply delivered in time (a TTL is a bound
  on how long a message may wait, not a promise the flow never sees an old one: the live consume path inside a
  running owner does not consult the clock).
- **Only a prefix per topic.** A discard advances a topic's cursor THROUGH a sequence, so a pass reports, per topic,
  the unconsumed messages up to the first unexpired one (a younger message is never dropped ahead of an older one,
  even with sender clock skew). A topic with no TTL is never touched. **Head of line (stated):** a young message, or
  one stamped by a fast sender clock (see below), at a topic's head holds every older-than-TTL message behind it
  back, so a pin can outlive the TTL by up to the skew of that one stamp.
- **One clock for the age (review P2).** The envelope timestamp is whatever clock the SENDER stamped, and the judge
  may be another node, so with per-node wall clocks a sender 10 minutes behind got a fresh message expired on the
  first pass (silent loss). When the event store has `storeNow()` (EventStore SPI 2.4.0, optional, the twin of
  `LeaseStore.storeNow()`, L29; Postgres reports DATABASE time) the sender stamps the inbox envelope with it and the
  pass judges against it, so every node ages a message on one clock. A single-process store (memory, SQLite) has one
  clock anyway and the runtime's injected clock is used. A store WITHOUT `storeNow` shared by several nodes has no
  common clock: the TTL must then be much larger than the fleet's clock skew (the 60 s floor is a minimum, not a
  recommendation), and a stamp ahead of the judge (`timestamp > now`) is treated as suspect: it is never expired
  until the judge's clock has passed `timestamp + ttl`, so a fast sender can delay an expiry but never cause an
  early one, and it is not young forever. Messages stamped before a node enabled the TTL carry that node's runtime
  clock (the sender stamps with the store clock only while a TTL is configured).
  Timer rows stay on the runtime clock; the judge's remaining wait is carried over as a delay, so a host whose clock
  differs from the store's still wakes the next pass at the right moment.
- **Bounded per wake.** At most 1 024 messages (`INBOX_DEDUPE_CAP`'s size) are discarded per pass in one batch;
  when more are due the next pass is armed for the very next second. The scan reads the retained stream above the
  known consumed floor, which `inboxMaxRetained` bounds.
- **It releases the pin.** After the fact the runtime forgets its cached verdicts and forces the trim (as D8), so a
  cold topic's expired message stops pinning the hot topic and `send` is accepted again.
- **Parked only.** Like D8 the fact lands in the owner's own log, so a running owner answers `not-parked` and the row
  waits. Pinning does not need to be proven first (the original sketch expired only a pinned stream): the integrator
  opted a topic into a TTL, and a healthy consumer drains a message long before it expires.
- **Deviation from the sketch, stated.** The sketch had `recoverAbandoned` find the pinned stream. A sweep alone
  would expire late and only when someone runs it; the timer row makes expiry timely and the sweep a safety net.
- **Fleet / rollout.** A node without the TTL configured (or with the inbox off) retires an expiry row as obsolete
  (it cannot tell it from a stale timer), and expiry is then lost until a `recoverAbandoned` sweep re-arms it: enable
  the TTL on EVERY node before relying on it. With no `TimerStore` a warning says expiry then happens only on a sweep.

Tests (`r2-ttl.test.ts`, memory, SQLite, Postgres, injected clocks, no sleeps): expiry discards, journals and
replays identically and never resumes the owner; TTL off writes no row and delivers the old message; a cold topic's
expired message stops pinning the hot topic (`InboxFullError` before, accepted after); a notifier paused after its
scan loses to the expiry (the expired message is never delivered, the log never records a consumption below an
advanced cursor); a delivery that won leaves nothing to expire; a running owner keeps the row and the discard lands
once it parks; a pass is bounded (1 024, then the rest); only a topic with a TTL expires; a bad TTL is refused.
`inboxConfig.test.ts` (app): the setting reaches the runtime. Each was revert-checked (no stale-batch guard, no
journaling, no `TimerService` branch, a default TTL when unset).

**D10b — per-topic streams.** Layout: `__loom_inbox__:<chainId>#<h>` with `h` the first 16 hex chars of
`sha256(topic)`; the legacy `__loom_inbox__:<chainId>` stream stays and is read first.

- **One cursor space, no fold change.** Today `cursors[topic]` is a sequence in the chain's single stream. A topic
  stream is seeded (`ensureInboxFloor`, the fork mechanism) at the legacy stream's head at its first send, so
  its sequences start above every legacy one; the folded cursor stays one monotone number that is valid in
  either stream. A topic's reader drains the legacy messages of that topic past its cursor, then the topic
  stream. Existing data is read where it lies; nothing is copied or rewritten.
- **Per-topic bounds.** `inboxMaxBacklog` and `inboxMaxRetained` apply per topic stream, so the pin and
  `InboxFullError` are per topic (the hot topic is never refused for the cold one's sake), and trim reads one
  cursor per stream instead of the minimum across topics. Topic cardinality becomes a resource: a new
  `inboxMaxTopics` (default 64) per chain, counted from a registry entry (below), refuses the 65th topic.
- **Enumeration.** Streams are found by name only through the optional `listExecutionsPage`, so the chain keeps
  a registry: the first send of a topic appends an `INBOX_TOPIC` marker (not a message, never delivered) to the legacy
  stream, and the owner's cursors name every topic it ever consumed. Retirement deletes the legacy
  stream, every registered topic stream and (as the sweep's catch-all) any `#`-suffixed stream whose chain is
  terminal.
- **Reserved ids.** A caller-chosen execution id ending in `#` plus 16 hex digits would alias a topic stream of
  another chain, so it is refused at `start` (as the `<x>~<digits>` successor shape already is).
- **Continue-as-new, fork, re-open.** Cursors (one space) and the dedupe window carry unchanged, so a
  continuation needs nothing. A fork and a re-open seed each topic stream's floor from the inherited cursor, as
  they seed the legacy stream today.
- **Timers.** The due-now row is per execution and unchanged; the notify scan reads only the streams of the
  topics the park waits on, so it gets cheaper, not different.
- **Rolling upgrade.** A pre-D10 node writes only the legacy stream, so a fleet flag
  (`kernel.features.inboxTopicStreams`, off until every node reads topic streams) gates the writer; readers
  always read both.
- **Erasure.** D9's purge and its subject mapping take the topic stream's chain from the part before `#`; the
  registry makes the purge enumerable.

### Tests (this amendment)

`r2-erasure.test.ts` (memory, SQLite, Postgres): an in-flight payload is sealed at rest and absent from every raw
row after the shred; a consume after the erasure delivers the marker, journaled once, and a fresh runtime folds the
identical answer; a `send` after the erasure is refused and appends nothing; another subject's payload is intact.
`inboxStream.test.ts` (crypto): the owner's subject, the marker in `throw` mode through `read`, `readFrom` and
`readRange`, a key that exists but cannot open the ciphertext (and a tampered row) throws `PayloadUndecryptableError`, `subscribe` hands the marker, `subjectOf` gets the owner's workflow id (lazily; unresolved throws), a marker-only `MESSAGE_CONSUMED` record needs no key, every other stream still throws. `eraseSubject.test.ts` (compliance): the orphan
stream is deleted after the shred and chains are resolved before it, a fork's chain by its stamp, a later
generation by its start, a `continued` execution never purges, another subject's stream is untouched, a parked
erasure purges on completion, a store that cannot delete is a no-op. `r2-discard.test.ts` (memory, SQLite,
Postgres): the pin is released and the consumed prefix trimmed; the fact is kernel-stamped, carries no payload and
replays; the discarded message is never delivered and the next is; other topics and the park are untouched;
idempotent; one answer entry however many discards; a running owner refused with nothing appended; invalid
bounds refused and the next message not swallowed; a finished owner is `InboxClosedError`; closed by default, opened
per tenant, the operator recorded, existence not an oracle; a discard racing a live delivery lands on retry. `r2-discardRace.test.ts` (memory, SQLite, Postgres, fenced and unfenced park): a notifier paused after its scan loses to a discard (the discarded message is never delivered, the reported count is accurate, no consumption below the cursor is ever recorded as an answer); a discarded `messageId` resent is a duplicate. `r2-discard.test.ts` also pins the principal-less refusal. `r2-erasure.test.ts` adds the sealed consumed copy, a mixed plaintext/sealed log, the unforgeable marker and a shredded parked owner (resume and `loadState` typed `PayloadShreddedError`, `cancel` still terminal, on memory, SQLite and Postgres); `eraseSubject.test.ts` the opt-in `parked: "shred"` (cancel-then-shred order, deferral on a failed cancel); `inboxStream.test.ts` the marker scoped to `MESSAGE_CONSUMED.payload`, the unresolved-owner failure and the refused `""` subject. A wire
vector pins the fold. Each was revert-checked: undoing the change fails the test that names it, and restoring it passes.

