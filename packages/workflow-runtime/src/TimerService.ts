import type { ScheduleDefinition } from "@loom/core";
import type { EventStore, LeaseStore, TimerRecord, TimerStore } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { type CronSpec, nextOccurrence, parseCron } from "./cron";
import { INBOX_WAKE_AT } from "./inbox";
import { type HeldLease, defaultRenewEvery, renewWhileHeld } from "./leaseRenewal";
import { placementOf } from "./placement";
import {
  ExecutionAlreadyExistsError,
  ResumeContendedError,
  ResumeRefusedError,
  SealedPayloadUnreadableError,
  TIMER_FIRED,
} from "./types";

/**
 * ADR 0118 D4 — what a registered re-driver answers for one re-drive row.
 *
 *  - `"done"` — it re-derived its resume from the log and the resume took effect;
 *  - `"noop"` — nothing for it to do (the park is answered, or the execution is not its concern);
 *  - `"contended"` — the resume hit {@link ResumeContendedError} again: back off and try later.
 */
export type RedriveVerdict = "done" | "noop" | "contended";

/**
 * A re-driver is registered by whatever writes re-drive rows (the supervisor's resume path, the
 * inbox notify path). It MUST re-derive the work from the log — the row carries only the execution
 * id and the attempt — so it is idempotent: a crash between its resume and the row's completion
 * re-delivers, and the answered park makes the second delivery a `"noop"`.
 */
export type Redriver = (executionId: string, info: { attempt: number }) => Promise<RedriveVerdict>;

/** Backoff for a re-drive row (ADR 0118 D4): exponential, full jitter, capped. */
export interface RedriveBackoff {
  /** The ceiling of the first delay, in ms. Default 200. */
  baseMs?: number;
  /** The cap of one delay, in ms. Default 30 000. */
  capMs?: number;
  /** Jitter source in [0, 1) — inject a seeded one for deterministic simulation. Default `Math.random`. */
  random?: () => number;
}

/** Bound on the in-process contended-wake backoff map. */
const MAX_WAKE_BACKOFFS = 1024;

/** Attempts a contended resume is re-driven before the service gives up (ADR 0118 D4). */
export const DEFAULT_MAX_REDRIVE_ATTEMPTS = 8;

/**
 * The delay before re-drive attempt `attempt` (0-based): `random() * min(cap, base * 2^attempt)` —
 * exponential with FULL jitter, so rivals that contended at the same instant do not retry in step.
 */
