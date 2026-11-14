# @loomwork/scheduler — ephemeral cooperative scheduler

An in-process scheduler for live async work: priority ordering, a concurrency cap and `AbortSignal`
cancellation. It decides which queued task takes a free slot, how many run at once, and how cancellation
reaches them. It is deliberately not durable. Pausing and resuming across restarts belongs to the event log
and `@loomwork/replay-vm`, and cron or timer-based starts belong to `schedule$`; nothing here is persisted.
Use it to bound fan-out of model or tool calls and to let background work (planning) yield to foreground
work (a user's turn). `IntentRuntime` and `PlannerRuntime` accept an optional shared `scheduler` and run
their model call at `Priority.Idle`.

```ts
import { Priority, createScheduler, parallelLimit, withTimeout } from "@loomwork/scheduler";

const scheduler = createScheduler({ concurrency: 1 });
const controller = new AbortController();

// One slot. `first` starts at once; `plan` and `turn` queue behind it, and `turn` starts before `plan`.
const first = scheduler.schedule(async (signal) => work(signal));
const plan = scheduler.schedule(async (signal) => work(signal), {
  priority: Priority.Idle,
  signal: controller.signal, // aborting this rejects it, even while it is still queued
  label: "plan",
});
const turn = scheduler.schedule(async (signal) => work(signal), {
  priority: Priority.UserBlocking,
  label: "turn",
});
await Promise.all([first, plan, turn]);

// Bounded fan-out; results[i] belongs to tasks[i] whatever order the tasks finish in.
const results = await parallelLimit(
  [1, 2, 3, 4].map((n) => async () => n * 2),
  { limit: 2 }
);

// A deadline that also follows a parent signal. Dispose it when the work settles.
const { signal, dispose } = withTimeout(5_000, controller.signal);
try {
  await work(signal);
} finally {
  dispose();
}

async function work(_signal: AbortSignal): Promise<string> {
  return "ok";
}
```

## Surface

- **Scheduler.** `createScheduler({ concurrency?, onEvent? })` returns a `Scheduler` with `schedule(task,
  { priority?, signal?, label? })`, `inFlight` and `pending`. `onEvent` receives `scheduled`, `started` and
  `settled` events for telemetry.
- **Priority.** `Priority.Immediate` (0), `UserBlocking` (1), `Normal` (2, the default), `Idle` (3). Lower
  is more urgent; ties run in arrival order.
- **Structured concurrency.** `parallelLimit(tasks, { limit?, signal?, failFast? })`.
- **Signals.** `withTimeout(ms, parent?)`, `linkSignals`, `signalReason`, `throwIfAborted`, `NEVER_SIGNAL`.
- **`yieldControl()`.** A macrotask yield for CPU-bound loops.

## Behaviour that surprises people

- **The default is no gating at all.** `concurrency` defaults to `Infinity`, and then `schedule` just calls
  your task: priorities have no effect, nothing queues, and `inFlight` and `pending` read 0. Priority only
  matters once you set a finite cap.
- **Priority orders the queue; it does not preempt.** A running task is never interrupted, and there is no
  time slicing.
- **`parallelLimit` preserves input order** and fails fast by default: the first rejection aborts the
  signal handed to the other tasks and rejects. A task that ignores its signal keeps running. With
  `failFast: false` every task settles and the first error by input order is thrown. A `limit` of 0 or
  less means unbounded.
- **`withTimeout` needs `dispose()`.** It releases the timer and the parent listener; the timer is
  unref'd, so it does not keep the process alive.
- **Do not persist scheduler state.** It is process-local by design.

## Install

`npm install @loomwork/scheduler` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/scheduler` — ephemeral cooperative scheduler" in [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [architecture, compute and distribution](../../docs/architecture.md); for per-tenant fairness see `@loomwork/fair-scheduler` ([ADR 0038](../../docs/adr/0038-per-tenant-fair-scheduler.md)).
- Source: `packages/scheduler/src`. Used by [`@loomwork/graph-executor`](../graph-executor/README.md).
