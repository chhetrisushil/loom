# ADR 0147 — `onDurableEvent`: an observer that only reports what the log holds

- Status: **Accepted** (2026-11-07)
- Date: 2026-11-07
- Builds on: [ADR 0110](0110-durable-inbox-and-receive-select.md) (`onEvent` delivery order),
  [ADR 0103](0103-durable-bootstrap-for-caller-chosen-ids.md) (`onEvent` stays ahead of the durable write)
- Placement: **kernel, additive.** One optional callback through `ExecutionJournal`, `WorkflowRuntime` and `defineConfig`.
  `KERNEL_ABI`, `EVENT_SCHEMA` and every store SPI are unchanged.

## Context

`onEvent` fires as an event is folded, before its durable write, so it can report events that never happened. Measured
with a real process and a real SQLite file:

```text
Process dies before the STEP_COMPLETED write lands, then a second process recovers
LIVE     0 STARTED  1 STEP_STARTED  2 STEP_COMPLETED  2 RECOVERED  3 EFFECT_INDOUBT  4 SUSPENDED
DURABLE  0 STARTED  1 STEP_STARTED                    2 RECOVERED  3 EFFECT_INDOUBT  4 SUSPENDED

The STEP_COMPLETED write rejects
LIVE     0 STARTED  1 STEP_STARTED  2 STEP_COMPLETED  3 EXECUTION_COMPLETED
DURABLE  0 STARTED  1 STEP_STARTED
```

Anything that alerts, bills or reports from that stream can act on something false. The envelope `id` is
`${executionId}-${sequence}` and a lost write's sequence is reused, so nothing on the event reveals it.

`crashingEventStore` cannot show this: it swallows a write and resolves as if it had succeeded, so the journal cannot tell.
A test of this property needs a write that rejects or never resolves.

## Decision

**Add `observability.onDurableEvent`, fired from the journal's serial write chain once an event's write has resolved.**
`onEvent` does not change. Runtime paths that append outside a journal call it after their own write.

The contract:

- **Never false.** A lost, rejected or fenced write is not delivered, and neither is anything after it.
- **Only this runtime's writes.** Another process's writes, and maintenance paths that write directly, are not reported:
  `LogLifecycle.restoreTerminalEvent` and `rehomeExecution`, crypto-shredding, and the CLI's own runtime.
- **At most once.** A process that dies just after a write, or a write whose acknowledgement is lost, never delivers that
  event. A throwing `onEvent` during a fork's prefix copy also stops the rest of that prefix being delivered, because the
  throw ends the loop. Only the log is complete. "Durable" means what the store's `append` promises: SQLite in WAL mode with
  `synchronous = NORMAL` survives a process crash, but can lose its last commits on power loss.
- **In order per writer, not per execution.** A later journal or direct append only needs the previous event to be visible
  in the log, so under a delayed acknowledgement a later sequence can arrive first. A consumer that cares orders by
  `sequence`.
- **Asynchronous.** Delivery lags the fold by the write, and a store slower than the event rate builds a backlog. Journal
  barriers wait for the synchronous call, because it runs on the write chain, so a slow consumer delays the next write and
  should stay small. `cancel` rejects completion without draining, so `CANCELLED` can arrive after that rejection.
- **Isolated.** A throw or a rejected promise never reaches the run and never reads as a lost write. It is reported through
  `onWarn`, at most once a minute, so a broken consumer is not silent. An async consumer is not awaited, so it gets no
  backpressure or ordering.
- **Free when unset.** The write path only checks that the callback is absent. When set, each write gains one promise
  step, which can shift a write by a few microtasks on a store that resolves without I/O.

## Why not change `onEvent` itself

That was tried first, moving every `onEvent` delivery after the write. It did what it set out to do, and run throughput was
flat (median 5,260 vs 5,383 executions/s on Postgres). An adversarial review then reproduced these regressions by running
the code:

1. **A parent run can hang until the next `recover()`.** The supervisor relied on commit order across journals. If a child's
   `EXECUTION_CONTINUED` write is slower than its successor's terminal write, nothing settles the parent: 20 of 40 runs with
   1 to 5 ms write delays and instant reads, though none on real local Postgres.
2. **A throwing projection hid a run from compliance.** With throws isolated, one projection throw skipped the subject index,
   so the run completed and `eraseSubject` returned `unknown`. Before, the run failed.
3. **Erasure could miss a live run.** The subject index needs to know a run straight away. Fed after the write,
   `eraseSubject` right after `start` returned `unknown` where it used to park.
4. **Events could arrive out of order,** and a folded read model without a live source then throws `FoldGapError`.
5. **Surfaces would lag behind the store.** Measured from `ctx.stream` to delivery at 200 tokens/s: 1.1 ms p50 on loopback
   Postgres, but up to 4.6 s on a simulated 20 ms store.

These consumers need commit order and immediacy more than they need truth. Those that need truth can now opt in, and this
callback can have the ordering and lag limits above because nothing in the kernel depends on it.

## Consequences

- `onEvent` can still report a false event, so a surface built on it can still show a phantom. Its docs now say so and point
  here. A later decision could still move surfaces onto this callback, one consumer at a time.
- Consumers now choose between two callbacks: `onEvent` for immediacy and `onDurableEvent` for truth.
- A crash can leave a visible gap, such as a step that started and never finished. That is a missing report and not a false
  one, and the log stays complete.

## Alternatives rejected

- **Move `onEvent` after the write, and fix each dependent.** It needs at least the subject index fed from the fold,
  per-consumer isolation, supervisor reconciliation and per-execution ordering, in the kernel, with slow-store behaviour that
  has little test coverage. A later ADR can revisit this if one truthful stream becomes worth that cost.
- **Document `onEvent` as unreliable and stop.** It leaves no way to get a truthful live stream short of reading the log.
- **Hold back a per-execution delivery queue so this callback is in sequence order.** It adds per-event work and a stall when
  a predecessor's write never settles, to serve consumers that can order by `sequence` themselves.
