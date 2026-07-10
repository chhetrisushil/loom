import {
  Priority,
  type ScheduleOptions,
  type Scheduler,
  type SchedulerEvent,
} from "@loom/scheduler";

// ── Per-tenant fair scheduler ─────────────────────────────────────────────────
//
// A drop-in `Scheduler` (same interface as `@loom/scheduler`'s `createScheduler`) that,
// when work queues behind a concurrency cap, dispatches with **weighted round-robin
// across tenants** instead of one global priority-FIFO. The base scheduler is fair to
// TASKS (priority + arrival); under multi-tenancy that lets one busy tenant starve the
// rest. Here each tenant gets its own priority lane, and the dispatcher cycles tenants
// so no single tenant monopolizes the cap. Within a tenant, order is still by priority
// then arrival — identical to the base scheduler, so a single-tenant workload behaves
// exactly as before.
//
// Zero-overhead fast path preserved: with `concurrency: Infinity` there is no gating,
// no queue, no tenant bookkeeping — `schedule` reduces to awaiting the task.

/** `ScheduleOptions` plus the tenant this task is billed to (and an optional weight). */
export interface FairScheduleOptions extends ScheduleOptions {
  /** The tenant this task belongs to. Omitted ⇒ the shared default lane `""`. */
  tenant?: string;
  /**
   * Relative share for this tenant's lane (default 1). A tenant with weight 2 gets
   * roughly twice the dispatch turns of a weight-1 tenant when both are saturated.
   * The weight seen on a tenant's FIRST queued task sets that lane's weight.
   */
  weight?: number;
}

export interface FairSchedulerConfig {
  /** Max tasks running concurrently. Default Infinity — gating disabled, zero overhead. */
  concurrency?: number;
  onEvent?: (event: SchedulerEvent) => void;
}

/** A {@link Scheduler} whose `schedule` also accepts a `tenant` / `weight`. */
export interface FairScheduler extends Scheduler {
  schedule<T>(task: (signal: AbortSignal) => Promise<T>, opts?: FairScheduleOptions): Promise<T>;
}

const NEVER_SIGNAL = new AbortController().signal;
const signalReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

const DEFAULT_TENANT = "";

interface QueueItem {
  readonly priority: Priority;
  readonly seq: number;
  settled: boolean;
  run(): void;
}

