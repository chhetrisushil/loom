import type { TimerStore } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { TIMER_FIRED } from "./types";

export interface TimerServiceOptions {
  /** Poll cadence for due timers, in ms. Default 250. */
  pollMs?: number;
  /** Max due timers fired per poll. Default 100. */
  batch?: number;
  /** Observability hook for a failed fire (the timer is retried next poll). */
  onError?: (executionId: string, err: unknown) => void;
}

/**
 * T1 — the durable-timer firing service. Polls the {@link TimerStore} for due
 * wakes and resumes each execution with a governed **`TIMER_FIRED`** fact.
 *
 * Delivery contract (mirrors K9): firing is **at-least-once** — the service
 * resumes first and completes the timer after, so a crash in between
 * re-delivers on the next poll — and wakes are **idempotent**: a timer only
 * fires while its execution is still suspended on exactly that `wakeAt`
 * (already-resumed / completed / cancelled executions just retire the timer).
 * Replay is deterministic regardless of when it happens: the *scheduled* time
 * is in the log (`condition.wakeAt`), the fire is a logged fact, and wall-clock
 * drift never enters the fold (G1/P9).
 *
 * Run one service per node against the shared store; duplicate concurrent fires
 * settle idempotently (the second resume finds the execution no longer
 * suspended on that wake). Cross-node lease/fencing hardening arrives with the
 * schedule registry (T1.2).
 */
export class TimerService {
  private readonly pollMs: number;
  private readonly batch: number;
  private readonly onError: ((executionId: string, err: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly store: TimerStore,
    options: TimerServiceOptions = {}
  ) {
    this.pollMs = options.pollMs ?? 250;
    this.batch = options.batch ?? 100;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Don't hold a process open just to poll timers.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One poll: fire every due timer. Exposed for deterministic tests. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return; // never overlap polls
    this.ticking = true;
    try {
      const due = await this.store.due(now, this.batch);
      for (const timer of due) {
        await this.fire(timer.executionId, timer.wakeAt);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fire(executionId: string, wakeAt: number): Promise<void> {
    try {
      const state = await this.runtime.loadState(executionId);
      const stillWaiting =
        state !== null && state.status === "suspended" && state.suspendedOn?.wakeAt === wakeAt;
      if (stillWaiting) {
        const handle = await this.runtime.resume(executionId, {
          eventType: TIMER_FIRED,
          payload: { wakeAt },
        });
        // Wait for the run to settle (suspend again, complete, or fail) so the
        // timer is only retired once the wake durably took effect.
        await Promise.race([
          handle.waitForSuspend().catch(() => undefined),
          handle.waitForCompletion().catch(() => undefined),
        ]);
      }
      // Fired — or obsolete (resumed by other means, terminal, unknown): retire it.
      await this.store.complete(executionId, wakeAt);
    } catch (err) {
      // Leave the timer in place; the next poll retries (at-least-once).
      this.onError?.(executionId, err);
    }
  }
}
