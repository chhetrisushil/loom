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
}

export interface TimerStore {
  /** Idempotent per (executionId, wakeAt): re-scheduling the same wake is a no-op. */
  schedule(timer: TimerRecord): Promise<void>;
  /** Timers with `wakeAt <= now`, ordered soonest-first. */
  due(now: number, limit?: number): Promise<TimerRecord[]>;
  /** Remove a fired (or obsolete) timer. Unknown timers are a no-op. */
  complete(executionId: string, wakeAt: number): Promise<void>;
  close(): Promise<void>;
}

/** Reference in-memory {@link TimerStore} (tests, ephemeral apps). */
export class InMemoryTimerStore implements TimerStore {
  private readonly timers = new Map<string, TimerRecord>();

  private key(executionId: string, wakeAt: number): string {
    return `${executionId}@${wakeAt}`;
  }

  async schedule(timer: TimerRecord): Promise<void> {
    const key = this.key(timer.executionId, timer.wakeAt);
    // Upsert (ADR 0118 D4): a flagged row is never downgraded by a plain schedule.
    const redrive = timer.redrive ?? this.timers.get(key)?.redrive;
    this.timers.set(key, {
      executionId: timer.executionId,
      wakeAt: timer.wakeAt,
      ...(redrive !== undefined && { redrive: { ...redrive } }),
    });
  }

  async due(now: number, limit = 100): Promise<TimerRecord[]> {
    return [...this.timers.values()]
      .filter((t) => t.wakeAt <= now)
      .sort((a, b) => a.wakeAt - b.wakeAt)
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }

  async complete(executionId: string, wakeAt: number): Promise<void> {
    this.timers.delete(this.key(executionId, wakeAt));
  }

  async close(): Promise<void> {
    this.timers.clear();
  }
}
