import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { EvalLimits, EvalOutcome } from "./evalCore";
import {
  RUN_EVALUATING,
  RUN_FINISHED,
  STATUS_BYTES,
  STATUS_RUN_ID_INDEX,
  STATUS_STARTED_AT_OFFSET,
  STATUS_STATE_INDEX,
} from "./workerProtocol";
import type { FromWorker, ToWorker } from "./workerProtocol";

// ── ADR 0089 — moving the eval off the caller's event loop ───────────────────
//
// QuickJS evaluation is synchronous and cannot yield, so `wallClockMs` is also
// the longest a single reshape can block whichever thread runs it. In-process
// that thread is the server's, and a fanout with `{ limit: 4 }` is fictitious
// concurrency: four effect invocations still evaluate one after another.
//
// A pool of worker threads fixes both. It buys one more thing the in-engine
// guards cannot: a HARD kill. The wall clock is only checked when QuickJS
// invokes the interrupt handler, so an allocation-heavy script can sail past it
// (measured: ~2 s regardless of the value, terminating on the memory ceiling
// instead). `terminate()` does not ask.
//
// What it deliberately does NOT change: isolation. That comes from the WASM VM
// being capability-empty, and a thread adds nothing to it. This is a latency
// and liveness change, not a security one.

/** How often the parent re-asks shared memory once a deadline has come due (#399). */
const RECHECK_MS = 20;
/**
 * How long past its budget the parent waits for a READY worker that has not started the run
 * before treating the WORKER as broken. Generous: this covers the worker being scheduled,
 * parsing the input, creating the runtime and seeding it on a contended host, none of which
 * is the script's fault.
 */
const DEFAULT_STARTUP_LIVENESS_MS = 10_000;
/**
 * How long a cold worker may take to spawn and compile its WASM module before it is treated
 * as wedged. Its OWN allowance, measured from the moment the worker starts warming — never
 * a run's `wallClockMs + hardKillGraceMs`. A hard kill leaves a cold worker behind, so a
 * per-run window shorter than this host's cold start would fail the next run, replace the
 * worker cold again, and loop (retry middleware multiplies it) — the failure ADR 0089 D4
 * exists to prevent. 10 s is two orders of magnitude over a measured unloaded cold start.
 */
const DEFAULT_COLD_START_MS = 10_000;

/**
 * A worker never started a run: a cold worker did not finish compiling within `coldStartMs`
 * of starting to warm, or a ready worker did not start the script within
 * `wallClockMs + hardKillGraceMs + startupLivenessMs` of it being posted.
 *
 * The phases the script's wall clock deliberately does NOT charge (a cold worker's spawn and
 * WASM compile, worker scheduling, input parse, runtime creation, input seeding — L13) still
 * need a bound, or a wedged worker holds its slot forever. This is that bound. It is the
 * ENVIRONMENT failing, not the script, so it is not a typed `limitExceeded`: that channel is
 * recorded as the script's outcome and routed to drift-repair, where an LLM would rewrite a
 * script that never ran. It is a named class instead, so retry middleware can tell it apart
 * from a script's own failure — it is not a `TypedFailure`, so `retryMiddleware`'s default
 * already treats it as retryable. The worker is terminated and replaced.
 */
export class SandboxWorkerStartupError extends Error {
  override readonly name = "SandboxWorkerStartupError";
  constructor(
    /** How long the parent waited, in ms. */
    readonly waitedMs: number,
    /** The allowance that ran out: `coldStartMs`, or `wallClockMs + hardKillGraceMs + startupLivenessMs`. */
    readonly limitMs: number,
    /** Which phase never finished: the cold compile, or starting the script on a ready worker. */
    readonly phase: "compile" | "start" = "start"
  ) {
    super(
      phase === "compile"
        ? `sandbox: worker never finished compiling (waited ${waitedMs} ms, allowed ${limitMs} ms) — the worker was replaced`
        : `sandbox: worker never started the run (waited ${waitedMs} ms, allowed ${limitMs} ms) — the worker was replaced`
    );
  }
}

/** Milliseconds past `wallClockMs` before the pool stops asking and terminates. */
const DEFAULT_HARD_KILL_GRACE_MS = 2_000;

