# ADR 0110 — A durable inbox, `ctx.receive` and `ctx.select`, and concurrent waits

- Status: **Proposed** (2026-10-05)
- Date: 2026-10-05
- Closes: R2 (agentic-readiness audit, kernel appendix §2d/§2e, gap 2)
- Builds on: [ADR 0057](0057-multi-gate-suspend-passthrough.md) (gate *i* receives the *i*-th
  recorded resume payload), [ADR 0077](0077-typed-resume-payloads.md), [ADR 0104](0104-recovery-never-answers-a-gate.md)
  (every `_resumePayloads` entry answers exactly one suspend point),
  [ADR 0117](0117-approvals-bound-to-what-the-approver-saw.md) (`viewDigest`, `locatePark`),
  [ADR 0112](0112-structured-concurrency.md) (scope identity, which keys a wait),
  [ADR 0109](0109-bounded-history-and-continue-as-new.md) (the chain the inbox is keyed by).
- Placement: **split.** Kernel: `ctx.receive` / `ctx.select`, the `MESSAGE_CONSUMED` fact, the
  multi-wait park condition, a reader seam. **1P** (new `@loom/inbox`): the inbox stream, `send`,
  routing by logical name, pub/sub, fan-in. Shares the Wave 2 bump (KERNEL_ABI 1.3.0,
  EVENT_SCHEMA 1.23.0).

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

### D1 — The inbox is a separate stream; the owner PULLS and journals

Messages are appended to a reserved control stream `__loom_inbox__:<chainId>` (ADR 0109: keyed by
chain, so it survives a continuation) by `send(chainId, { topic, payload, messageId })` in
`@loom/inbox` (1P). A sender never touches the execution's own log, so there is no sequence race
with the owner; two senders racing on the inbox stream retry on `DuplicateSequenceError` like any
writer. The kernel defines the reader seam only:

```ts
interface InboxSource {
  read(chainId: string, topic: string, afterSeq: number, limit: number): Promise<InboxMessage[]>;
}
```

passed as `WorkflowRuntimeDeps.inbox`. `@loom/inbox` implements it over any `EventStore`. The seam
is a function type, not a versioned SPI, until a second implementation exists.

### D2 — `ctx.receive(topic)` and `ctx.select(arms)`

`ctx.receive(topic, opts?)` is `select([{ inbox: topic }])` returning the payload. `ctx.select`
awaits the first of several arms:

```ts
const r = await ctx.select([
  { gate: "Approval", viewDigest },        // a resume answers it (ADR 0117 binding preserved)
  { inbox: "user-message" },               // the next message on this topic
  { timer: { afterMs: 3_600_000 } },       // or { at: epochMs }; the wake is recorded once (T1)
]);
// r = { arm: 1, kind: "inbox", value: ... }
```

Unlike `suspend`, these are *registering* waits: they return a pending promise and record the wait
with the current scope. The runtime parks the execution when the flow is **quiescent** — no step
in flight and every live branch blocked on a wait — which is what makes `Promise.all([receive(A),
receive(B)])` and a `select` inside a `parallel` branch (ADR 0112) park once with every wait
recorded. `ctx.suspend` is unchanged (throwing, single-wait, positional) and stays the legacy
syscall; nothing about a flow that does not use the new calls changes.

### D3 — A wait has an identity: `waitId = <scopePath>#<ordinal>`

ADR 0112 gives every `parallel` branch a deterministic `scopePath` (`"0/2"`: branch 2 of the scope
at branch 0 of the root). A wait's id is its scope path plus its ordinal within that scope, a pure
function of the flow's control flow and so stable across re-runs. Answers are keyed by `waitId`:
`EXECUTION_RESUMED` gains an additive optional `waitId`, and the fold keeps a fold-owned map
`_waitAnswers: { [waitId]: payload }`. The positional `_resumePayloads` list remains for
`ctx.suspend`; the two mechanisms do not share entries (the ADR 0104 invariant holds per
mechanism).

### D4 — The park condition lists every wait

