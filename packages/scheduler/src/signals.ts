// ── AbortSignal utilities ─────────────────────────────────────────────────────
//
// Small, dependency-free helpers for cooperative cancellation. Everything is
// optional-signal-safe: passing `undefined` allocates nothing and is a no-op, so
// the non-cancellable fast path pays zero cost.

/**
 * A single shared signal that never aborts. Used as the argument handed to a
 * task when the caller supplied no signal, so task callbacks can always rely on
 * receiving an `AbortSignal` without forcing an `AbortController` allocation per
 * call. Allocated exactly once at module load.
 */
export const NEVER_SIGNAL: AbortSignal = new AbortController().signal;

/** Normalise an aborted signal's reason into a throwable error. */
export function signalReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason !== undefined) return reason;
  return new DOMException("This operation was aborted", "AbortError");
}

/**
 * Throw if the (optional) signal is already aborted. No-op when `signal` is
 * undefined or not yet aborted. Prefers the platform `throwIfAborted` when
 * present (Node 17.3+) so the thrown reason matches host semantics.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal === undefined) return;
  const native = (signal as { throwIfAborted?: () => void }).throwIfAborted;
  if (typeof native === "function") {
    native.call(signal);
    return;
  }
  if (signal.aborted) throw signalReason(signal);
}

/**
 * Combine several (optional) signals into one that aborts as soon as any input
 * aborts. Returns `undefined` when no real signal is supplied, the same signal
 * when exactly one is, and a linked signal otherwise. Prefers native
 * `AbortSignal.any` (Node 20.3+); falls back to a listener-based polyfill.
 */
export function linkSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  const anyFn = (AbortSignal as unknown as { any?: (s: Iterable<AbortSignal>) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(present);

  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort(signalReason(s));
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort(signalReason(s)), { once: true });
  }
  return controller.signal;
}

/**
 * Derive a signal that aborts after `ms` (with a `TimeoutError`) or when the
 * optional `parent` aborts, whichever is first. Call `dispose()` when the guarded
 * work settles so the timer and parent listener are released.
 */
export function withTimeout(
  ms: number,
  parent?: AbortSignal
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Timed out after ${ms}ms`, "TimeoutError"));
  }, ms);
  // Don't keep the event loop alive purely for a pending timeout.
  (timer as { unref?: () => void }).unref?.();

  let onParentAbort: (() => void) | undefined;
  if (parent !== undefined) {
    if (parent.aborted) {
      clearTimeout(timer);
      controller.abort(signalReason(parent));
    } else {
      onParentAbort = () => {
        clearTimeout(timer);
        controller.abort(signalReason(parent));
      };
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (parent !== undefined && onParentAbort !== undefined) {
        parent.removeEventListener("abort", onParentAbort);
      }
    },
  };
}