export interface SandboxWorkerPoolOptions {
  /** Threads to run. */
  size: number;
  /**
   * Grace past `wallClockMs` before a worker is terminated outright. The hard-kill clock
   * starts when the in-VM wall clock does and stops when the worker marks the run finished,
   * so the grace covers only what sits between the script's last op and that mark: the
   * in-VM `dump` of the result (which can run the script's own `toJSON`) and disposing the
   * runtime. The cold WASM compile is outside it and bounded by `coldStartMs`; everything
   * before the script starts (input parse, runtime creation, seeding) is outside it and
   * bounded by `startupLivenessMs`. Encoding and posting the result after the run is marked finished
   * runs no script code and is bounded only by the worker replying. Too tight and a
   * big-but-valid reshape is killed as a runaway. Default 2000 ms; must be finite and >= 0.
   */
  hardKillGraceMs?: number;
  /**
   * How long past `wallClockMs + hardKillGraceMs` to wait for a READY worker that has not
   * STARTED the run before terminating it with {@link SandboxWorkerStartupError}. Counted
   * from when the eval is posted, so it covers input parse, runtime creation and seeding —
   * not the cold compile, which has its own allowance (`coldStartMs`). Default 10 000 ms;
   * must be finite and >= 0.
   */
  startupLivenessMs?: number;
  /**
   * How long a cold worker may take to spawn and compile its WASM module, measured from when
   * it starts warming, before it is terminated and whatever waits on it (a run, `warm()`)
   * fails with {@link SandboxWorkerStartupError} (`phase: "compile"`). Deliberately
   * independent of any run's limits: a hard kill leaves a cold worker behind, and a compile
   * judged against a tight `wallClockMs` would fail the next run, replace the worker cold,
   * and loop. Default 10 000 ms; must be finite and STRICTLY greater than 0 — it is the only
   * clock a cold compile is ever judged against, so 0 does not mean "always warmed before
   * use" (a run's window never judges the compile), it means every cold start fails, forever.
   * Set it above this host's real cold spawn + WASM-compile time.
   */
  coldStartMs?: number;
}

interface PendingRun {
  readonly script: string;
  readonly inputJson: Uint8Array;
  readonly limits: EvalLimits;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (outcome: EvalOutcome) => void;
  readonly reject: (err: Error) => void;
}

/** A worker plus the run it is currently serving (QuickJS is synchronous — one at a time). */
interface Slot {
  worker: Worker;
  busy: boolean;
  /** Has this worker compiled its WASM module and acknowledged? */
  ready: boolean;
  /** Settles the in-flight run non-cooperatively (death / close); cleared when it settles. */
  settle: ((outcome: EvalOutcome | Error) => void) | undefined;
  /** The one warm-up in progress, shared by `warm()` and every run waiting on this worker. */
  warming: Promise<void> | undefined;
}

/**
 * The worker entry is compiled output. From `dist` it sits alongside this file;
 * when this module runs from `src` (vitest), fall back to `../dist`. The same
 * resolution `@loom/isolate` uses for its child-process runner.
 */
function workerEntry(): string {
  const sibling = path.join(__dirname, "sandboxWorker.js");
  if (existsSync(sibling)) return sibling;
  const built = path.join(__dirname, "..", "dist", "sandboxWorker.js");
  if (existsSync(built)) return built;
  throw new Error(
    "sandbox: worker entry not found — @loom/plugin-sandbox must be built (`pnpm build`) before `workers` can be used"
  );
}

