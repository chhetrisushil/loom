import type { ScheduleDefinition } from "@loom/core";
import type { EventStore, LeaseStore, TimerStore } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { type CronSpec, nextOccurrence, parseCron } from "./cron";
import { type HeldLease, defaultRenewEvery, renewWhileHeld } from "./leaseRenewal";
import { placementOf } from "./placement";
import { ExecutionAlreadyExistsError, TIMER_FIRED } from "./types";

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
   * Advisory pre-warm lead time (ms). When > 0, the service warms a scheduled
   * flow's first-step effect (`runtime.warmFlow`) up to `warmLeadMs` BEFORE its
   * next occurrence fires — hiding cold-start (K7 child spawn, LLM connection)
   * behind the wait we already know is coming (the occurrence time is
   * deterministic). Off by default; latency-only, never affects the fire itself.
   */
  warmLeadMs?: number;
  /**
   * T1.2/K9.4 — acquire a fencing token per timer FIRE (on a fencing store),
   * so a duplicate cross-node fire loses at the store instead of double-
   * writing. Enable in multi-node deployments where dispatches are fenced
   * everywhere; default false (a fenced execution refuses unfenced writes,
   * which would surprise single-node apps that also resume manually).
   *
   * Schedule occurrence STARTS are never fenced, in either mode (L12, ADR 0103):
   * a start's fence would supersede the token of a live winner that already
   * started the same occurrence, fencing it out mid-body after its first effect
   * and inviting a recovery pass to pay for that effect again. The durable
   * bootstrap already refuses the duplicate at sequence 0, and the first later
   * fence (a fenced wake, a recovery pass) still fences out the unfenced starter.
   * So a scheduled execution accepts unfenced writes until its first fence.
   *
   * Fencing a fire makes a duplicate cross-node fire's WRITES safe, not its effects
   * exactly-once: a node that fires later fences out an earlier node's resume
   * mid-body, after its effect, and a recovery pass pays for that step again. Wire
   * `leases` so only the claimant fires (#380; ADR 0103's open residual).
   */
  fenced?: boolean;
  /**
   * Injectable clock (DST/simulation): anchors the cron cursors at construction
   * and is the default `now` for interval-driven ticks. Default: `Date.now`.
   */
  now?: () => number;
  /**
   * #392 — where to send a wake. With a dispatcher the service dispatches an
   * `ExecutionPackage` to the lane the execution was STARTED in (`placementOf`) instead of
   * resuming on whatever runtime it happens to hold — so an execution deliberately placed
   * on compute sized for it does not wake up inside the process that runs the timer.
   * Without one, behaviour is unchanged.
   */
  dispatcher?: TimerDispatcher;
  /**
   * #380 — take durable ownership of an execution before waking it.
   *
   * `TimerStore.due()` has no claim, so two nodes polling the same store both receive the
   * same due timer, both resume, and both pay for every effect until one loses at the fence.
   * Fencing makes that outcome SAFE, not cheap — and placement (#392) made it expensive on
   * purpose, since a branch is placed precisely when its work is heavy.
   *
   * With a lease store, a node that cannot acquire the lease skips the fire and leaves the
   * timer for whoever holds it. Unwired, behaviour is unchanged.
   */
  leases?: {
    store: LeaseStore;
    /** This node's identity — a pod name, a process uuid, the deployment's vocabulary. */
    owner: string;
    /**
     * How long ownership is claimed for, and RENEWED for while the wake is in flight.
     *
     * Not a bound on how long the run may take — the claim is held across the whole resumed
     * execution, which for a branch simulation is minutes — but the tolerance for a node that
     * has DIED: after this long without a renewal, the lease is collectable and a recovery
     * pass may take over. Default 60s.
     */
    ttlMs?: number;
    /**
     * How often to renew while holding. Default `ttlMs / 3`, so two renewals may be lost
     * before ownership is.
     *
     * Renewal runs on this process's event loop. A handler doing heavy SYNCHRONOUS work
     * blocks it, and a lease that lapses while its holder is healthily working invites a
     * recovery pass to fence the holder out mid-run. Heavy CPU belongs off the main
     * thread — which is what the sandbox worker pool exists for.
     */
    renewEveryMs?: number;
  };
}

