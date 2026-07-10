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
    this.timers.set(this.key(timer.executionId, timer.wakeAt), timer);
  }

  async due(now: number, limit = 100): Promise<TimerRecord[]> {
    return [...this.timers.values()]
      .filter((t) => t.wakeAt <= now)
      .sort((a, b) => a.wakeAt - b.wakeAt)
      .slice(0, limit);
  }

  async complete(executionId: string, wakeAt: number): Promise<void> {
    this.timers.delete(this.key(executionId, wakeAt));
  }

  async close(): Promise<void> {
    this.timers.clear();
  }
}