export class SandboxWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: PendingRun[] = [];
  private readonly hardKillGraceMs: number;
  private readonly startupLivenessMs: number;
  private readonly coldStartMs: number;
  private nextRunId = 1;
  private closed = false;

  constructor(private readonly options: SandboxWorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new Error(`sandbox: workers must be a positive integer (got ${String(options.size)})`);
    }
    this.hardKillGraceMs = nonNegativeMs(
      "hardKillGraceMs",
      options.hardKillGraceMs,
      DEFAULT_HARD_KILL_GRACE_MS
    );
    this.startupLivenessMs = nonNegativeMs(
      "startupLivenessMs",
      options.startupLivenessMs,
      DEFAULT_STARTUP_LIVENESS_MS
    );
    this.coldStartMs = positiveMs("coldStartMs", options.coldStartMs, DEFAULT_COLD_START_MS);
  }

  /**
   * Spawn every worker and wait for each to report its WASM module compiled.
   * Without this the first N evals each pay the ~25 ms module compile on top of
   * the thread spawn; with it, that cost is paid at boot.
   */
  async warm(): Promise<void> {
    await Promise.all(
      Array.from({ length: this.options.size }, (_, i) => this.ensureReady(this.ensureSlot(i)))
    );
  }

  /**
   * Resolve once this worker has compiled its WASM module.
   *
   * Called before every eval, not only from `warm()`, because a worker's cold
   * start must NOT be charged against the script's wall clock. It is the engine
   * starting up, not the script running long, and conflating them turns a slow
   * boot into `limitExceeded { wallClock }` — a resource kill that routes to
   * drift-repair, where an LLM rewrites a script that was never the problem. A
   * cold worker is the norm after a hard kill, so this is a live path, not a
   * first-request edge case.
   */
  private ensureReady(slot: Slot): Promise<void> {
    if (slot.ready) return Promise.resolve();
    // ONE warm-up per worker, however many callers wait on it: a second `warm` message would
    // only queue behind the first, and a second allowance would start late.
    if (slot.warming !== undefined) return slot.warming;
    const startedAt = Date.now();
    slot.warming = new Promise<void>((resolve, reject) => {
      // Every exit path removes every listener and clears the timer.
      const cleanup = (): void => {
        clearTimeout(allowance);
        slot.worker.off("message", onMessage);
        slot.worker.off("error", onError);
        slot.worker.off("exit", onExit);
        slot.warming = undefined;
      };
      const onMessage = (msg: FromWorker): void => {
        if (msg.type !== "ready") return;
        cleanup();
        slot.ready = true;
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      // A worker that exits while warming — terminated by `close()`, by the allowance below
      // (which already rejects and detaches this listener before it terminates, so this path
      // is for an UNEXPECTED exit: a crash mid-compile, or anything else external) — sends
      // neither `ready` nor `error`. Without this, `warm()` never settled. Typed the same way
      // a wedged compile is (`SandboxWorkerStartupError`, `phase: "compile"`) rather than a
      // plain `Error`, so a caller (or retry middleware) sees one consistent error shape for
      // "this worker never finished compiling" regardless of why.
      const onExit = (): void => {
        cleanup();
        reject(
          this.closed
            ? new Error("sandbox: worker pool closed")
            : new SandboxWorkerStartupError(Date.now() - startedAt, this.coldStartMs, "compile")
        );
      };
      // A compile that never acknowledges is a wedged worker. Its allowance is its own,
      // measured from the start of THIS warm-up, never a run's wall clock (see `coldStartMs`).
      const allowance = setTimeout(() => {
        cleanup();
        reject(new SandboxWorkerStartupError(Date.now() - startedAt, this.coldStartMs, "compile"));
        // Replace the slot NOW rather than waiting for `exit` to reach `ensureSlot`'s death
        // handler: a worker `terminate()`d this soon after spawn can exit with code 0 (Node
        // 24), which that handler used to ignore, stranding the dead slot until a queued
        // run's own rejection happened to call `replace`. There is also a real gap between
        // `terminate()` returning and `exit` firing; closing over it here, rather than
        // waiting on the event, means no caller can observe the dead slot in between.
        void slot.worker.terminate();
        this.replace(slot);
      }, this.coldStartMs);
      slot.worker.on("message", onMessage);
      slot.worker.once("error", onError);
      slot.worker.once("exit", onExit);
      slot.worker.postMessage({ type: "warm" } satisfies ToWorker);
    });
    return slot.warming;
  }

  /** Terminate every worker. Runs still in flight reject; the pool is not reusable. */
  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.queue.splice(0)) {
      run.reject(new Error("sandbox: worker pool closed"));
    }
    await Promise.all(
      this.slots.map(async (slot) => {
        slot.settle?.(new Error("sandbox: worker pool closed"));
        await slot.worker.terminate();
      })
    );
    this.slots.length = 0;
  }

  /**
   * Evaluate on a worker. Resolves with the same {@link EvalOutcome} the
   * in-process path produces, so the effect maps outcomes to channels in ONE
   * place regardless of where the script ran.
   *
   * Named `runJson`, not `run`: this is PUBLIC API (exported from the package), and its
   * second parameter used to be the raw `input` value (`JSON.stringify`d here, internally).
   * `SandboxEvalEffect` now needs that JSON text itself — to measure `maxInputBytes` once,
   * before dispatch — so it produces it and hands it down; silently accepting a STRING where
   * a caller of the old `run` passed a raw value would seed the wrong thing with no error
   * (`run(script, "42", …)` used to seed the number 42, seeding the 2-character string "42"
   * instead). The rename makes that a compile error for any external caller, rather than a
   * silently wrong VM input.
   *
   * `inputJson` is already the caller's `input ?? null`, `JSON.stringify`d exactly once —
   * this only encodes it to bytes for the transfer, never re-serializing.
   *
   * Throws (untyped) when the worker itself fails — a module that will not load,
   * a value that will not marshal, a thread that dies mid-run. Those are
   * environment faults, not script outcomes.
   */
  runJson(
    script: string,
    inputJson: string,
    limits: EvalLimits,
    signal: AbortSignal | undefined
  ): Promise<EvalOutcome> {
    if (this.closed) return Promise.reject(new Error("sandbox: worker pool closed"));
    const inputJsonBytes = new TextEncoder().encode(inputJson);
    return new Promise<EvalOutcome>((resolve, reject) => {
      const run: PendingRun = {
        script,
        inputJson: inputJsonBytes,
        limits,
        signal,
        resolve,
        reject,
      };
      const slot = this.slots.find((s) => !s.busy) ?? this.spawnIfRoom();
      if (slot === undefined) {
        this.queue.push(run);
        return;
      }
      this.dispatch(slot, run);
    });
  }

  private spawnIfRoom(): Slot | undefined {
    return this.slots.length < this.options.size ? this.ensureSlot(this.slots.length) : undefined;
  }

  private ensureSlot(index: number): Slot {
    const existing = this.slots[index];
    if (existing !== undefined) return existing;
    // `execArgv: []` rather than inheriting the host's. A worker otherwise
    // inherits `process.execArgv`, so any `--loader` / `--import` hook the host
    // runs would also execute inside the thread that evaluates untrusted code.
    // Hardening, not a requirement — the sandbox wants the plain Node it was
    // compiled for, and it brings its own limits rather than the host's flags.
    const worker = new Worker(workerEntry(), { execArgv: [] });
    const slot: Slot = { worker, busy: false, ready: false, settle: undefined, warming: undefined };
    // A dead worker must not strand the run it was serving, and the slot has to
    // be usable again — the next dispatch spawns a replacement.
    const onDeath = (err: Error): void => {
      slot.settle?.(err);
      this.replace(slot);
    };
    slot.worker.on("error", onDeath);
    // Any exit is death, not just a non-zero one: a worker `terminate()`d shortly after spawn
    // can exit with code 0 (measured on Node 24), so filtering on `code !== 0` let a dead slot
    // sit in `this.slots` — not busy, not ready — until some run's own rejection happened to
    // call `replace`. The one exit that must NOT be treated as death is a pool-requested
    // shutdown (`close()` already settles every slot and empties `this.slots` itself).
    slot.worker.on("exit", (code) => {
      if (!this.closed) onDeath(new Error(`sandbox: worker exited with code ${code}`));
    });
    this.slots[index] = slot;
    return slot;
  }

  private replace(dead: Slot): void {
    const index = this.slots.indexOf(dead);
    if (index === -1) return;
    this.slots.splice(index, 1);
    if (this.closed) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.dispatch(this.ensureSlot(this.slots.length), next);
  }

  private dispatch(slot: Slot, run: PendingRun): void {
    if (run.signal?.aborted === true) {
      run.reject(abortReason(run.signal));
      this.release(slot);
      return;
    }
    // Claim the slot BEFORE any await, or a second run can be handed the same
    // worker while this one is still waiting for it to warm.
    slot.busy = true;
    if (!slot.ready) {
      // The cold compile is bounded by the WARM-UP's own allowance (`ensureReady`), not by
      // this run's limits: judged against a tight wall clock, the fresh worker a hard kill
      // leaves behind would fail this run, be replaced cold, and loop. This run's window
      // opens in `begin`, once the worker is ready.
      let done = false;
      const finish = (err?: Error): void => {
        if (done) return;
        done = true;
        run.signal?.removeEventListener("abort", onAbort);
        slot.settle = undefined;
        if (err === undefined) return;
        slot.busy = false;
        run.reject(err);
      };
      // An abort during warm-up rejects the run and frees the slot. The warm-up itself runs
      // on (under its own allowance) for whoever is dispatched here next.
      const onAbort = (): void => {
        finish(abortReason(run.signal));
        this.release(slot);
      };
      run.signal?.addEventListener("abort", onAbort, { once: true });
      // While it warms, the run is this slot's to settle: `close()` and a worker that dies
      // mid-compile must not strand it.
      slot.settle = (outcome) =>
        finish(
          outcome instanceof Error ? outcome : new Error("sandbox: worker never started the run")
        );
      this.ensureReady(slot).then(
        () => {
          if (done) return;
          finish();
          this.begin(slot, run);
        },
        (err: Error) => {
          if (done) return;
          finish(err);
          this.replace(slot);
        }
      );
      return;
    }
    this.begin(slot, run);
  }

  /** Send the eval and arm the deadline. The worker is ready; the clock is the script's. */
  private begin(slot: Slot, run: PendingRun): void {
    if (run.signal?.aborted === true) {
      slot.busy = false;
      run.reject(abortReason(run.signal));
      this.release(slot);
      return;
    }

    const runId = this.nextRunId++;
    // One buffer per run: a stale worker cannot then stamp a later run's status word.
    const statusBuffer = new SharedArrayBuffer(STATUS_BYTES);

    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      slot.worker.off("message", onMessage);
      run.signal?.removeEventListener("abort", onAbort);
      slot.settle = undefined;
      slot.busy = false;
    };

    const deliver = (outcome: EvalOutcome | Error): void => {
      if (outcome instanceof Error) run.reject(outcome);
      else run.resolve(outcome);
    };

    /** The worker answered. Keep it warm and hand it whatever is queued. */
    const settle = (outcome: EvalOutcome | Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      deliver(outcome);
      this.release(slot);
    };

    /**
     * The non-cooperative path: the worker is unreachable, or we no longer want
     * what it is doing. A script the interrupt handler cannot reach — one
     * allocating hard between callbacks — outlives the in-VM wall clock, and
     * `terminate()` does not ask. The thread is spent; a fresh one replaces it.
     */
    const kill = (outcome: EvalOutcome | Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      deliver(outcome);
      void slot.worker.terminate();
      this.replace(slot);
    };

    const onAbort = (): void => kill(abortReason(run.signal));

    const onMessage = (msg: FromWorker): void => {
      if (msg.type === "ready" || msg.runId !== runId) return;
      if (msg.type === "result") {
        settle({
          ok: true,
          value:
            msg.outputJson === null
              ? undefined
              : (JSON.parse(new TextDecoder().decode(msg.outputJson)) as unknown),
        });
        return;
      }
      if (msg.type === "failure") {
        settle({
          ok: false,
          message: msg.message,
          ...(msg.tripped !== undefined && { tripped: msg.tripped }),
          ...(msg.thrown !== undefined && { thrown: msg.thrown }),
          ...(msg.duringSeed !== undefined && { duringSeed: msg.duringSeed }),
        });
        return;
      }
      settle(new Error(msg.message));
    };

    // A worker that dies mid-run must not strand this promise. `kill` is the
    // right settler even for a death: it replaces the slot rather than handing
    // the next queued run to a thread that is already gone.
    slot.settle = kill;
    slot.worker.on("message", onMessage);
    run.signal?.addEventListener("abort", onAbort, { once: true });
    // #399 — the deadline is a QUESTION, asked of shared memory, not a verdict.
    //
    // This callback runs on the parent's event loop, which may have been starved since the
    // eval was posted. Firing blind would charge the script for the parent's own latency,
    // and libuv runs timers before polling, so it can fire ahead of a reply that already
    // arrived. Instead: read what the worker published. Kill only a script that IS running
    // and HAS outrun its budget by the worker's own clock; otherwise re-ask later.
    const status = new Int32Array(statusBuffer, 0, 2);
    const startedAt = new Float64Array(statusBuffer, STATUS_STARTED_AT_OFFSET, 1);
    const budget = run.limits.wallClockMs + this.hardKillGraceMs;
    const armedAt = Date.now();
    let timer: NodeJS.Timeout;

    const check = (): void => {
      const state = Atomics.load(status, STATUS_STATE_INDEX);
      const mine = Atomics.load(status, STATUS_RUN_ID_INDEX) === runId;

      if (state === RUN_FINISHED && mine) {
        // The script stopped; its reply is queued behind this very callback. Let the
        // message path settle it — killing here is the misattribution itself. No further
        // bound applies from here: what remains is the worker encoding the result and
        // posting it, which runs no script code, so it is bounded by the worker replying.
        return;
      }
      if (!(state === RUN_EVALUATING && mine)) {
        // Not started yet: the worker is parsing the input, creating the runtime, seeding it,
        // or simply not scheduled. That is the engine, not the script (the distinction `ensureReady` already draws),
        // so it does not come out of the script's budget — but it cannot be waited on
        // forever either, or a wedged worker would never be reclaimed.
        const waitedMs = Date.now() - armedAt;
        if (waitedMs >= budget + this.startupLivenessMs) {
          kill(new SandboxWorkerStartupError(waitedMs, budget + this.startupLivenessMs));
          return;
        }
        timer = setTimeout(check, RECHECK_MS);
        return;
      }
      const elapsed = Date.now() - startedAt[0]!;
      if (elapsed < budget) {
        // Running, but the budget is measured from when the SCRIPT started, which is later
        // than when this timer was armed. Re-ask when it would actually be spent.
        timer = setTimeout(check, Math.max(budget - elapsed, RECHECK_MS));
        return;
      }
      // The in-VM clock should have fired long before this. That it did not
      // means the script never gave the interrupt handler a chance, so report
      // the ceiling it blew through rather than the mechanism that caught it.
      kill({
        ok: false,
        message: `Error: exceeded wallClockMs=${run.limits.wallClockMs} without yielding to the interrupt handler`,
        tripped: "wallClock",
      });
    };
    timer = setTimeout(check, budget);

    const message: ToWorker = {
      type: "eval",
      runId,
      script: run.script,
      inputJson: run.inputJson,
      limits: run.limits,
      status: statusBuffer,
    };
    slot.worker.postMessage(message, [run.inputJson.buffer as ArrayBuffer]);
  }

  /** Hand a freed worker the next queued run, if any. */
  private release(slot: Slot): void {
    if (slot.busy || this.closed || !this.slots.includes(slot)) return;
    const next = this.queue.shift();
    if (next !== undefined) this.dispatch(slot, next);
  }
}

/**
 * A duration option must be a finite number ≥ 0. Anything else silently disables the bound it
 * sets: `NaN` makes every `>=` comparison false (a kill that never fires) and `Infinity`
 * never comes due — so refuse it at construction, as `size` is refused.
 */
function nonNegativeMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`sandbox: ${name} must be a finite number >= 0 (got ${String(value)})`);
  }
  return value;
}

/**
 * `coldStartMs` cannot be 0 the way `hardKillGraceMs`/`startupLivenessMs` can: those bounds
 * mean "no allowance", a caller's deliberate choice, and a run's own window never judges the
 * compile anyway. `coldStartMs` is the ONLY clock a cold compile is ever judged against, and a
 * host always takes some nonzero, nonnegotiable time to spawn a thread and compile the WASM
 * module — so 0 (or any value under that floor) does not mean "always warmed before use", it
 * means EVERY cold worker fails forever (and, chained through a hard kill, loops: ADR 0089
 * D4). Refused at construction, same as a bad `size`.
 */
function positiveMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`sandbox: ${name} must be a finite number > 0 (got ${String(value)})`);
  }
  return value;
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("sandbox: evaluation aborted");
}