`EXECUTION_SUSPENDED.condition` gains `waits?: Wait[]`, each `{ waitId, kind: "gate" | "inbox" |
"timer", on?, topic?, viewDigest?, correlationKey?, wakeAt? }`. The legacy fields (`on`, `wakeAt`,
`viewDigest`, `correlationKey`) are still written for a single-gate park, byte-identically, so an
older reader and `locatePark` are unaffected. `assertResumable` accepts a resume whose event name
matches **some** gate wait; with `waitId` it checks that wait's `viewDigest` (R13 preserved
per-wait); without one it refuses as `ambiguous-wait` when more than one gate wait matches the
name. A `select` is settled by its FIRST answered arm: the answer is journaled with its `waitId`,
and a later answer to a sibling arm of the same `select` is refused (`wait-settled`). Timer arms
get one `TimerStore` row each; a stale fire for a settled arm is refused the same way.

### D5 — Consumption is a journaled fact: `MESSAGE_CONSUMED`

When a `receive` / inbox arm is satisfied, the owner appends `MESSAGE_CONSUMED { waitId, topic,
messageId, inboxSeq, payload }` to its OWN log (payload copied in: the execution's log must be
self-contained for replay, independent of inbox retention). The fold keeps a per-topic cursor
(`_inbox.cursors[topic] = inboxSeq`) and the delivered payload under `_waitAnswers[waitId]`. Replay
serves the answer from the fold and never reads the inbox. Delivery is **FIFO per topic**;
selection is by topic only (no content predicates: they would be non-deterministic to re-evaluate
and unboundedly expensive to scan).

A parked execution is woken by `runtime.notifyInbox(chainId)` (the `@loom/inbox` `send` calls it
when the sender shares the process; otherwise a `TimerService`-style poller or any node's
`recover` sweep does): it re-reads the park, reads the source past each cursor, and if an inbox arm
can be satisfied performs an ordinary fenced resume carrying `MESSAGE_CONSUMED`. Exactly-once
consumption is a property of the owner's log (CAS on sequence), not of the stream.

### D6 — Bounded dedupe

Senders retry, so `messageId` is the idempotency key. The fold keeps the last
`inboxDedupeWindow` (default 1024) consumed message ids; a duplicate inside the window is skipped
(its cursor advances without a consumption). A duplicate beyond the window is delivered. This is the
documented contract: *at-least-once send, exactly-once consumption within the window*. The
alternative — an `EventStore.appendIfAbsent(id)` SPI method — is an open question (design document,
question 4), because it would make duplicates impossible at the cost of an SPI MINOR and a
conformance case.

### D7 — What stays 1P (`@loom/inbox`)

The stream, `send`, the sender-side idempotency helper, **routing by logical name** (name → chain),
pub/sub topics fanned out to several chains, dead-lettering, and the A2A / `@loom/orchestration`
adapters that today do this over `resume`. `runtime.resume` keeps its meaning (answer a parked
gate); the "message while busy" case becomes `send`.

## Replay and migration

All new fold keys are absent in an existing log, so every existing log replays byte-identically. An
in-flight execution that parks with `ctx.suspend` keeps today's single-wait condition. The new
calls are available only on 1.23.0 nodes (feature flag `kernel.features.inbox`, off until the fleet
is upgraded). An execution that has ever parked with `waits` cannot be driven by an older node (its
fold ignores `waits` and `MESSAGE_CONSUMED`): that is the same one-way door as any additive-kind
schema bump, and the flag is the guard.

## Tests

`exp2.cjs` inverted (message during a busy step is delivered; two parallel receives park once with
two waits; answers consumed out of order land on the right wait); a `select` of gate+timer+inbox
with each arm winning in turn, and a stale answer to a losing arm refused; DST: crash between inbox
append and `MESSAGE_CONSUMED`, between `MESSAGE_CONSUMED` and the next park, duplicate send;
ADR 0117 `viewDigest` still refuses a stale approval on a gate arm; per-topic FIFO under
concurrent senders; negative: topic with `__loom_` prefix refused, payload over the inline cap
refused at `send`.

## Rejected

- **Making `resume` legal while running** (buffer it in the execution's own log): the external
  append races the owner's sequence, and the positional passthrough would misalign.
- **Content-predicate selective receive** (Erlang-style `receive` with patterns): non-deterministic
  on re-evaluation and a scan per call.
- **An inbox inside `@loom/orchestration`**: orchestration is parent/child; an inbox is the
  addressing primitive for every pair of parties.
