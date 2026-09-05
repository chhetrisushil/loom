import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { EvalLimits, EvalOutcome } from "./evalCore";
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

/** Milliseconds past `wallClockMs` before the pool stops asking and terminates. */
const DEFAULT_HARD_KILL_GRACE_MS = 2_000;

export interface SandboxWorkerPoolOptions {
  /** Threads to run. */
  size: number;
  /**
   * Grace past `wallClockMs` before a worker is terminated outright. Covers the
   * legitimate work the in-VM clock does not: marshalling a large output
   * (~25 ms at the 4 MiB ceiling) and, on the first run, compiling the WASM
   * module. Too tight and a big-but-valid reshape is killed as a runaway.
   * Default 2000 ms.
   */
  hardKillGraceMs?: number;
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
  /** Settles the in-flight run non-cooperatively (death / close); cleared when it settles. */
  settle: ((outcome: EvalOutcome | Error) => void) | undefined;
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
  private nextRunId = 1;
  private closed = false;

  constructor(private readonly options: SandboxWorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) {
      throw new Error(`sandbox: workers must be a positive integer (got ${String(options.size)})`);
    }
    this.hardKillGraceMs = options.hardKillGraceMs ?? DEFAULT_HARD_KILL_GRACE_MS;
  }

  /**
   * Spawn every worker and wait for each to report its WASM module compiled.
   * Without this the first N evals each pay the ~25 ms module compile on top of
   * the thread spawn; with it, that cost is paid at boot.
   */
  async warm(): Promise<void> {
    await Promise.all(
      Array.from({ length: this.options.size }, (_, i) => {
        const slot = this.ensureSlot(i);
        return new Promise<void>((resolve, reject) => {
          const onMessage = (msg: FromWorker): void => {
            if (msg.type !== "ready") return;
            slot.worker.off("message", onMessage);
            slot.worker.off("error", onError);
            resolve();
          };
          const onError = (err: Error): void => {
            slot.worker.off("message", onMessage);
            reject(err);
          };
          slot.worker.on("message", onMessage);
          slot.worker.once("error", onError);
          slot.worker.postMessage({ type: "warm" } satisfies ToWorker);
        });
      })
    );
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
   * Throws (untyped) when the worker itself fails — a module that will not load,
   * a value that will not marshal, a thread that dies mid-run. Those are
   * environment faults, not script outcomes.
   */
  run(
    script: string,
    input: unknown,
    limits: EvalLimits,
    signal: AbortSignal | undefined
  ): Promise<EvalOutcome> {
    if (this.closed) return Promise.reject(new Error("sandbox: worker pool closed"));
    // Marshal on this thread either way: the VM is seeded from a JSON string, so
    // this is the sandbox's own work, not a tax the pool adds.
    const inputJson = new TextEncoder().encode(JSON.stringify(input ?? null));
    return new Promise<EvalOutcome>((resolve, reject) => {
      const run: PendingRun = { script, inputJson, limits, signal, resolve, reject };
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
    const slot: Slot = { worker, busy: false, settle: undefined };
    // A dead worker must not strand the run it was serving, and the slot has to
    // be usable again — the next dispatch spawns a replacement.
    const onDeath = (err: Error): void => {
      slot.settle?.(err);
      this.replace(slot);
    };
    slot.worker.on("error", onDeath);
    slot.worker.on("exit", (code) => {
      if (code !== 0) onDeath(new Error(`sandbox: worker exited with code ${code}`));
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

    const runId = this.nextRunId++;
    slot.busy = true;

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
        settle(
          msg.tripped === undefined
            ? { ok: false, message: msg.message }
            : { ok: false, message: msg.message, tripped: msg.tripped }
        );
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
    const timer = setTimeout(() => {
      // The in-VM clock should have fired long before this. That it did not
      // means the script never gave the interrupt handler a chance, so report
      // the ceiling it blew through rather than the mechanism that caught it.
      kill({
        ok: false,
        message: `Error: exceeded wallClockMs=${run.limits.wallClockMs} without yielding to the interrupt handler`,
        tripped: "wallClock",
      });
    }, run.limits.wallClockMs + this.hardKillGraceMs);

    const message: ToWorker = {
      type: "eval",
      runId,
      script: run.script,
      inputJson: run.inputJson,
      limits: run.limits,
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

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("sandbox: evaluation aborted");
}