// Binary-search insert keeping a tenant's lane ordered by (priority asc, seq asc):
// the most urgent, oldest task sits at the front. Lanes are small, so this beats a heap.
function insertSorted(queue: QueueItem[], item: QueueItem): void {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cur = queue[mid] as QueueItem;
    if (cur.priority < item.priority || (cur.priority === item.priority && cur.seq < item.seq)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  queue.splice(lo, 0, item);
}

interface Lane {
  readonly tenant: string;
  readonly weight: number;
  readonly queue: QueueItem[];
}

/** A tenant-fair {@link Scheduler}. */
export function createFairScheduler(config: FairSchedulerConfig = {}): FairScheduler {
  const concurrency = config.concurrency ?? Number.POSITIVE_INFINITY;
  const onEvent = config.onEvent;

  // ── Fast path: no gating, no bookkeeping (identical to base createScheduler) ──
  if (!(concurrency < Number.POSITIVE_INFINITY)) {
    return {
      schedule<T>(
        task: (signal: AbortSignal) => Promise<T>,
        opts?: FairScheduleOptions
      ): Promise<T> {
        if (opts?.signal?.aborted) return Promise.reject(signalReason(opts.signal));
        if (onEvent === undefined) return task(opts?.signal ?? NEVER_SIGNAL);
        const priority = opts?.priority ?? Priority.Normal;
        const label = opts?.label;
        onEvent({ type: "started", ...(label !== undefined && { label }), priority });
        return task(opts?.signal ?? NEVER_SIGNAL).then(
          (v) => {
            onEvent({ type: "settled", ...(label !== undefined && { label }), priority, ok: true });
            return v;
          },
          (e: unknown) => {
            onEvent({
              type: "settled",
              ...(label !== undefined && { label }),
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

  // ── Gated path: per-tenant lanes dispatched by weighted round-robin ──────────
  const lanes = new Map<string, Lane>();
  // Rotation: each tenant repeated `weight` times, so weight-2 tenants get 2x turns.
  // Rebuilt when the tenant set changes; the cursor walks it, skipping empty lanes.
  let rotation: string[] = [];
  let cursor = 0;
  let active = 0;
  let pendingCount = 0;
  let seqCounter = 0;

  const rebuildRotation = (): void => {
    rotation = [];
    for (const lane of lanes.values()) {
      for (let i = 0; i < lane.weight; i++) rotation.push(lane.tenant);
    }
    if (cursor >= rotation.length) cursor = 0;
  };

  const laneFor = (tenant: string, weight: number): Lane => {
    let lane = lanes.get(tenant);
    if (lane === undefined) {
      lane = { tenant, weight: Math.max(1, Math.floor(weight)), queue: [] };
      lanes.set(tenant, lane);
      rebuildRotation();
    }
    return lane;
  };

  // Pick the next non-empty lane in weighted round-robin order, advancing the cursor
  // past it so the following pick moves on (fairness), not re-serving the same tenant.
  const nextItem = (): QueueItem | undefined => {
    for (let scanned = 0; scanned < rotation.length; scanned++) {
      const tenant = rotation[(cursor + scanned) % rotation.length] as string;
      const lane = lanes.get(tenant);
      if (lane !== undefined && lane.queue.length > 0) {
        cursor = (cursor + scanned + 1) % rotation.length;
        return lane.queue.shift();
      }
    }
    return undefined;
  };

  const pump = (): void => {
    while (active < concurrency) {
      const item = nextItem();
      if (item === undefined) return;
      pendingCount--;
      item.run();
    }
  };

  function schedule<T>(
    task: (signal: AbortSignal) => Promise<T>,
    opts?: FairScheduleOptions
  ): Promise<T> {
    const priority = opts?.priority ?? Priority.Normal;
    const callerSignal = opts?.signal;
    const label = opts?.label;
    const tenant = opts?.tenant ?? DEFAULT_TENANT;
    const lane = laneFor(tenant, opts?.weight ?? 1);

    const emit = (type: SchedulerEvent["type"], ok?: boolean): void => {
      if (onEvent === undefined) return;
      onEvent(
        type === "settled"
          ? { type, ...(label !== undefined && { label }), priority, ok: ok === true }
          : { type, ...(label !== undefined && { label }), priority }
      );
    };

    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const cleanup = (): void => {
        if (onAbort !== undefined && callerSignal !== undefined) {
          callerSignal.removeEventListener("abort", onAbort);
        }
      };

      const item: QueueItem = {
        priority,
        seq: seqCounter++,
        settled: false,
        run() {
          if (this.settled) return;
          active++;
          emit("started");
          const signal = callerSignal ?? NEVER_SIGNAL;
          Promise.resolve()
            .then(() => task(signal))
            .then(
              (value) => {
                active--;
                if (!this.settled) {
                  this.settled = true;
                  cleanup();
                  emit("settled", true);
                  resolve(value);
                }
                pump();
              },
              (err: unknown) => {
                active--;
                if (!this.settled) {
                  this.settled = true;
                  cleanup();
                  emit("settled", false);
                  reject(err);
                }
                pump();
              }
            );
        },
      };

      // Cancellation while queued: remove from the lane without ever taking a slot.
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) {
          item.settled = true;
          reject(signalReason(callerSignal));
          return;
        }
        onAbort = () => {
          const idx = lane.queue.indexOf(item);
          if (idx >= 0) {
            lane.queue.splice(idx, 1);
            pendingCount--;
            item.settled = true;
            cleanup();
            emit("settled", false);
            reject(signalReason(callerSignal));
          }
        };
        callerSignal.addEventListener("abort", onAbort, { once: true });
      }

      insertSorted(lane.queue, item);
      pendingCount++;
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
      return pendingCount;
    },
  };
}
