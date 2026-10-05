# ADR 0110 — A durable inbox, `ctx.receive` and `ctx.select`, and concurrent waits

- Status: **Proposed** (2026-10-05) — design approved after 4 review rounds; Accepted per item at implementation
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
   two rows; the second fire is a no-op under the fenced resume). The R2 implementation plan **must include
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

### D6 — Bounded dedupe, carried across continuation

Senders retry, so `messageId` is the idempotency key. The fold keeps the last `inboxDedupeWindow` (default
1,024, configurable) consumed message ids; a duplicate inside the window is skipped (its cursor advances
without a consumption); one beyond the window is delivered. The contract: *at-least-once send,
exactly-once consumption within the window*. The window **travels across a continuation**
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
