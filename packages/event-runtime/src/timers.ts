// ── T1 — durable timer storage ────────────────────────────────────────────────
//
// A timer is the durable half of `ctx.sleep`/`ctx.sleepUntil` (and of
// `suspend({ timeout })` when a timer service is wired): the execution suspends
// with `wakeAt` recorded in its EXECUTION_SUSPENDED condition, and a timer row
// makes the wake FINDABLE — a poller can enumerate due timers without scanning
// every execution's log. Timer storage lives in the same store family as events
// (T1.3), so one backup captures the full kernel state.
//
// Firing is at-least-once: the service resumes the execution, then completes the
// timer. A crash in between re-delivers, and the service's suspended-on-this-
// wake guard makes the duplicate a no-op (idempotent wakes).

export interface TimerRecord {
  executionId: string;
  /** Absolute wake time (epoch ms) — matches the logged `condition.wakeAt`. */
  wakeAt: number;
  /**
   * ADR 0118 D4 — marks a RE-DRIVE row: a backed-off retry of a resume that hit `contended`
   * (`attempt` counts the tries so far), not the wake of a timed suspend. `TimerService.fire` does
   * NOT judge it by `suspendedOn.wakeAt` (which would retire it as obsolete); it hands it to the
   * registered re-drivers. Optional and additive: a plain wake carries none.
   *
   * `schedule` UPSERTS it: re-scheduling an existing `(executionId, wakeAt)` never clears a flag
   * already set (a redrive row is never downgraded to a plain wake), and a record that carries one
   * sets it on a row that had none. A store must keep a `redrive` row distinguishable from a plain
   * one through `due`.
   */
  redrive?: { attempt: number };
  /**
   * ADR 0130 D10 - marks a REPLAY-REFUSAL row: a node that could not open a sealed recorded answer
   * refused to run a `running` execution and left this row so a node that CAN picks it up. `head` is
   * the execution's log head at the refusal; the timer poll re-drives only while the log still sits
   * there. `wakeAt` is an ordinary instant (when the poll should look next), never an encoded stamp.
   * Optional and additive: a plain wake carries none. A node that predates the field reads the row
   * as a plain wake it can never match to a park and retires it as obsolete (fail safe: never re-driven).
   *
   * `holds` (optional, absent = 0) counts how many times a poller has HELD the row (rescheduled it
   * to a later instant because it could not act yet). It is part of the row's own data so the next
   * instant is a DETERMINISTIC function of the row (`wakeAt` + back-off(holds + 1), no node-local
   * jitter): N pollers that read the same row all write the SAME successor key, so concurrent
   * holders converge on one row instead of multiplying it.
   *
   * `schedule` UPSERTS it like `redrive`: re-scheduling an existing `(executionId, wakeAt)` never
   * clears a stamp already set, and a record that carries one sets it. On a same-key upsert the
   * stored stamp keeps the MAX `head` and the MAX `holds` of the two (never last-writer-wins: two
   * nodes writing in the same millisecond must not move a head backwards). A store must keep a
   * `refused` row distinguishable from a plain one through `due`.
   */
  refused?: { head: number; holds?: number };
}

export interface TimerStore {
  /** Idempotent per (executionId, wakeAt): re-scheduling the same wake is a no-op. */
  schedule(timer: TimerRecord): Promise<void>;
  /**
   * Timers with `wakeAt <= now`, ordered soonest-first.
   *
   * `options.redrive === false` (ADR 0118 D4) EXCLUDES re-drive rows BEFORE the limit applies: a
   * node with no re-driver registered would otherwise see a batch full of rows it cannot judge and
   * starve every plain wake behind them. A store that ignores the option is still correct (the
   * service skips such rows itself); it only keeps that starvation window.
   *
   * `options.inbox === false` (ADR 0110) likewise EXCLUDES the inbox wake row (a NON-re-drive row at `wakeAt === -1`,
   * `INBOX_WAKE_AT`) before the limit: a node with the inbox flag off cannot run the notify path
   * and must leave those rows for a node that can, but they sort first (instant -1), so a batch of
   * them would starve every real timer behind it. The sentinel is -1, an instant no timed
   * park uses, so a flag-off node still fires every real timer (including `ctx.sleep(0)` at clock 0).
   *
   * `options.refused === false` (ADR 0130 D10) EXCLUDES replay-refusal rows BEFORE the limit: a node
   * with no abandonment evidence configured (or no inbox) cannot act on them, and must not fetch
   * - let alone read the execution of - one per row. A store that ignores the option is still
   * correct (the service skips such rows itself); it only keeps that starvation window.
   */
  due(
    now: number,
    limit?: number,
    options?: { redrive?: boolean; inbox?: boolean; refused?: boolean }
  ): Promise<TimerRecord[]>;
  /** Remove a fired (or obsolete) timer. Unknown timers are a no-op. */
  complete(executionId: string, wakeAt: number): Promise<void>;
  close(): Promise<void>;
}

/** Reference in-memory {@link TimerStore} (tests, ephemeral apps). */
/** Same-key upsert of a refusal stamp: the MAX head and the MAX holds (absent holds stays absent). */
function mergeRefused(
  prior: TimerRecord["refused"],
  next: TimerRecord["refused"]
): TimerRecord["refused"] {
  if (next === undefined) return prior;
  if (prior === undefined) return next;
  const holds =
    prior.holds === undefined && next.holds === undefined
      ? undefined
      : Math.max(prior.holds ?? 0, next.holds ?? 0);
  return { head: Math.max(prior.head, next.head), ...(holds !== undefined && { holds }) };
}

export class InMemoryTimerStore implements TimerStore {
  private readonly timers = new Map<string, TimerRecord>();

  private key(executionId: string, wakeAt: number): string {
    return `${executionId}@${wakeAt}`;
  }

  async schedule(timer: TimerRecord): Promise<void> {
    const key = this.key(timer.executionId, timer.wakeAt);
    // Upsert (ADR 0118 D4): a flagged row is never downgraded by a plain schedule.
    const redrive = timer.redrive ?? this.timers.get(key)?.redrive;
    const prior = this.timers.get(key)?.refused;
    const refused = mergeRefused(prior, timer.refused);
    this.timers.set(key, {
      executionId: timer.executionId,
      wakeAt: timer.wakeAt,
      ...(redrive !== undefined && { redrive: { ...redrive } }),
      ...(refused !== undefined && { refused: { ...refused } }),
    });
  }

  async due(
    now: number,
    limit = 100,
    options?: { redrive?: boolean; inbox?: boolean; refused?: boolean }
  ): Promise<TimerRecord[]> {
    return [...this.timers.values()]
      .filter(
        (t) =>
          t.wakeAt <= now &&
          (options?.redrive !== false || t.redrive === undefined) &&
          (options?.refused !== false || t.refused === undefined) &&
          (options?.inbox !== false || t.wakeAt !== -1 || t.redrive !== undefined)
      )
      .sort((a, b) => a.wakeAt - b.wakeAt)
      .slice(0, limit)
      .map((t) => ({
        ...t,
        ...(t.redrive !== undefined && { redrive: { ...t.redrive } }),
        ...(t.refused !== undefined && { refused: { ...t.refused } }),
      }));
  }

  async complete(executionId: string, wakeAt: number): Promise<void> {
    this.timers.delete(this.key(executionId, wakeAt));
  }

  async close(): Promise<void> {
    this.timers.clear();
  }
}
