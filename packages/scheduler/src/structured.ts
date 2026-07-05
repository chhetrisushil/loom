import { NEVER_SIGNAL, linkSignals, throwIfAborted } from "./signals";

// ── Structured concurrency ────────────────────────────────────────────────────

export interface ParallelLimitOptions {
  /** Max tasks running at once. Default: unbounded (all at once). */
  limit?: number;
  /** Caller cancellation, linked into the signal handed to each task. */
  signal?: AbortSignal;
  /**
   * Abort still-running/pending siblings on the first rejection and reject with
   * that error. Default `true`. When `false`, every task runs to settlement and
   * the first error (by input order) is thrown after all complete.
   */
  failFast?: boolean;
}

/**
 * Run `tasks` with bounded concurrency, **preserving input order in the result
 * array** — `results[i]` always corresponds to `tasks[i]`, regardless of
 * completion order. This ordering guarantee is load-bearing for Loom's replay
 * determinism: callers that fan out work (agent tool calls, workflow parallel
 * steps) can reduce results deterministically even though execution interleaves.
 *
 * Degenerates to `Promise.all` semantics when `limit >= tasks.length`.
 */
export async function parallelLimit<T>(
  tasks: ReadonlyArray<(signal: AbortSignal) => Promise<T>>,
  opts: ParallelLimitOptions = {}
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  if (tasks.length === 0) return results;

  throwIfAborted(opts.signal);

  const failFast = opts.failFast ?? true;
  const rawLimit = opts.limit ?? tasks.length;
  const limit = Math.min(rawLimit <= 0 ? tasks.length : rawLimit, tasks.length);

  // A task-scoped controller lets failFast abort siblings. Only allocated when
  // failFast is on; otherwise tasks just see the caller signal (or none).
  let controller: AbortController | undefined;
  let signal: AbortSignal;
  if (failFast) {
    controller = new AbortController();
    signal = linkSignals(opts.signal, controller.signal) ?? NEVER_SIGNAL;
  } else {
    signal = opts.signal ?? NEVER_SIGNAL;
  }

  // Fast path: unbounded fan-out degenerates to Promise.all, which already
  // preserves input order and (with failFast) rejects on the first error. We
  // still abort siblings so in-flight tasks can observe cancellation.
  if (limit >= tasks.length) {
    if (failFast) {
      return Promise.all(
        tasks.map((task) =>
          task(signal).catch((err: unknown) => {
            controller?.abort(err);
            throw err;
          })
        )
      );
    }
    const settled = await Promise.allSettled(tasks.map((task) => task(signal)));
    let firstRejection: { error: unknown } | undefined;
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === "fulfilled") results[i] = outcome.value;
      else if (firstRejection === undefined) firstRejection = { error: outcome.reason };
    }
    if (firstRejection !== undefined) throw firstRejection.error;
    return results;
  }

  let nextIndex = 0;
  let errored = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (true) {
      if (errored && failFast) return;
      const i = nextIndex++;
      if (i >= tasks.length) return;
      try {
        // i < tasks.length is checked above, so tasks[i] is defined.
        results[i] = await tasks[i]!(signal);
      } catch (err) {
        if (!errored) {
          errored = true;
          firstError = err;
          if (failFast) controller?.abort(err);
        }
        if (failFast) return;
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < limit; w++) workers.push(worker());
  await Promise.all(workers);

  if (errored) throw firstError;
  return results;
}