export function redriveDelayMs(attempt: number, backoff: RedriveBackoff = {}): number {
  const base = backoff.baseMs ?? 200;
  const cap = backoff.capMs ?? 30_000;
  const random = backoff.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

/**
 * Write the due-later row that re-drives a contended resume (ADR 0118 D4): `attempt` is the try
 * the row will make when it fires, its `wakeAt` is `now` plus the backoff for that attempt.
 * Idempotent per `(executionId, wakeAt)` (the store upserts, never downgrading the flag).
 */
export async function scheduleRedrive(
  store: TimerStore,
  executionId: string,
  attempt: number,
  now: number,
  backoff: RedriveBackoff = {},
  /**
   * The earliest `wakeAt` the row may take. A row written by the service for the NEXT attempt
   * passes `firedWakeAt + 1`: with a zero jitter draw `now + delay` can equal the row that is about
   * to be `complete`d, and a row with the same `(executionId, wakeAt)` is the SAME row — it would
   * be upserted and then deleted, losing the re-drive.
   */
  minWakeAt?: number
): Promise<TimerRecord> {
  const row: TimerRecord = {
    executionId,
    wakeAt: Math.max(now + redriveDelayMs(attempt, backoff), minWakeAt ?? Number.MIN_SAFE_INTEGER),
    redrive: { attempt },
  };
  await store.schedule(row);
  return row;
}

/** What `onError` receives, once, when a contended resume exhausts its re-drive attempts. */
export class RedriveExhaustedError extends Error {
  constructor(
    readonly executionId: string,
    readonly attempts: number
  ) {
    super(
      `execution "${executionId}" is still contended after ${attempts} re-drive attempts; leaving it to recover()`
    );
    this.name = "RedriveExhaustedError";
    Object.setPrototypeOf(this, RedriveExhaustedError.prototype);
  }
}

export interface TimerServiceOptions {
  /** Poll cadence for due timers, in ms. Default 250. */
  pollMs?: number;
  /** Max due timers fired per poll. Default 100. */
  batch?: number;
  /** Observability hook for a failed fire (the timer is retried next poll). */
  onError?: (executionId: string, err: unknown) => void;
  /**
   * ADR 0118 D4 — re-drivers for RE-DRIVE rows (`TimerRecord.redrive`), registered up front;
   * `registerRedriver` adds more later (what `superviseChildren({ redrive })` does). A re-drive row
   * is NOT judged by `suspendedOn.wakeAt`: it is handed to each redriver in turn.
   */
  redrivers?: Redriver[];
  /** Re-drive attempts before giving up (`onError` once, then left to `recover()`). Default 8. */
  maxRedriveAttempts?: number;
  /** Backoff for the NEXT re-drive row of a still-contended execution. Default 200 ms base, 30 s cap. */
  redriveBackoff?: RedriveBackoff;
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
   * and is the default `now` for interval-driven ticks. Default: the runtime's own
   * clock (`runtime.clock`, i.e. `WorkflowRuntimeDeps.now`), because `ctx.sleep` and
   * `suspend({ timeout })` compute their `wakeAt` with that clock and this service
   * judges it due. One simulated clock therefore needs to be given to the runtime only.
   * `sleepUntil(absolute)` targets and cron occurrences are measured on this timeline
   * (the runtime's `now`), not wall time.
   * An explicit override that disagrees with the runtime's clock is honoured, but then
   * `wakeAt` (runtime clock) is compared with a different timeline: timers fire early
   * when this clock runs ahead of the runtime's, and never when it runs behind.
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
      resumeEvent: { eventType: string; payload: unknown; waitId?: string };
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
  private readonly redrivers: Redriver[];
  private readonly maxRedriveAttempts: number;
  private readonly redriveBackoff: RedriveBackoff;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /**
   * R8k review 2 — in-process backoff for a plain wake whose fenced resume was contended
   * (`ResumeContendedError`). Keyed by execution id; bounded (oldest evicted). Without it the row
   * stays due and every 250 ms poll takes up to 3 more fence tokens, which can keep invalidating a
   * live holder's token.
   */
  private readonly wakeBackoff = new Map<string, { attempt: number; nextTryAt: number }>();
  /**
   * ADR 0130 — back-off for an inbox wake row whose head message is sealed and NOT openable on this
   * node. Separate from `wakeBackoff` because it must NEVER retire the row (no attempt cap): a node
   * that can open the message still needs it. Bounded (oldest evicted).
   */
  private readonly sealedBackoff = new Map<string, { attempt: number; nextTryAt: number }>();
  /** Retries per chain of a D10a expiry row whose owner was running (bounded like `wakeBackoff`). */
  private readonly expiryBackoff = new Map<string, number>();
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
    this.redrivers = [...(options.redrivers ?? [])];
    this.maxRedriveAttempts = options.maxRedriveAttempts ?? DEFAULT_MAX_REDRIVE_ATTEMPTS;
    this.redriveBackoff = options.redriveBackoff ?? {};
    this.warmLeadMs = options.warmLeadMs ?? 0;
    this.now = options.now ?? runtime.clock;
    // Cron cursors start at construction time: no catch-up of occurrences that
    // passed while nothing was running (documented; a durable catch-up policy
    // can layer on later without changing the firing contract).
    const floor = this.now();
    this.schedules = (options.schedules ?? []).map((def) => ({
      def,
      spec: parseCron(def.cron, def.timeZone),
      cursor: floor,
    }));
  }

  /**
   * ADR 0118 D4 — register a re-driver for RE-DRIVE rows. Returns the unregister function.
   * Registering the same function twice is a no-op.
   */
  registerRedriver(redriver: Redriver): () => void {
    if (!this.redrivers.includes(redriver)) this.redrivers.push(redriver);
    return () => {
      const i = this.redrivers.indexOf(redriver);
      if (i >= 0) this.redrivers.splice(i, 1);
    };
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
      // A node with no re-driver cannot judge a re-drive row: ask the store to leave them out BEFORE
      // the batch limit, or a batch of them starves every plain wake behind it.
      const due = await this.store.due(now, this.batch, {
        ...(this.redrivers.length === 0 && { redrive: false }),
        // Likewise a flag-off node: inbox rows sort first (instant 0) and it cannot judge them.
        ...(!this.runtime.inboxOn && { inbox: false }),
      });
      for (const timer of due) {
        await this.fire(timer.executionId, timer.wakeAt, timer.redrive);
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
      const existing = await this.runtime.loadState(executionId, this.runtime.systemOptions());
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
      const handle = await this.runtime.start(flow, def.input, {
        executionId,
        ...this.runtime.systemOptions(),
      });
      await Promise.race([
        handle.waitForSuspend().catch(() => undefined),
        handle.waitForCompletion().catch(() => undefined),
      ]);
    } catch (err) {
      if (err instanceof ExecutionAlreadyExistsError) return; // another node won the race
      this.onError?.(executionId, err);
    }
  }

  /**
   * Run the registered re-drivers for one re-drive row. `done` / `noop` retires the row. A
   * `contended` verdict (or a re-driver that threw) writes the NEXT row — with a larger backoff —
   * BEFORE retiring this one, so a crash in between leaves two idempotent rows rather than none;
   * once `maxRedriveAttempts` rows have fired, `onError` is called ONCE and the row retired, leaving
   * the execution to `recover()`.
   */
  private async fireRedrive(executionId: string, wakeAt: number, attempt: number): Promise<void> {
    // A node that registered no re-driver cannot judge this row, and the store is shared: leave it
    // for one that can, rather than retire it (a retired row is a silent loss of the re-drive).
    if (this.redrivers.length === 0) return;
    let verdict: RedriveVerdict = "noop";
    for (const redriver of [...this.redrivers]) {
      let v: RedriveVerdict;
      try {
        v = await redriver(executionId, { attempt });
      } catch {
        v = "contended"; // a failed re-drive is retried on the same schedule, not silently dropped
      }
      if (v !== "noop") {
        verdict = v;
        break;
      }
    }
    if (verdict === "contended") {
      const next = attempt + 1;
      if (next >= this.maxRedriveAttempts) {
        this.onError?.(executionId, new RedriveExhaustedError(executionId, next));
      } else {
        await scheduleRedrive(
          this.store,
          executionId,
          next,
          this.now(),
          this.redriveBackoff,
          wakeAt + 1
        );
      }
    }
    await this.store.complete(executionId, wakeAt);
  }

  /**
   * ADR 0110 D5 — fire an inbox wake row. The row is retired only AFTER the notify path ran, and the
   * park is looked at once more afterwards: a send that found the row already present skipped
   * writing another, so a message that landed between the notify read and the retire would be
   * stranded; the re-check closes it (a later send finds no row and writes one).
   */
  private async fireInbox(executionId: string, wakeAt: number): Promise<void> {
    const settle = async (h: {
      waitForSuspend(): Promise<unknown>;
      waitForCompletion(): Promise<unknown>;
    }) => {
      await Promise.race([
        h.waitForSuspend().catch(() => undefined),
        h.waitForCompletion().catch(() => undefined),
      ]);
    };
    const contended = async (): Promise<void> => {
      // The park is still unanswered but the fence stayed contended: keep the row, back off
      // in-process (same schedule and attempt cap as a contended timed wake).
      const attempt = (this.wakeBackoff.get(executionId)?.attempt ?? 0) + 1;
      if (attempt >= this.maxRedriveAttempts) {
        this.wakeBackoff.delete(executionId);
        this.onError?.(executionId, new RedriveExhaustedError(executionId, attempt));
        await this.store.complete(executionId, wakeAt);
        return;
      }
      this.wakeBackoff.set(executionId, {
        attempt,
        nextTryAt: this.now() + Math.max(1, redriveDelayMs(attempt, this.redriveBackoff)),
      });
    };
    try {
      for (let round = 0; round < 8; round++) {
        const r = await this.runtime.notifyInboxDetailed(executionId);
        if (r.contended) return contended();
        if (r.handle === undefined) break;
        await settle(r.handle);
      }
      this.sealedBackoff.delete(executionId);
      this.wakeBackoff.delete(executionId);
      await this.store.complete(executionId, wakeAt);
      // After retiring the row, look once more: a send that found the row present skipped writing
      // another, so a message that landed between the last read and the retire is delivered here.
      await this.lastLook(executionId, wakeAt, settle);
    } catch (err) {
      if (!(err instanceof SealedPayloadUnreadableError)) throw err;
      // ADR 0130: the head message is sealed and this node cannot open it. Keep the row (a capable
      // node needs it) but stop hammering: exponential back-off with no attempt cap, and report
      // the first refusal and then only every 16th, not every poll.
      const attempt = (this.sealedBackoff.get(executionId)?.attempt ?? 0) + 1;
      this.sealedBackoff.delete(executionId); // re-insert at the end: eviction order = recency
      if (this.sealedBackoff.size >= MAX_WAKE_BACKOFFS) {
        const oldest = this.sealedBackoff.keys().next().value;
        if (oldest !== undefined) this.sealedBackoff.delete(oldest);
      }
      this.sealedBackoff.set(executionId, {
        attempt,
        nextTryAt: this.now() + Math.max(1, redriveDelayMs(attempt, this.redriveBackoff)),
      });
      if (attempt === 1 || attempt % 16 === 0) this.onError?.(executionId, err);
      // The row was retired only if the throw came from the post-retire look: re-write it.
      await this.store.schedule({ executionId, wakeAt });
    }
  }

  private async lastLook(
    executionId: string,
    wakeAt: number,
    settle: (h: {
      waitForSuspend(): Promise<unknown>;
      waitForCompletion(): Promise<unknown>;
    }) => Promise<void>
  ): Promise<void> {
    const last = await this.runtime.notifyInboxDetailed(executionId);
    if (last.contended) {
      await this.store.schedule({ executionId, wakeAt });
      return;
    }
    if (last.handle !== undefined) await settle(last.handle);
  }

  /**
   * ADR 0110 D10a - write the NEXT expiry row of a chain whose owner could not take the pass yet
   * (running, or its fence contended). Never reported as exhausted: a long turn is not a failure.
   * The delay grows with this process's retries of the chain, capped like any re-drive, and the
   * per-chain counter is bounded (oldest evicted). `after` is the row being retired: the new one is
   * strictly later, since a row at the same `(executionId, wakeAt)` would be the SAME row.
   */
  private async rearmExpiry(executionId: string, after: number): Promise<void> {
    const attempt = (this.expiryBackoff.get(executionId) ?? 0) + 1;
    this.expiryBackoff.delete(executionId); // re-insert at the end: eviction order = recency
    if (this.expiryBackoff.size >= MAX_WAKE_BACKOFFS) {
      const oldest = this.expiryBackoff.keys().next().value;
      if (oldest !== undefined) this.expiryBackoff.delete(oldest);
    }
    this.expiryBackoff.set(executionId, attempt);
    await this.store.schedule({
      executionId,
      wakeAt: Math.max(
        this.now() + Math.max(1, redriveDelayMs(attempt, this.redriveBackoff)),
        after + 1
      ),
    });
  }

  private async fire(
    executionId: string,
    wakeAt: number,
    redrive?: { attempt: number }
  ): Promise<void> {
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
      // ADR 0118 D4 — a RE-DRIVE row is not the wake of a timed suspend: judging it by
      // `suspendedOn.wakeAt` would retire it as obsolete. It runs under the same lease claim.
      if (redrive !== undefined) {
        await this.fireRedrive(executionId, wakeAt, redrive.attempt);
        return;
      }
      const backoff = this.wakeBackoff.get(executionId);
      if (backoff !== undefined && backoff.nextTryAt > this.now()) return; // backing off: no acquire
      const sealedOff = this.sealedBackoff.get(executionId);
      if (sealedOff !== undefined && sealedOff.nextTryAt > this.now()) return; // ADR 0130
      const state = await this.runtime.loadState(executionId, this.runtime.systemOptions());
      // ADR 0110 D5 — the inbox wake row: run the notify path (read past the cursors, consume,
      // resume), then re-check after retiring the row so a send that coalesced into it just before
      // is never stranded.
      // (INBOX_WAKE_AT is -1, an instant no timed park uses, so `ctx.sleepUntil(0)` is a plain timed wake.)
      if (wakeAt === INBOX_WAKE_AT && state?.suspendedOn?.wakeAt !== INBOX_WAKE_AT) {
        // A node with the inbox flag OFF cannot run the notify path, and must not retire the row as
        // obsolete: a node with it on (a mixed fleet mid-rollout) still needs it. Leave it be.
        if (!this.runtime.inboxOn) return;
        await this.fireInbox(executionId, wakeAt);
        return;
      }
      // ADR 0110 D4 — a TIMER ARM of a multi-wait park: addressed to its wait, still pending only
      // while that wait is listed and unanswered (a stale fire for a settled arm is obsolete).
      const armWaitId =
        state !== null && state.status === "suspended"
          ? pendingTimerWait(state, wakeAt)
          : undefined;
      const stillWaiting =
        armWaitId !== undefined ||
        (state !== null && state.status === "suspended" && state.suspendedOn?.wakeAt === wakeAt);
      // ADR 0110 amendment, D10a — a row that is no timer of the park may be an inbox EXPIRY row
      // (written by `send` for a topic with a TTL, re-armed by each pass): run the pass. A running
      // owner cannot take the discard yet, so a row with something still to expire is RE-ARMED
      // DURABLY (the next row at a later instant, then this one retired - like a re-drive), never
      // left at the head of `due()` where it would starve every real timer behind it. A row with
      // nothing TTL'd pending (an obsolete plain timer of a now-running owner, say) is retired the
      // ordinary way below, as is a finished chain or a node with no TTL configured.
      if (!stillWaiting && this.runtime.inboxTtlOn) {
        const r = await this.runtime.expireInbox(executionId);
        if ((r.status === "not-parked" || r.status === "contended") && r.pending === true) {
          await this.rearmExpiry(executionId, wakeAt);
          await this.store.complete(executionId, wakeAt);
          return;
        }
        this.expiryBackoff.delete(executionId);
      }
      if (stillWaiting && state !== null) {
        const resumeEvent: { eventType: string; payload: unknown; waitId?: string } = {
          eventType: TIMER_FIRED,
          payload: { wakeAt },
          ...(armWaitId !== undefined && { waitId: armWaitId }),
        };

        if (this.dispatcher !== undefined) {
          // K9.4 — in fenced deployments, acquire a newer token first so a
          // duplicate cross-node fire loses at the store instead of double-writing.
          // (ADR 0118 as-built: this path keeps the UNCONDITIONAL acquire — the worker SPI's
          // `allocate` acquires its own token per dispatch, so a conditional fence here would
          // need a `WorkerRequest` extension; a named follow-up.)
          const fence = this.fenced
            ? await this.runtime.acquireFence(executionId, this.runtime.systemOptions())
            : undefined;
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
          // ADR 0118 D2 — in a fenced deployment the wake takes its fence as an acquire-IF-PARKED
          // on THIS park: a park also answered externally (an approval, a child's result) no longer
          // lets the timer supersede the holder of the body that answer started. A park that is no
          // longer the unanswered one is OBSOLETE (retired below); a fence the runtime could not
          // take after its bounded retries (`ResumeContendedError`) leaves the row for the next
          // poll, exactly like any other failed fire.
          let fenceIfParkedAt: number | undefined;
          if (this.fenced) {
            fenceIfParkedAt = await this.runtime.parkedAtSequence(
              executionId,
              this.runtime.systemOptions()
            );
          }
          if (this.fenced && fenceIfParkedAt === undefined) {
            await this.store.complete(executionId, wakeAt); // no unanswered park: obsolete
            return;
          }
          let handle: Awaited<ReturnType<WorkflowRuntime["resume"]>>;
          try {
            handle = await this.runtime.resume(executionId, resumeEvent, {
              ...(fenceIfParkedAt !== undefined && { fenceIfParkedAt }),
              ...this.runtime.systemOptions(),
            });
          } catch (err) {
            if (err instanceof ResumeRefusedError && err.reason === "not-suspended") {
              await this.store.complete(executionId, wakeAt); // answered meanwhile: obsolete
              return;
            }
            if (err instanceof ResumeContendedError) {
              // A re-drive row would be handed to the supervisor's re-drivers, which re-derive THEIR
              // resume and answer "noop" for a timer wake — the wake would be lost. So the bounded
              // backoff (same schedule + attempt cap as D4) runs in-process, and the row stays.
              const attempt = (this.wakeBackoff.get(executionId)?.attempt ?? 0) + 1;
              if (attempt >= this.maxRedriveAttempts) {
                this.wakeBackoff.delete(executionId);
                this.onError?.(executionId, new RedriveExhaustedError(executionId, attempt));
                await this.store.complete(executionId, wakeAt);
                return;
              }
              this.wakeBackoff.delete(executionId); // re-insert at the end: eviction order = recency
              if (this.wakeBackoff.size >= MAX_WAKE_BACKOFFS) {
                const oldest = this.wakeBackoff.keys().next().value;
                if (oldest !== undefined) this.wakeBackoff.delete(oldest);
              }
              this.wakeBackoff.set(executionId, {
                attempt,
                nextTryAt: this.now() + Math.max(1, redriveDelayMs(attempt, this.redriveBackoff)),
              });
              return;
            }
            throw err;
          }
          this.wakeBackoff.delete(executionId);
          // Wait for the run to settle (suspend again, complete, or fail) so the
          // timer is only retired once the wake durably took effect.
          await Promise.race([
            handle.waitForSuspend().catch(() => undefined),
            handle.waitForCompletion().catch(() => undefined),
          ]);
        }
      }
      // Fired — or obsolete (resumed by other means, terminal, unknown): retire it.
      this.wakeBackoff.delete(executionId);
      // ADR 0110 D10a - an expiry row and a real timer on the SAME instant are one row (keyed by
      // `(executionId, wakeAt)`, expiry rows land on whole seconds, as does `ctx.sleepUntil(W)`).
      // Retiring it here would silently drop the expiry, so a fired timer also runs the pass for its
      // chain: it re-arms any later expiry itself. Before the retire, so a failure leaves the row.
      if (stillWaiting && this.runtime.inboxTtlOn) {
        const r = await this.runtime.expireInbox(executionId);
        if ((r.status === "not-parked" || r.status === "contended") && r.pending === true) {
          await this.rearmExpiry(executionId, wakeAt);
        }
      }
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

/**
 * The waitId of the UNANSWERED timer arm of `state`'s park whose recorded wake is `wakeAt`
 * (ADR 0110 D4). Total: a malformed entry is skipped.
 */
function pendingTimerWait(
  state: { suspendedOn?: { waits?: unknown }; variables: Record<string, unknown> },
  wakeAt: number
): string | undefined {
  const waits = state.suspendedOn?.waits;
  if (!Array.isArray(waits)) return undefined;
  const answers = state.variables._waitAnswers as Record<string, unknown> | undefined;
  for (const w of waits as Array<{ waitId?: unknown; kind?: unknown; wakeAt?: unknown }>) {
    if (w === null || typeof w !== "object") continue;
    if (w.kind !== "timer" || w.wakeAt !== wakeAt || typeof w.waitId !== "string") continue;
    if (answers !== undefined && Object.hasOwn(answers, w.waitId)) continue;
    return w.waitId;
  }
  return undefined;
}
