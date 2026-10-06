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
4. **The due-now row has a fixed `wakeAt` (`INBOX_WAKE_AT = 0`).** The store's upsert per
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
    so inbox rows (instant 0, sorted first) cannot fill its batch and starve real timers. A timed park at
    exactly instant 0 is not fired by a flag-off node. (e) **A terminal execution stays terminal for
    senders, but `resume` / `resumeAs` CAN re-open a failed or completed one (ADR 0104).** Its stream was
    deleted when it finished, so a message not consumed by then is gone, and a re-opened execution would
    restart allocation at sequence 0 under the cursors its log still holds (every new message skipped).
    Re-open therefore seeds the allocation floor at the highest cursor (as for a fork) before the run
    starts. Unconsumed messages at the moment of the terminal are discarded, by design. (f) An inbox stream
    whose owner is terminal and whose id maps to an execution (`recoverAbandoned` enumerates reserved
    streams) is reclaimed by the sweep (`inboxReclaimed`): the orphan a crash between a sender's append and
    its re-read leaves. A fork's chain id is not an execution id, so a crash orphan of a fork chain is not
    swept (the normal terminal path still deletes it). (g) **The notify path answers under a conditional
    fence only when the park was written under a token.** A fencing store refuses an append with NO token
    once any token exists, so acquiring one on the first inbox delivery of a never-fenced deployment made
    every later plain `resume` / `resumeAs` / recovery of that execution fail as a stale fence (found by
    the re-open test). Unfenced, a rival notifier loses at the `(executionId, sequence)` uniqueness of the
    atomic batch. The dedupe key is a fixed-size hash (see D6).

**Residuals (documented, not closed).**
- A message consumed for a branch that is then aborted by a sibling's failure is consumed: it is recorded
  in the log and the flow never sees it (the same as a gate answer in an aborted scope).
- The inbox stream holds payloads until they are consumed and trimmed or the head turns terminal (the
  stream is deleted then). **`eraseSubject` does not reach payloads still in flight in the stream**: erasure
  reaches `MESSAGE_CONSUMED` in the owner's log (`PAYLOAD_SHREDDED`), not the stream. Follow-up: extend
  erasure into reserved streams.
- **The park-per-message loop is quadratic until R1b.** A slow-sender loop re-parks between messages and
  every park snapshots (and every wake re-runs) a state holding one answer per consumed message: turn n is
  O(n), the whole conversation O(n^2). The inbox itself is flat (measured below); continue-as-new (R1b,
  ADR 0109) is what bounds the history.
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
