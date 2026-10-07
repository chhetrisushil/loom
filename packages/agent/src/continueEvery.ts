/**
 * ADR 0109 D1 — the turn counter a long-lived agent rotates on.
 *
 * There is deliberately NO `shouldContinueAsNew()` in the kernel: a suggestion computed from the
 * history length differs on every re-run (it is not replay-deterministic). A flow counts its OWN
 * turns instead, and the count is a pure function of the flow's control flow: a re-run from the top
 * replays every turn the log holds and counts them again, so it reaches the same rotation point at
 * the same turn.
 *
 * ```ts
 * const turns = continueEvery(500);
 * for (;;) {
 *   const msg = await ctx.receive("user");
 *   await ctx.run(answer, msg);
 *   if (turns.turn()) return ctx.continueAsNew({ summary });   // never returns
 * }
 * ```
 *
 * Create the counter INSIDE the flow body (it is per-generation state: a successor starts at 0).
 */
export interface TurnCounter {
  /** Count one turn. `true` on every `n`-th call: the moment to `return ctx.continueAsNew(...)`. */
  turn(): boolean;
  /** Turns counted so far in this generation. */
  readonly turns: number;
}

export function continueEvery(n: number): TurnCounter {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`continueEvery(n): n must be a positive integer (got ${String(n)})`);
  }
  let turns = 0;
  return {
    turn(): boolean {
      turns++;
      return turns % n === 0;
    },
    get turns(): number {
      return turns;
    },
  };
}
