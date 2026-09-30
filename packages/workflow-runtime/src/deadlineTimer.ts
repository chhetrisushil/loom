/** Node clamps any `setTimeout` delay above 2^31-1 ms (~24.8 days) to 1ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Remaining budget of a deadline anchored at `anchor` (a journal timestamp written with
 * `now`). Never more than the full `budget`: the anchor cannot grant more time than was
 * declared, so a clock that stepped backwards (NTP, a restart with a smaller offset)
 * cannot inflate the wait.
 */
export function remainingBudget(budget: number, anchor: number, now: () => number): number {
  return Math.min(budget, budget - (now() - anchor));
}

/**
 * Arm a deadline that calls `onBreach` once `remaining()` reaches 0. A wait longer than
 * `MAX_TIMER_MS` is armed in chunks: at the cap, the remaining time is recomputed from
 * the injected clock and re-armed as needed, so a 30-day budget is neither clamped to
 * 1ms nor fired early. A wait within the cap fires directly (no recheck). Returns a
 * `clear` that cancels any pending timer (call on settle/cancel).
 */
export function armDeadline(remaining: () => number, onBreach: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const arm = (ms: number, recheck: boolean): void => {
    timer = setTimeout(
      () => {
        timer = undefined;
        if (done) return;
        if (recheck) {
          const left = remaining();
          if (left > 0) return arm(left, left > MAX_TIMER_MS);
        }
        done = true;
        onBreach();
      },
      Math.min(ms, MAX_TIMER_MS)
    );
  };
  const first = remaining();
  if (first <= 0) {
    done = true;
    onBreach();
    return () => {};
  }
  arm(first, first > MAX_TIMER_MS);
  return () => {
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
