import type { ScheduleDefinition } from "@loom/core";
import type { TimerStore } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { type CronSpec, nextOccurrence, parseCron } from "./cron";
import { TIMER_FIRED } from "./types";

export interface TimerServiceOptions {
  /** Poll cadence for due timers, in ms. Default 250. */
  pollMs?: number;
  /** Max due timers fired per poll. Default 100. */
  batch?: number;
  /** Observability hook for a failed fire (the timer is retried next poll). */
  onError?: (executionId: string, err: unknown) => void;
  /**
   * T1.2 — durable cron schedules (`schedule$`), statically wired (P5). Each
   * due occurrence starts its flow with the deterministic executionId
   * `{scheduleId}@{occurrenceMs}`: firing is at-least-once, but a fired
   * occurrence that already started is never double-started — the id is
   * checked against durable state, and the store's uniqueness backstop settles
   * cross-node races (per K9's dedup concept). No catch-up: occurrences that
   * passed while no service was running are skipped (the service fires
   * occurrences from its start time onward).
   */
  schedules?: ScheduleDefinition[];
  /**
   * T1.2/K9.4 — acquire a fencing token per fire/start (on a fencing store),
   * so a duplicate cross-node fire loses at the store instead of double-
   * writing. Enable in multi-node deployments where dispatches are fenced
   * everywhere; default false (a fenced execution refuses unfenced writes,
   * which would surprise single-node apps that also resume manually).
   */
  fenced?: boolean;
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
  private readonly fenced: boolean;
  private readonly schedules: Array<{ def: ScheduleDefinition; spec: CronSpec; cursor: number }>;
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
    this.fenced = options.fenced ?? false;
    // Cron cursors start at construction time: no catch-up of occurrences that
    // passed while nothing was running (documented; a durable catch-up policy
    // can layer on later without changing the firing contract).
    const floor = Date.now();
    this.schedules = (options.schedules ?? []).map((def) => ({
      def,
      spec: parseCron(def.cron),
      cursor: floor,
    }));
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

  /** One poll: fire every due timer and every due cron occurrence. Exposed for deterministic tests. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return; // never overlap polls
    this.ticking = true;
    try {
      const due = await this.store.due(now, this.batch);
      for (const timer of due) {
        await this.fire(timer.executionId, timer.wakeAt);
      }
      for (const schedule of this.schedules) {
        await this.fireDueOccurrences(schedule, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fireDueOccurrences(
    schedule: { def: ScheduleDefinition; spec: CronSpec; cursor: number },
    now: number
  ): Promise<void> {
    for (let i = 0; i < this.batch; i++) {
      const occurrence = nextOccurrence(schedule.spec, schedule.cursor);
      if (occurrence > now) return;
      await this.startOccurrence(schedule.def, occurrence);
      schedule.cursor = occurrence;
    }
  }

  private async startOccurrence(def: ScheduleDefinition, occurrence: number): Promise<void> {
    // A2 — the deterministic occurrence id: every node computes the same one,
    // so dedup needs no coordination (durable-state check + the store's
    // uniqueness backstop for the raced remainder).
    const executionId = `${def.id}@${occurrence}`;
    try {
      const existing = await this.runtime.loadState(executionId);
      if (existing !== null) return; // already started (this node or another)
      const flow = this.runtime.getFlow(def.flowId);
      if (!flow) {
        throw new Error(`schedule "${def.id}": no flow registered for flowId "${def.flowId}"`);
      }
      const fence = this.fenced ? await this.runtime.acquireFence(executionId) : undefined;
      const handle = await this.runtime.start(flow, def.input, {
        executionId,
        ...(fence !== undefined && { fence }),
      });
      await Promise.race([
        handle.waitForSuspend().catch(() => undefined),
        handle.waitForCompletion().catch(() => undefined),
      ]);
    } catch (err) {
      this.onError?.(executionId, err);
    }
  }

  private async fire(executionId: string, wakeAt: number): Promise<void> {
    try {
      const state = await this.runtime.loadState(executionId);
      const stillWaiting =
        state !== null && state.status === "suspended" && state.suspendedOn?.wakeAt === wakeAt;
      if (stillWaiting) {
        // K9.4 — in fenced deployments, acquire a newer token first so a
        // duplicate cross-node fire loses at the store instead of double-writing.
        const fence = this.fenced ? await this.runtime.acquireFence(executionId) : undefined;
        const handle = await this.runtime.resume(
          executionId,
          { eventType: TIMER_FIRED, payload: { wakeAt } },
          fence !== undefined ? { fence } : undefined
        );
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