/**
 * The slice of `ExecutionDispatcher` a wake needs, typed structurally: the kernel hands a
 * package to a placement seam, it does not depend on one. An `ExecutionDispatcher` from
 * `@loom/dispatcher` satisfies this.
 */
export interface TimerDispatcher {
  dispatch(
    pkg: {
      executionId: string;
      workflowId: string;
      flowId: string;
      resumeEvent: { eventType: string; payload: unknown };
      metadata?: Record<string, unknown>;
    },
    meta?: { target?: string }
  ): Promise<unknown>;
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
  private readonly warmLeadMs: number;
  private readonly schedules: Array<{
    def: ScheduleDefinition;
    spec: CronSpec;
    cursor: number;
    warmed?: number; // the occurrence already pre-warmed (dedupe across polls)
  }>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly now: () => number;

  private readonly dispatcher: TimerDispatcher | undefined;
  private readonly leases: TimerServiceOptions["leases"];
  private readonly leaseTtlMs: number;
  private readonly leaseRenewEveryMs: number;
  private readonly eventStore: EventStore;

  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly store: TimerStore,
    options: TimerServiceOptions = {}
  ) {
    this.dispatcher = options.dispatcher;
    this.leases = options.leases;
    this.leaseTtlMs = options.leases?.ttlMs ?? 60_000;
    this.leaseRenewEveryMs = options.leases?.renewEveryMs ?? defaultRenewEvery(this.leaseTtlMs);
    // Read from the runtime rather than taken as a second option: two stores that must
    // agree is a way for them to disagree.
    this.eventStore = runtime.events;
    this.pollMs = options.pollMs ?? 250;
    this.batch = options.batch ?? 100;
    this.onError = options.onError;
    this.fenced = options.fenced ?? false;
    this.warmLeadMs = options.warmLeadMs ?? 0;
    this.now = options.now ?? Date.now;
    // Cron cursors start at construction time: no catch-up of occurrences that
    // passed while nothing was running (documented; a durable catch-up policy
    // can layer on later without changing the firing contract).
    const floor = this.now();
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
  async tick(now = this.now()): Promise<void> {
    if (this.ticking) return; // never overlap polls
    this.ticking = true;
    try {
      const due = await this.store.due(now, this.batch);
      for (const timer of due) {
        await this.fire(timer.executionId, timer.wakeAt);
      }
      for (const schedule of this.schedules) {
        await this.fireDueOccurrences(schedule, now);
        this.maybeWarm(schedule, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  // Advisory: pre-warm a schedule's flow when its NEXT (not-yet-due) occurrence
  // is within `warmLeadMs`. Deduped per occurrence so it warms once, not every
  // poll. Off the fire path — a warm never gates or delays the start.
  private maybeWarm(
    schedule: { def: ScheduleDefinition; spec: CronSpec; cursor: number; warmed?: number },
    now: number
  ): void {
    if (this.warmLeadMs <= 0) return;
    const upcoming = nextOccurrence(schedule.spec, schedule.cursor);
    if (upcoming <= now || upcoming - now > this.warmLeadMs) return;
    if (schedule.warmed === upcoming) return; // already warmed for this occurrence
    schedule.warmed = upcoming;
    this.runtime.warmFlow(schedule.def.flowId);
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
    // so dedup needs no coordination. `loadState` is the cheap fast path for an
    // occurrence that is visibly started; the raced remainder (two nodes checking
    // before either writes) is refused by `start()` itself with
    // ExecutionAlreadyExistsError BEFORE the loser's body runs (ADR 0103), which
    // is "already started", not an error.
    const executionId = `${def.id}@${occurrence}`;
    try {
      const existing = await this.runtime.loadState(executionId);
      if (existing !== null) return; // already started (this node or another)
      const flow = this.runtime.getFlow(def.flowId);
      if (!flow) {
        throw new Error(`schedule "${def.id}": no flow registered for flowId "${def.flowId}"`);
      }
      // L12 — no fence, even with `fenced: true`. A start that loses the race must not touch
      // the fence of an execution it does not own: acquiring a token here superseded a live
      // winner's, so the winner's next write was refused as stale AFTER its first effect ran,
      // the execution was left `running`, and recovery paid for the effect again. Unfenced,
      // the loser can only be refused at its bootstrap (a duplicate at sequence 0, or a stale
      // fence if the winner has since been fenced), before any body runs.
      const handle = await this.runtime.start(flow, def.input, { executionId });
      await Promise.race([
        handle.waitForSuspend().catch(() => undefined),
        handle.waitForCompletion().catch(() => undefined),
      ]);
    } catch (err) {
      if (err instanceof ExecutionAlreadyExistsError) return; // another node won the race
      this.onError?.(executionId, err);
    }
  }

  private async fire(executionId: string, wakeAt: number): Promise<void> {
    // #380 — claim the execution before waking it. `null` means another node holds it and is
    // presumably firing this same timer; skip WITHOUT completing it, so a wake is never lost
    // if that node dies between the claim and the resume. Its lease expires; we try again.
    const leases = this.leases;
    let held: HeldLease | undefined;
    if (leases !== undefined) {
      const lease = await leases.store.acquire(executionId, leases.owner, this.leaseTtlMs);
      if (lease === null) return;
      // Hold it for as long as the wake takes — see `renewWhileHeld` for why this is not
      // optional: a fire awaits the resumed execution to settle, so the claim spans the run.
      held = renewWhileHeld(
        leases.store,
        executionId,
        leases.owner,
        this.leaseTtlMs,
        this.leaseRenewEveryMs,
        (err) => this.onError?.(executionId, err)
      );
    }
    try {
      const state = await this.runtime.loadState(executionId);
      const stillWaiting =
        state !== null && state.status === "suspended" && state.suspendedOn?.wakeAt === wakeAt;
      if (stillWaiting) {
        // K9.4 — in fenced deployments, acquire a newer token first so a
        // duplicate cross-node fire loses at the store instead of double-writing.
        const fence = this.fenced ? await this.runtime.acquireFence(executionId) : undefined;
        const resumeEvent = { eventType: TIMER_FIRED, payload: { wakeAt } };

        if (this.dispatcher !== undefined) {
          // #392 — the wake goes back to where the execution belongs. The recorded target
          // is a HINT handed to the placement policy, which may route elsewhere: a lane
          // that has since been retired must not strand what named it. Dispatch settles
          // when the worker returns, which is the same "wake durably took effect" the
          // in-process branch waits for below.
          const target = await placementOf(this.eventStore, executionId);
          await this.dispatcher.dispatch(
            {
              executionId,
              workflowId: state.workflowId,
              flowId: state.workflowId,
              resumeEvent,
              ...(fence !== undefined && { metadata: { fence } }),
            },
            target !== undefined ? { target } : undefined
          );
        } else {
          const handle = await this.runtime.resume(
            executionId,
            resumeEvent,
            fence !== undefined ? { fence } : undefined
          );
          // Wait for the run to settle (suspend again, complete, or fail) so the
          // timer is only retired once the wake durably took effect.
          await Promise.race([
            handle.waitForSuspend().catch(() => undefined),
            handle.waitForCompletion().catch(() => undefined),
          ]);
        }
      }
      // Fired — or obsolete (resumed by other means, terminal, unknown): retire it.
      await this.store.complete(executionId, wakeAt);
    } catch (err) {
      // Leave the timer in place; the next poll retries (at-least-once).
      this.onError?.(executionId, err);
    } finally {
      // Ownership covers the fire, not the execution's whole life: by here it has suspended
      // again, completed, or failed, and holding the lease longer would block whoever legitimately
      // wakes it next.
      held?.stop();
      if (leases !== undefined) {
        await leases.store.release(executionId, leases.owner).catch(() => undefined);
      }
    }
  }
}
