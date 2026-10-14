import type { ExecutionState, ScheduleDefinition } from "@loom/core";
import type { EventStore, LeaseStore, TimerRecord, TimerStore } from "@loom/event-runtime";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { type CronSpec, nextOccurrence, parseCron } from "./cron";
import { INBOX_WAKE_AT } from "./inbox";
import { collectGhostLeases, defaultLeaseEvidence, judgeLease } from "./leaseEvidence";
import { LeaseHeldError, LeaseLostError } from "./leaseKeeper";
import { type HeldLease, defaultRenewEvery, renewWhileHeld } from "./leaseRenewal";
import { placementOf } from "./placement";
import type { AbandonedCandidate } from "./recoverAbandoned";
import {
  clearSealedBackoff,
  isSealedBackedOff,
  noteSealedRefusal,
  redriveAbandoned,
  unproductiveRecoveries,
} from "./redriveAbandoned";
import { isSealedUnreadable } from "./sealGuard";
import {
  ExecutionAlreadyExistsError,
  ResumeContendedError,
  ResumeRefusedError,
  StartLeaseHeldError,
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
/** Ghost-lease GC: expired leases examined per pass (ADR 0130 D11, S7d). */
const GHOST_GC_BATCH = 100;
const MAX_WAKE_BACKOFFS = 1024;

/** Cap on a refusal row's `holds` counter (the back-off is capped well before this). */
const MAX_REFUSAL_HOLDS = 16;

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
   * ADR 0130 D10 - the host's abandonment predicate, the SAME one `recoverAbandoned` takes. The poll
   * re-drives a `running` execution that a replay refusal left a wake row for ONLY on evidence of
   * abandonment: this predicate, or (with `leases`) an EXISTING lease that has expired (never an
   * absent lease: no normal driver holds one). With `leases` AND this, both must hold, as in the
   * sweep. With NEITHER the poll keeps the row but cannot prove abandonment, so recovery comes from
   * a configured `recoverAbandoned` sweep.
   */
  isAbandoned?: (candidate: AbandonedCandidate) => boolean | Promise<boolean>;
  /**
   * ADR 0105, applied to the wake-row re-drive too: skip (retire the row, report once) an execution
   * whose last `maxRecoveries` re-drives made no progress. Default: unbounded; the attempt cap
   * (`maxRedriveAttempts`) bounds the poll regardless.
   */
  maxRecoveries?: number;
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
   *
   * ADR 0130 D11 (S7c): when the runtime has a heartbeat keeper (`WorkflowRuntimeDeps.heartbeat`),
   * claiming goes through the KEEPER's store and owner, and this `store`/`owner` are IGNORED (their
   * presence only switches claiming on). A diagnostic must read the keeper's store, not this one.
   * A "ghost lease" start stand-down (`StartLeaseHeldError`) is retried by the CALLER (the next poll),
   * unbounded: a live holder that never writes sequence 0 keeps renewing, so it blocks that schedule
   * head until the holder dies. Accepted (ADR 0130 D11 section 9).
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
  private readonly isAbandoned: TimerServiceOptions["isAbandoned"];
  private readonly maxRecoveries: number | undefined;
  /**
   * ADR 0130 D10 - wake-row re-drives this process has had REFUSED, per execution (bounded, oldest
   * evicted): at `maxRedriveAttempts` the row is retired and reported once. An evicted execution
   * restarts its count, which costs at most a few more attempts - the cap bounds the markers.
   */
  private readonly refusalAttempts = new Map<string, number>();
  /** Lease-store read failures in the refusal re-drive, for the first-then-every-16th report. */
  private evidenceErrors = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /**
   * R8k review 2 — in-process backoff for a plain wake whose fenced resume was contended
   * (`ResumeContendedError`). Keyed by execution id; bounded (oldest evicted). Without it the row
   * stays due and every 250 ms poll takes up to 3 more fence tokens, which can keep invalidating a
   * live holder's token.
   */
  private readonly wakeBackoff = new Map<string, { attempt: number; nextTryAt: number }>();
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
    this.isAbandoned = options.isAbandoned;
    this.maxRecoveries = options.maxRecoveries;
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
        // ADR 0130 D10 - a node that can prove no abandonment (no `isAbandoned`, no lease store) or
        // has no inbox cannot act on a refusal row: it does not fetch them at all, so they can never
        // crowd a real timer out of the batch. (A node that can act reschedules a row it holds to a
        // LATER instant in the store, so a held row is not due again until its back-off passes.)
        ...(!this.canJudgeRefusals() && { refused: false }),
      });
      for (const timer of due) {
        await this.fire(timer.executionId, timer.wakeAt, timer.redrive, timer.refused);
      }
      for (const schedule of this.schedules) {
        await this.fireDueOccurrences(schedule, now);
        this.maybeWarm(schedule, now);
      }
      await this.collectGhosts();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * ADR 0130 D11 (S7d) - garbage-collect GHOST leases (a lease whose holder died before its first
   * append): bounded per pass ({@link GHOST_GC_BATCH} leases examined) and at most once per lease TTL
   * on the keeper's monotonic clock. Never re-drives. A failure is reported (first, then every 16th)
   * and retried next interval: a lease store that errors is the lease store's problem, not a reason to
   * fail the poll.
   */
  private nextGhostGc = Number.NEGATIVE_INFINITY;
  private ghostGcErrors = 0;
  private async collectGhosts(): Promise<void> {
    const keeper = this.runtime.leaseKeeper;
    if (keeper === undefined) return;
    const at = keeper.monotonicNow();
    if (at < this.nextGhostGc) return;
    this.nextGhostGc = at + keeper.ttlMs;
    try {
      await collectGhostLeases(this.runtime, { limit: GHOST_GC_BATCH });
    } catch (err) {
      if (this.ghostGcErrors++ % 16 === 0) this.onError?.("", err);
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
      // ADR 0130 D11: a ghost-leased occurrence is RETRIED (the cursor stays), not skipped.
      if ((await this.startOccurrence(schedule.def, occurrence)) === "retry") return;
      schedule.cursor = occurrence;
    }
  }

  private async startOccurrence(
    def: ScheduleDefinition,
    occurrence: number
  ): Promise<"done" | "retry"> {
    // A2 — the deterministic occurrence id: every node computes the same one,
    // so dedup needs no coordination. `loadState` is the cheap fast path for an
    // occurrence that is visibly started; the raced remainder (two nodes checking
    // before either writes) is refused by `start()` itself with
    // ExecutionAlreadyExistsError BEFORE the loser's body runs (ADR 0103), which
    // is "already started", not an error.
    const executionId = `${def.id}@${occurrence}`;
    try {
      const existing = await this.runtime.loadState(executionId, this.runtime.systemOptions());
      if (existing !== null) return "done"; // already started (this node or another)
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
      if (err instanceof ExecutionAlreadyExistsError) return "done"; // another node won the race
      // ADR 0130 D11: another owner leased the occurrence but wrote no sequence 0 (a ghost, or a start
      // still in flight): nothing was started, so retry on the next poll once the lease is gone.
      if (err instanceof StartLeaseHeldError) return "retry";
      this.onError?.(executionId, err);
    }
    return "done";
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
   * The wake is still needed but could not be served now (the fence stayed contended, or a re-drive
   * failed): keep the row and back off in-process (same schedule and attempt cap as a contended
   * timed wake). At the cap the row is retired and reported as exhausted.
   */
  private async bumpWakeBackoff(executionId: string, wakeAt: number): Promise<void> {
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
  }

  /** Can this node act on a refusal row at all: an inbox, and the sweep's evidence configured. */
  private canJudgeRefusals(): boolean {
    return (
      this.runtime.inboxOn &&
      (this.leases !== undefined ||
        this.isAbandoned !== undefined ||
        // ADR 0130 D11 (S7d/S7e): heartbeat on + a cluster-visible lease store = an expired lease is
        // evidence by default, no host predicate needed.
        defaultLeaseEvidence(this.runtime))
    );
  }

  /**
   * ADR 0130 D10 - a REFUSAL row (`refused: { head }`): a replay refusal on some node left it so a
   * node that CAN open the stream picks the `running` execution up. Only such a row is a re-drive
   * candidate; every other row on a running execution (a contended notify pass, an ambiguous-tail
   * send) takes the ordinary inbox path and is retired. The execution is re-driven only when ALL of:
   *  - this node is not driving it, nor starting it (`drivesLocally`);
   *  - the log head still equals the stamped head (nothing appended since the refusal: a driver
   *    that moved the log makes the row stale and it is retired);
   *  - there is EVIDENCE of abandonment, the sweep's own: the host's `isAbandoned`, or an EXISTING
   *    lease that has expired (an absent lease is not evidence: no normal driver holds one). No
   *    evidence configured -> the node never fetches refusal rows (`due({ refused: false })`), and
   *    recovery comes from a configured sweep;
   *  - the fence is taken CONDITIONALLY on that head (`redriveAbandoned` `ifHeadAt`), so exactly one
   *    contender wins and a driver that appended makes the poll back off;
   *  - the attempt cap (and `maxRecoveries`) has room: the markers a poll appends are bounded.
   * A row this node may not act on yet is HELD by RESCHEDULING it in the store to `wakeAt + back-off(holds + 1)`
   * (the same head, `holds` + 1, a DETERMINISTIC later instant with no node-local jitter, so N pollers
   * write the SAME successor row): it is not due again until then, on any node, so a
   * held row costs no read and cannot crowd a real timer out of `due()`. A sealed refusal backs off
   * on the runtime's shared clock (first-then-every-16th report); the refusal itself wrote the
   * successor row at the new head.
   *
   * The "is this a real timer's key" test runs FIRST, before any hold branch (a hold completes its key).
   *
   * Returns `false` when the row is NOT a refusal row after all (a stamp that landed on a real
   * timer's own `(executionId, wakeAt)` key): the caller then judges it as the ordinary wake it is.
   */
  private async fireRefused(
    executionId: string,
    wakeAt: number,
    refusedIn: { head: number; holds?: number }
  ): Promise<boolean> {
    let refused = refusedIn;
    const stamped = refused.head;
    // Is this execution parked on THIS very wakeAt (a stamp merged onto a real timer's own key)?
    // Judged BEFORE any hold branch: a hold completes the key, which would delete the real timer.
    // A node that is backed off from a sealed execution skips the read (it cannot judge it anyway).
    let state: ExecutionState | null = null;
    let unreadable = isSealedBackedOff(this.runtime, executionId, this.runtime.clock());
    if (!unreadable) {
      try {
        state = await this.runtime.loadState(executionId, this.runtime.systemOptions());
      } catch (err) {
        if (!isSealedUnreadable(err)) {
          this.onError?.(executionId, err);
          await this.failRefusal(executionId, wakeAt, refused);
          return true;
        }
        this.noteSealed(executionId, err);
        unreadable = true;
      }
    }
    if (state !== null && ownsRealTimer(state, wakeAt)) return false;
    if (unreadable || this.runtime.drivesLocally(executionId)) {
      await this.holdRefusal(executionId, wakeAt, refused, state);
      return true;
    }
    // Not running (settled, parked, gone) or the log moved on since the refusal: the row is stale.
    if (state === null || state.status !== "running" || state.sequence !== stamped) {
      if (state?.status === "suspended" && this.runtime.hasInboxWake(state)) {
        await this.store.schedule({ executionId, wakeAt: INBOX_WAKE_AT }); // the ordinary notify path
      }
      await this.store.complete(executionId, wakeAt);
      return true;
    }
    const attempts = this.refusalAttempts.get(executionId) ?? 0;
    const exhausted =
      attempts >= this.maxRedriveAttempts ||
      (this.maxRecoveries !== undefined &&
        (await unproductiveRecoveries(
          this.runtime,
          executionId,
          state.sequence,
          this.maxRecoveries
        )) >= this.maxRecoveries);
    if (exhausted) {
      this.refusalAttempts.delete(executionId);
      this.onError?.(executionId, new RedriveExhaustedError(executionId, attempts));
      await this.store.complete(executionId, wakeAt);
      return true;
    }
    let abandoned: boolean;
    try {
      abandoned = await this.abandonmentEvidence(executionId, state);
    } catch (err) {
      // FAIL CLOSED (D11 section 6): a lease the store would not show is not "no lease". Report it
      // (first, then every 16th), keep the row, spend none of its attempts, re-drive nothing.
      if (this.evidenceErrors++ % 16 === 0) this.onError?.(executionId, err);
      await this.holdRefusal(executionId, wakeAt, refused, state);
      return true;
    }
    if (!abandoned) {
      await this.holdRefusal(executionId, wakeAt, refused, state);
      return true;
    }
    const leases = this.leases;
    let held: HeldLease | undefined;
    // ADR 0130 D11 (S7c): a runtime with a heartbeat keeper claims through it (one timer, shared
    // owner); the keeper's claim is a reference-counted hold released in the `finally`. S7d: every
    // keeper runtime claims (an expired lease is acquirable by exactly one poller), not only one with
    // an explicit `leases` option.
    let hold: { release(): Promise<void> } | undefined;
    if (this.runtime.leaseKeeper !== undefined) {
      let got: Awaited<ReturnType<typeof this.runtime.acquireDriverLease>>;
      try {
        got = await this.runtime.acquireDriverLease(executionId);
      } catch (err) {
        // FAIL CLOSED, like the judge read above (D11 section 6): a keeper that cannot confirm the
        // lease (an acquire error, or the quiet period after one) is not "free", and must never
        // reject the whole poll. Report (first, then every 16th), keep the row, spend no attempt.
        if (this.evidenceErrors++ % 16 === 0) this.onError?.(executionId, err);
        await this.holdRefusal(executionId, wakeAt, refused, state);
        return true;
      }
      if (got === null) {
        await this.holdRefusal(executionId, wakeAt, refused, state);
        return true;
      }
      hold = got;
    } else if (leases !== undefined) {
      // Claim it (an expired lease is acquirable by anyone): two pollers do not both pay for it.
      const lease = await leases.store.acquire(executionId, leases.owner, this.leaseTtlMs);
      if (lease === null) {
        await this.holdRefusal(executionId, wakeAt, refused, state);
        return true;
      }
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
      this.noteRefusalAttempt(executionId);
      const r = await redriveAbandoned(this.runtime, executionId, {
        source: "wake",
        fenced: this.fenced,
        ifHeadAt: stamped,
        // D11 section 4 step 4: with heartbeat leases the takeover is conditional on the head.
        ...(this.runtime.leaseKeeper !== undefined && {
          conditional: true,
          // A won claim moved the head by one (its marker): re-stamp the row so a failure or crash
          // from here retries it, rather than the next fire seeing head+1 != stamp and retiring it.
          onClaimed: async (newHead: number) => {
            refused = { ...refused, head: newHead };
            await this.store.schedule({ executionId, wakeAt, refused });
          },
        }),
      });
      if (r.outcome === "refused") {
        this.noteSealed(executionId, r.error);
        await this.holdRefusal(executionId, wakeAt, refused, state);
        return true;
      }
      if (r.outcome === "skipped") {
        // lost the conditional fence, or it changed under us: not an attempt, the next poll decides
        this.refusalAttempts.set(executionId, Math.max(0, attempts));
        return true;
      }
      clearSealedBackoff(this.runtime, executionId);
      this.refusalAttempts.delete(executionId);
      const after = await this.runtime.loadState(executionId, this.runtime.systemOptions());
      if (after === null || after.status === "running") return true; // still being driven: the row goes stale
      if (this.runtime.hasInboxWake(after)) await this.fireInbox(executionId, wakeAt);
      else await this.store.complete(executionId, wakeAt);
    } catch (err) {
      if (isSealedUnreadable(err)) {
        this.noteSealed(executionId, err);
        await this.holdRefusal(executionId, wakeAt, refused, state);
        return true;
      }
      this.onError?.(executionId, err);
      await this.failRefusal(executionId, wakeAt, refused);
    } finally {
      held?.stop();
      await hold?.release();
    }
    return true;
  }

  /**
   * A refusal row's judgement THREW (a store error, a failed re-drive): count it against the attempt
   * cap, then either retire + report once, or reschedule it with the re-drive back-off.
   */
  private async failRefusal(
    executionId: string,
    wakeAt: number,
    refused: { head: number; holds?: number }
  ): Promise<void> {
    this.noteRefusalAttempt(executionId);
    if ((this.refusalAttempts.get(executionId) ?? 0) >= this.maxRedriveAttempts) {
      this.refusalAttempts.delete(executionId);
      this.onError?.(executionId, new RedriveExhaustedError(executionId, this.maxRedriveAttempts));
      await this.store.complete(executionId, wakeAt);
      return;
    }
    await this.holdRefusal(executionId, wakeAt, refused);
  }

  private noteRefusalAttempt(executionId: string): void {
    const n = (this.refusalAttempts.get(executionId) ?? 0) + 1;
    this.refusalAttempts.delete(executionId); // re-insert at the end: eviction order = recency
    if (this.refusalAttempts.size >= MAX_WAKE_BACKOFFS) {
      const oldest = this.refusalAttempts.keys().next().value;
      if (oldest !== undefined) this.refusalAttempts.delete(oldest);
    }
    this.refusalAttempts.set(executionId, n);
  }

  /**
   * The evidence a refusal row's re-drive needs (ADR 0130 D10 + D11 section 4). In order:
   *
   *  1. VETO: an unexpired heartbeat lease (a driver that said it is alive inside the TTL) beats every
   *     heuristic, `isAbandoned` included: never superseded.
   *  2. LEASE EVIDENCE: an EXPIRED lease whose owner's leases are true evidence is abandonment, with no
   *     host predicate needed, when it is trustworthy: either the host opted in with `leases` (the
   *     sweep's contract), or this node runs heartbeat in `"stop"` mode over a cluster-visible store
   *     (the default re-drive). `isAbandoned`, when also configured, still narrows it (both must hold).
   *  3. HEURISTIC: no usable lease evidence (an absent lease, a `"continue"` owner's expired lease, a
   *     store that is not cluster-visible): only the host's `isAbandoned` re-drives, as before S7. An
   *     absent lease with an explicit `leases` option is no evidence at all (the S6 rule).
   *  4. QUIET: right after a lease-store outage an expired lease is not acted on for one TTL.
   *
   * Throws {@link LeaseEvidenceError} when a store errors: the caller fails closed.
   */
  private async abandonmentEvidence(executionId: string, state: ExecutionState): Promise<boolean> {
    const explicit = this.leases;
    const j = await judgeLease(this.runtime, executionId, explicit?.store);
    if (j.kind === "live" || j.kind === "quiet") return false;
    const defaultOn = defaultLeaseEvidence(this.runtime);
    const leaseEvidence = j.kind === "expired" && (explicit !== undefined || defaultOn);
    if (explicit !== undefined && j.kind === "absent") return false; // an ABSENT lease is no evidence
    if (!leaseEvidence && this.isAbandoned === undefined) return false;
    if (this.isAbandoned === undefined) return true;
    return this.isAbandoned({
      executionId,
      workflowId: state.workflowId,
      status: state.status,
      updatedAt: state.updatedAt,
      startedAt: state.startedAt,
      sequence: state.sequence,
    });
  }

  /**
   * Hold a refusal row we may not act on yet: write the SAME stamp (`holds` + 1) at a later instant,
   * then retire the row we read. Schedule-then-complete, so a crash in between leaves two idempotent
   * rows rather than none.
   *
   * The successor's key is a DETERMINISTIC function of the row we read: `wakeAt + back-off(holds + 1)`
   * with NO jitter (the back-off's ceiling, capped). N pollers on N nodes that read the same row
   * therefore upsert the SAME successor, and the blind `complete` of the old row is idempotent: rows
   * never multiply per generation (a node-local jittered instant gave each poller its own row).
   *
   * Defence in depth: never touch a key a real timer owns (the caller already routes such a row to
   * the ordinary timer path; `state` is what it read, absent when the state was unreadable here).
   */
  private async holdRefusal(
    executionId: string,
    wakeAt: number,
    refused: { head: number; holds?: number },
    state: ExecutionState | null = null
  ): Promise<void> {
    if (state !== null && ownsRealTimer(state, wakeAt)) return;
    const holds = Math.min((refused.holds ?? 0) + 1, MAX_REFUSAL_HOLDS);
    // `random: () => 1` is the ceiling of the full-jitter draw: the deterministic end of the schedule.
    const delay = Math.max(1, redriveDelayMs(holds, { ...this.redriveBackoff, random: () => 1 }));
    await this.store.schedule({
      executionId,
      wakeAt: wakeAt + delay,
      refused: { head: refused.head, holds },
    });
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
    const contended = (): Promise<void> => this.bumpWakeBackoff(executionId, wakeAt);
    try {
      for (let round = 0; round < 8; round++) {
        const r = await this.runtime.notifyInboxDetailed(executionId);
        if (r.contended) return contended();
        if (r.handle === undefined) break;
        await settle(r.handle);
      }
      clearSealedBackoff(this.runtime, executionId);
      this.wakeBackoff.delete(executionId);
      await this.store.complete(executionId, wakeAt);
      // After retiring the row, look once more: a send that found the row present skipped writing
      // another, so a message that landed between the last read and the retire is delivered here.
      await this.lastLook(executionId, wakeAt, settle);
    } catch (err) {
      if (!isSealedUnreadable(err)) throw err;
      // ADR 0130: the head message is sealed and this node cannot open it. Keep the row (a capable
      // node needs it) but stop hammering: exponential back-off with no attempt cap, and report
      // the first refusal and then only every 16th, not every poll.
      this.noteSealed(executionId, err);
      // The row was retired only if the throw came from the post-retire look: re-write it.
      await this.store.schedule({ executionId, wakeAt });
    }
  }

  /**
   * ADR 0130 - this node cannot open what the wake needs. Keep the row (a capable node needs it)
   * but stop hammering: exponential back-off with no attempt cap, and report the first refusal and
   * then only every 16th, not every poll.
   */
  private noteSealed(executionId: string, err: Error): void {
    // The back-off is shared with `recoverAbandoned` (per runtime): a refusal seen by either path
    // suppresses the other for the window.
    if (
      noteSealedRefusal(this.runtime, executionId, this.runtime.clock(), (attempt) =>
        redriveDelayMs(attempt, this.redriveBackoff)
      )
    ) {
      this.onError?.(executionId, err);
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
    redrive?: { attempt: number },
    refused?: { head: number; holds?: number }
  ): Promise<void> {
    // ADR 0130 D10 - a replay-refusal row is judged on EVIDENCE, before any lease is claimed: acquiring
    // the lease first would erase the very thing (an existing, expired lease) that proves abandonment.
    if (redrive === undefined && refused !== undefined) {
      // A node that cannot judge it (flag-off, or no evidence configured; a store that ignored
      // `due({ refused: false })`) must not retire it as obsolete: a node that can still needs it.
      if (!this.canJudgeRefusals()) return;
      if (await this.fireRefused(executionId, wakeAt, refused)) return;
      // else: the stamp sits on a real timer's own row; fall through and judge it as the timer
    }
    // #380 — claim the execution before waking it. `null` means another node holds it and is
    // presumably firing this same timer; skip WITHOUT completing it, so a wake is never lost
    // if that node dies between the claim and the resume. Its lease expires; we try again.
    const leases = this.leases;
    let held: HeldLease | undefined;
    let hold: { release(): Promise<void> } | undefined;
    if (leases !== undefined && this.runtime.leaseKeeper !== undefined) {
      // ADR 0130 D11 (S7c): claim through the runtime's heartbeat keeper (see `fireRefused`).
      const got = await this.runtime.acquireDriverLease(executionId);
      if (got === null) return;
      hold = got;
    } else if (leases !== undefined) {
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
      if (isSealedBackedOff(this.runtime, executionId, this.runtime.clock())) return; // ADR 0130 (shared w/ the sweep, ONE clock: the runtime's)
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
          // ADR 0130 D11 (S7c): the fence is taken while this poller STILL holds the claim: an
          // unconditional acquire with no lease would fence out a node that leased and began driving
          // in the gap. Only then is the claim released - the WORKER is the driver and takes its own
          // lease (possibly under another owner), which this poller's claim must not block.
          const fence = this.fenced
            ? await this.runtime.acquireFence(executionId, this.runtime.systemOptions())
            : undefined;
          if (hold !== undefined) {
            await hold.release();
            hold = undefined;
          }
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
          const settled = await Promise.race([
            handle.waitForSuspend().then(
              () => undefined,
              (e: unknown) => e
            ),
            handle.waitForCompletion().then(
              () => undefined,
              (e: unknown) => e
            ),
          ]);
          // ADR 0130 D11: the lease was lost before the wake took durable effect (it may never have
          // landed): the row STAYS, and the next poll judges it against the log (a wake that did land
          // finds its park answered and retires as obsolete).
          if (settled instanceof LeaseLostError) return;
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
      // ADR 0130 residuals D7 - a stream this node cannot open: leave the row for a capable node,
      // back off, and report first-then-every-16th (not every poll).
      if (isSealedUnreadable(err)) {
        this.noteSealed(executionId, err);
        return;
      }
      // ADR 0130 D11: another live owner holds the lease - quiet, the row stays for the next poll.
      if (err instanceof LeaseHeldError) return;
      // Leave the timer in place; the next poll retries (at-least-once).
      this.onError?.(executionId, err);
    } finally {
      // Ownership covers the fire, not the execution's whole life: by here it has suspended
      // again, completed, or failed, and holding the lease longer would block whoever legitimately
      // wakes it next.
      held?.stop();
      if (hold !== undefined) await hold.release();
      else if (leases !== undefined) {
        await leases.store.release(executionId, leases.owner).catch(() => undefined);
      }
    }
  }
}

/** Is `state` parked on a REAL timer at `wakeAt` (the park's own, or one arm of a multi-wait)? */
function ownsRealTimer(state: ExecutionState, wakeAt: number): boolean {
  return (
    state.status === "suspended" &&
    (state.suspendedOn?.wakeAt === wakeAt || pendingTimerWait(state, wakeAt) !== undefined)
  );
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
