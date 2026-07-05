import { Priority } from "./priority";
import { NEVER_SIGNAL, signalReason } from "./signals";

// ── Scheduler ─────────────────────────────────────────────────────────────────
//
// An EPHEMERAL cooperative scheduler for live in-flight async work. It governs
// three things and nothing else: ordering (by Priority) when work is queued
// behind a concurrency cap, how many tasks run at once, and cancellation via
// AbortSignal. It is deliberately NOT durable — Loom's event-sourcing + replay-vm
// already own durable pause/resume (SuspendError). Do not persist scheduler state.
//
// Latency guard: the default `concurrency: Infinity` disables gating entirely, so
// `schedule` reduces to `await task(signal)` with no queue node, no controller,
// and no bookkeeping. Overhead is only paid when a finite cap is explicitly set.

export interface ScheduleOptions {
  /** Ordering lane when queued behind a concurrency cap. Default: Normal. */
  priority?: Priority;
  /** Caller cancellation. Forwarded to the task and honoured while queued. */
  signal?: AbortSignal;
  /** Human-readable label for telemetry only. */
  label?: string;
}

export type SchedulerEvent =
  | { readonly type: "scheduled"; readonly label?: string; readonly priority: Priority }
  | { readonly type: "started"; readonly label?: string; readonly priority: Priority }
  | {
      readonly type: "settled";
      readonly label?: string;
      readonly priority: Priority;
      readonly ok: boolean;
    };

export interface SchedulerConfig {
  /**
   * Max tasks running concurrently. Default `Infinity` — gating disabled, ~zero
   * overhead. Set a finite value to bound fan-out (e.g. LLM/tool calls).
   */
  concurrency?: number;
  /** Optional telemetry sink. Kept behind a callback so this package stays dep-free. */
  onEvent?: (event: SchedulerEvent) => void;
}

export interface Scheduler {
  /** Run `task` under the scheduler's policy, resolving with its result. */
  schedule<T>(task: (signal: AbortSignal) => Promise<T>, opts?: ScheduleOptions): Promise<T>;
  /** Tasks currently executing. */
  readonly inFlight: number;
  /** Tasks queued waiting for a slot. */
  readonly pending: number;
}

interface QueueItem {
  readonly priority: Priority;
  readonly seq: number;
  run(): void;
}

// Binary-search insert keeping the queue ordered by (priority asc, seq asc) so
// the most urgent, oldest task sits at the front. N is small (in-flight fan-out),
// so this is cheaper and simpler than a heap.
function insertSorted(queue: QueueItem[], item: QueueItem): void {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cur = queue[mid]!;
    if (cur.priority < item.priority || (cur.priority === item.priority && cur.seq < item.seq)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  queue.splice(lo, 0, item);
}

export function createScheduler(config: SchedulerConfig = {}): Scheduler {
  const concurrency = config.concurrency ?? Number.POSITIVE_INFINITY;
  const onEvent = config.onEvent;

  // ── Fast path: no gating, no bookkeeping ──────────────────────────────────
  if (!(concurrency < Number.POSITIVE_INFINITY)) {
    return {
      schedule<T>(task: (signal: AbortSignal) => Promise<T>, opts?: ScheduleOptions): Promise<T> {
        // Always return a rejected promise (never throw synchronously) so
        // `schedule` upholds the "always returns a Promise" contract.
        if (opts?.signal?.aborted) return Promise.reject(signalReason(opts.signal));
        if (onEvent === undefined) {
          return task(opts?.signal ?? NEVER_SIGNAL);
        }
        const priority = opts?.priority ?? Priority.Normal;
        onEvent({
          type: "started",
          ...(opts?.label !== undefined && { label: opts.label }),
          priority,
        });
        return task(opts?.signal ?? NEVER_SIGNAL).then(
          (v) => {
            onEvent({
              type: "settled",
              ...(opts?.label !== undefined && { label: opts.label }),
              priority,
              ok: true,
            });
            return v;
          },
          (e: unknown) => {
            onEvent({
              type: "settled",
              ...(opts?.label !== undefined && { label: opts.label }),
              priority,
              ok: false,
            });
            throw e;
          }
        );
      },
      get inFlight() {
        return 0;
      },
      get pending() {
        return 0;
      },
    };
  }

  // ── Gated path: priority queue in front of a counting semaphore ────────────
  const queue: QueueItem[] = [];
  let active = 0;
  let seqCounter = 0;

  function pump(): void {
    while (active < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      item.run();
    }
  }

  function schedule<T>(
    task: (signal: AbortSignal) => Promise<T>,
    opts?: ScheduleOptions
  ): Promise<T> {
    const priority = opts?.priority ?? Priority.Normal;
    const callerSignal = opts?.signal;
    const label = opts?.label;
    const emit = (type: SchedulerEvent["type"], ok?: boolean): void => {
      if (onEvent === undefined) return;
      onEvent(
        type === "settled"
          ? { type, ...(label !== undefined && { label }), priority, ok: ok === true }
          : { type, ...(label !== undefined && { label }), priority }
      );
    };

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (onAbort !== undefined && callerSignal !== undefined) {
          callerSignal.removeEventListener("abort", onAbort);
        }
      };
      const settleResolve = (value: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        emit("settled", true);
        resolve(value);
      };
      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        emit("settled", false);
        reject(err);
      };

      const item: QueueItem = {
        priority,
        seq: seqCounter++,
        run() {
          // May have been aborted while queued; the abort handler already
          // removed it and rejected, so just skip.
          if (settled) return;
          active++;
          emit("started");
          const signal = callerSignal ?? NEVER_SIGNAL;
          Promise.resolve()
            .then(() => task(signal))
            .then(
              (value) => {
                active--;
                settleResolve(value);
                pump();
              },
              (err: unknown) => {
                active--;
                settleReject(err);
                pump();
              }
            );
        },
      };

      // Honour cancellation that arrives while the task is still queued so it
      // never occupies a slot — keeps cancellation latency low under a cap.
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) {
          settleReject(signalReason(callerSignal));
          return;
        }
        onAbort = () => {
          const idx = queue.indexOf(item);
          if (idx >= 0) {
            queue.splice(idx, 1);
            settleReject(signalReason(callerSignal));
          }
          // If already running, the task observes `signal` itself.
        };
        callerSignal.addEventListener("abort", onAbort, { once: true });
      }

      insertSorted(queue, item);
      emit("scheduled");
      pump();
    });
  }

  return {
    schedule,
    get inFlight() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  };
}
