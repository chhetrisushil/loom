import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import { knownEventTypes } from "@loom/replay-vm";
import { EgressDeniedError, brokeredFetch } from "./broker";
import {
  type ChildToParent,
  type IsolatedToolSpec,
  type ParentToChild,
  RUNNER_DISCONNECT_EXIT_CODE,
} from "./types";

const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set(knownEventTypes());

/**
 * K7 — the isolated executor, implemented AT the effect position: `Effect` is
 * the innermost link of the chain, so K2 (authorize), K3 (meter) and K6
 * (validate) all run on the KERNEL side of the boundary — nothing inside the
 * isolate can forge them (K7.5 as amended).
 *
 * The boundary is a pooled (persistent, warm) child process per tool:
 *  - **authority**: the child gets a SCRUBBED environment — exactly the
 *    credentials injected for this tool (K7.2/K7.4) plus PATH — and holds no
 *    store handles (structural: nothing is marshaled but scalars).
 *  - **egress**: the tool's `ctx.fetch` marshals to {@link brokeredFetch} on
 *    the parent side, where the static allowlist is enforced BEFORE any
 *    connection (durable `EGRESS_DENIED` on refusal) and requests are
 *    dispatched resolve-and-pin. The runner additionally blocks ambient
 *    network modules as defense-in-depth.
 *  - **kill path**: `ctx.signal` abort (or `timeoutMs`) SIGKILLs the child —
 *    the kernel's only NON-cooperative termination (K8 cross-reference).
 *  - **emits**: forwarded over the ordered IPC channel, so every emit a
 *    completing tool sent is journaled before its result (A3).
 *
 * Runs are serialized per child (one in flight); the process stays warm
 * across calls and respawns on death.
 */
/** Concurrent brokered fetches allowed when a tool does not set its own bound. */
const DEFAULT_MAX_CONCURRENT_FETCHES = 16;
/** Cold-start allowance when a tool does not set `coldStartMs` (L23) — same default as the sandbox. */
const DEFAULT_COLD_START_MS = 10_000;
/** Per-fetch deadline when a tool does not set `fetchTimeoutMs` (L24). */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Which half of the cold start never finished. */
export type StartupPhase = "spawn" | "load";

/**
 * A child never became ready within `coldStartMs`, or it exited/disconnected while warming (L23;
 * mirrors `SandboxWorkerStartupError`). The child is killed and replaced on the next call.
 *
 * `phase` says WHO failed, and it matters for how you treat it:
 *  - `"spawn"` — the runner never booted (trusted code only): the ENVIRONMENT failing, so a retry
 *    is reasonable.
 *  - `"load"` — the runner booted but the tool module's UNTRUSTED top-level code hung, exited or
 *    was killed: a TOOL fault. `coldStartMs` bounds that code, and a tool that forces a cold
 *    start on every call costs each call up to `coldStartMs + timeoutMs`.
 * (A module whose top-level code THROWS fails the load phase with a plain tool `Error`.)
 */
export class IsolatedToolStartupError extends Error {
  override readonly name = "IsolatedToolStartupError";
  constructor(
    readonly toolId: string,
    /** How long the parent waited, in ms. */
    readonly waitedMs: number,
    /** The allowance: `coldStartMs`. */
    readonly limitMs: number,
    /** Which phase never finished: the runner booting, or the tool module loading. */
    readonly phase: StartupPhase = "spawn"
  ) {
    super(
      `isolated tool "${toolId}": child never became ready in the ${phase} phase (waited ${waitedMs} ms, allowed coldStartMs=${limitMs})${
        phase === "load" ? " — the tool module's top-level code hung or exited" : ""
      } — the child was discarded`
    );
  }
}

/**
 * The child's IPC channel closed under a run: the child exited or the tool severed it
 * (`process.disconnect()`) and stayed alive. Either way nothing can reach it; it was killed.
 */
export class IsolatedToolDisconnectedError extends Error {
  override readonly name = "IsolatedToolDisconnectedError";
  constructor(readonly toolId: string) {
    super(
      `isolated tool "${toolId}" lost its IPC channel mid-run (the child exited or disconnected) — the child was killed`
    );
  }
}

/**
 * The run input cannot be sent to the child: it is not JSON-serializable (circular, BigInt, a
 * throwing `toJSON`, …). Nothing was started; the warm child is untouched and stays usable.
 */
export class IsolatedToolInputError extends Error {
  override readonly name = "IsolatedToolInputError";
  constructor(
    readonly toolId: string,
    cause: unknown
  ) {
    super(
      `isolated tool "${toolId}": input cannot be serialized for the child process: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }
}

/**
 * Best-effort orphan reaping. Every live child is registered here and ONE module-level `exit`
 * listener SIGKILLs the survivors when the parent exits without `close()` (not registered per
 * child or per effect, so many effects add no listeners). `kill -9` on the parent never runs it;
 * the runner's own `disconnect` handler covers that case. Both are hardening only — hostile tool
 * code can remove the runner's handler — and OS-level confinement remains out of scope (ADR 0019).
 */
const liveChildren = new Set<ChildProcess>();
let reaperInstalled = false;
function trackChild(proc: ChildProcess): void {
  liveChildren.add(proc);
  proc.once("exit", () => liveChildren.delete(proc));
  // a failed spawn (ENOENT/EAGAIN) emits `error` and may never emit `exit`
  proc.once("error", () => {
    if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) {
      liveChildren.delete(proc);
    }
  });
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.once("exit", () => {
    for (const p of liveChildren) {
      try {
        p.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

/** How long a disconnect waits for the child's `exit` to arrive, so a crash keeps its attribution. */
const EXIT_GRACE_MS = 100;

/** A brokered fetch exceeded `fetchTimeoutMs` (L24); surfaces in the isolate as `code: "FETCH_TIMEOUT"`. */
class FetchTimeoutError extends Error {
  constructor(readonly fetchTimeoutMs: number) {
    super(`brokered fetch exceeded fetchTimeoutMs=${fetchTimeoutMs}`);
  }
}

function positiveMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`isolate: ${name} must be a finite number > 0 (got ${String(value)})`);
  }
  return value;
}

/** One spawned child plus its shared warm-up (one per child, however many callers wait). */
interface ChildEntry {
  readonly proc: ChildProcess;
  ready: Promise<void>;
  isReady: boolean;
  closed: boolean;
  /** Which half of the cold start is pending (for the typed error). */
  phase: StartupPhase;
}

export class IsolatedToolEffect implements Effect {
  /** K7.3 — brokered fetches currently open for this tool (see `maxConcurrentFetches`). */
  private inFlightFetches = 0;

  readonly kind = "tool" as const;
  readonly idempotent?: boolean;

  private readonly allowlist: ReadonlySet<string>;
  private readonly coldStartMs: number;
  private readonly fetchTimeoutMs: number;
  private entry: ChildEntry | undefined;
  /** The live child process, if any (tests / diagnostics). */
  private get child(): ChildProcess | undefined {
    return this.entry?.proc;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private nextRunId = 1;

  constructor(private readonly spec: IsolatedToolSpec) {
    if (spec.idempotent !== undefined) {
      this.idempotent = spec.idempotent;
    }
    this.allowlist = new Set(spec.egress ?? []);
    this.coldStartMs = positiveMs("coldStartMs", spec.coldStartMs, DEFAULT_COLD_START_MS);
    this.fetchTimeoutMs = positiveMs(
      "fetchTimeoutMs",
      spec.fetchTimeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS
    );
    // Pre-warm at construction when opted in — the child is up before the first
    // execute, so no run pays the fork + module-load cold start (A4).
    if (spec.warm === true) this.warm();
  }

  /**
   * Advisory pre-warm (A4): spawn the persistent child NOW so the first
   * `execute` doesn't pay the ~fork + `require(tool)` cold start. Idempotent —
   * a live child is reused; a dead one respawns. Off the durable path, no
   * effect on outcomes. Call at boot/registration, or ahead of a scheduled run.
   */
  warm(): void {
    // A failed warm is advisory: the next `execute` re-spawns and reports its own failure.
    this.ensureChild().ready.catch(() => undefined);
  }

  execute(input: unknown, ctx: EffectContext): Promise<unknown> {
    // Serialize runs on the warm child; each queued run starts only after the
    // previous settles (rejections don't poison the queue).
    const run = this.queue.then(
      () => this.runIsolated(input, ctx),
      () => this.runIsolated(input, ctx)
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Kill the warm child (tests / graceful shutdown). Respawns on next use. */
  close(): void {
    if (this.entry !== undefined) {
      this.entry.closed = true;
      this.entry.proc.kill("SIGKILL");
    }
    this.entry = undefined;
  }

  private ensureChild(): ChildEntry {
    const cur = this.entry;
    if (cur !== undefined && cur.proc.exitCode === null && !cur.proc.killed && cur.proc.connected) {
      return cur;
    }
    // The runner is compiled output. From dist it sits alongside this file;
    // when this module runs from src (vitest), fall back to ../dist/runner.js.
    const sibling = path.join(__dirname, "runner.js");
    const runnerPath = existsSync(sibling)
      ? sibling
      : path.join(__dirname, "..", "dist", "runner.js");
    // K7.2/K7.4 — scrubbed env: ONLY this tool's injected credentials (+ PATH,
    // so `node` subprocess basics work). The parent's environment — and every
    // other tool's secrets — are simply not there to read.
    const proc = fork(runnerPath, [], {
      env: { ...this.spec.env, PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    trackChild(proc);
    const entry: ChildEntry = {
      proc,
      ready: Promise.resolve(),
      isReady: false,
      closed: false,
      phase: "spawn",
    };
    // The child is untrusted: it can sever its channel or make a send fail. Neither may reach
    // the parent as an uncaught 'error' event, and a disconnected child — alive or not — is dead
    // to us (nothing can reach it any more), so kill it and never reuse it.
    const bury = (): void => {
      if (this.entry === entry) this.entry = undefined;
      proc.kill("SIGKILL");
    };
    proc.on("error", bury);
    // On a disconnect the entry is discarded at once (no reuse) but the SIGKILL waits out the
    // grace, so a child that exits by itself (crash, or the runner's own disconnect handler)
    // keeps its exit code for attribution instead of being pre-empted by our signal.
    proc.on("disconnect", () => {
      if (this.entry === entry) this.entry = undefined;
      const t = setTimeout(() => proc.kill("SIGKILL"), EXIT_GRACE_MS);
      t.unref();
      proc.once("exit", () => clearTimeout(t));
    });
    entry.ready = this.awaitReady(entry);
    // Callers that need the outcome await `ready`; this only keeps an unobserved failure
    // (a pre-warm nobody waited on, a close() mid-warm) from being an unhandled rejection.
    entry.ready.catch(() => undefined);
    this.entry = entry;
    return entry;
  }

  /**
   * L23 — resolve once the child has booted the runner (trusted; phase "spawn") AND loaded the
   * tool module (untrusted top-level code; phase "load"). One allowance covers both (`coldStartMs`,
   * from spawn), never a run's `timeoutMs`. Any exit or disconnect while warming is death (typed
   * error, whatever the code: a child killed this soon can exit 0); a module that throws at load
   * is a tool error. On failure the child is discarded so the next call starts fresh.
   */
  private awaitReady(entry: ChildEntry): Promise<void> {
    const { proc } = entry;
    const startedAt = Date.now();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(allowance);
        proc.off("message", onMessage);
        proc.off("exit", onExit);
        proc.off("disconnect", onDisconnect);
        proc.off("error", onError);
      };
      const startup = (): Error =>
        entry.closed
          ? new Error(`isolated tool "${this.spec.id}" closed`)
          : new IsolatedToolStartupError(
              this.spec.id,
              Date.now() - startedAt,
              this.coldStartMs,
              entry.phase
            );
      // Discard synchronously: no caller may observe the doomed child in the gap before `exit`.
      const fail = (err: Error): void => {
        cleanup();
        if (this.entry === entry) this.entry = undefined;
        proc.kill("SIGKILL");
        reject(err);
      };
      const onMessage = (msg: unknown): void => {
        const m = msg as ChildToParent;
        if (m.type === "booted") {
          // Trusted boot done; from here the clock is running on the tool's own top-level code.
          entry.phase = "load";
          proc.send(
            { type: "warm", modulePath: this.spec.modulePath } satisfies ParentToChild,
            (err) => {
              if (err !== null) fail(startup());
            }
          );
        } else if (m.type === "load-error") {
          fail(new Error(`isolated tool "${this.spec.id}" failed to load: ${m.message}`));
        } else if (m.type === "ready") {
          cleanup();
          entry.isReady = true;
          resolve();
        }
      };
      const onExit = (): void => fail(startup());
      // A dying process closes its channel before 'exit' fires, so this is startup death too.
      const onDisconnect = (): void => fail(startup());
      const onError = (err: Error): void => fail(err);
      const allowance = setTimeout(() => fail(startup()), this.coldStartMs);
      proc.on("message", onMessage);
      proc.once("exit", onExit);
      proc.once("disconnect", onDisconnect);
      proc.once("error", onError);
    });
  }

  private async runIsolated(input: unknown, ctx: EffectContext): Promise<unknown> {
    const entry = this.ensureChild();
    if (!entry.isReady) await this.waitReady(entry, ctx);
    return this.runOnReadyChild(entry.proc, input, ctx);
  }

  /** Wait for the warm-up, but let a cancellation end the wait (and the doomed child) at once. */
  private waitReady(entry: ChildEntry, ctx: EffectContext): Promise<void> {
    const signal = ctx.signal;
    if (signal === undefined) return entry.ready;
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        entry.closed = true;
        entry.proc.kill("SIGKILL");
        if (this.entry === entry) this.entry = undefined;
        reject(signal.reason instanceof Error ? signal.reason : new Error("isolated tool aborted"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      entry.ready.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      );
    });
  }

  private runOnReadyChild(
    child: ChildProcess,
    input: unknown,
    ctx: EffectContext
  ): Promise<unknown> {
    const runId = this.nextRunId++;

    const runMsg: ParentToChild = {
      type: "run",
      runId,
      modulePath: this.spec.modulePath,
      ...(this.spec.exportName !== undefined && { exportName: this.spec.exportName }),
      input,
      ctx: {
        executionId: ctx.executionId,
        stepId: ctx.stepId,
        workflowId: ctx.workflowId,
        attempt: ctx.attempt,
        ...(ctx.idempotencyKey !== undefined && { idempotencyKey: ctx.idempotencyKey }),
      },
    };
    // The channel serializes as JSON and `send` throws synchronously on a value it cannot
    // serialize. Prove it serializes BEFORE any timer/listener exists, so a bad input is a typed
    // rejection that touches nothing (the healthy child is not killed, nothing leaks).
    try {
      JSON.stringify(runMsg);
    } catch (err) {
      return Promise.reject(new IsolatedToolInputError(this.spec.id, err));
    }

    return new Promise<unknown>((resolve, reject) => {
      // L24 — aborted the moment the run settles (result, error, kill, crash), so no brokered
      // fetch outlives the run that issued it.
      const runAbort = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        runAbort.abort(new Error("run ended"));
        if (timer !== undefined) clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        child.removeListener("message", onMessage);
        child.removeListener("exit", onExit);
        child.removeListener("disconnect", onDisconnect);
        ctx.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const kill = (reason: Error): void => {
        // A5 — the non-cooperative kill path: the boundary, not the tool's
        // goodwill, ends the work.
        child.kill("SIGKILL");
        if (this.entry?.proc === child) this.entry = undefined;
        settle(() => reject(reason));
      };

      // A fault raised by a fetch handler fails THIS run only: after it settled the warm child may
      // be serving the next run, which must not be killed for it. A late fault is dropped on
      // purpose — the run it belonged to has already been answered, so there is no one to tell.
      const fault = (err: Error): void => {
        if (!settled) kill(err);
      };

      const onAbort = (): void => {
        const reason = ctx.signal?.reason;
        kill(reason instanceof Error ? reason : new Error("isolated tool aborted"));
      };

      const onExit = (code: number | null): void => {
        if (this.entry?.proc === child) this.entry = undefined;
        // The runner's own disconnect handler exits with a dedicated code: the channel closed
        // (the tool severed it), which is not a crash.
        settle(() =>
          reject(
            code === RUNNER_DISCONNECT_EXIT_CODE
              ? new IsolatedToolDisconnectedError(this.spec.id)
              : this.crashed()
          )
        );
      };

      // A dying child closes its channel before `exit` fires. Give `exit` a short grace so a real
      // crash keeps its "crashed mid-run" attribution; a child still alive after it severed the
      // channel (or a close()) is reported as disconnected and killed. The entry is discarded at
      // once, so nothing can reuse the child in the gap.
      const onDisconnect = (): void => {
        if (this.entry?.proc === child) this.entry = undefined;
        if (settled || graceTimer !== undefined) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          onExit(child.exitCode);
          return;
        }
        graceTimer = setTimeout(() => {
          child.kill("SIGKILL");
          settle(() => reject(new IsolatedToolDisconnectedError(this.spec.id)));
        }, EXIT_GRACE_MS);
      };

      const onMessage = (raw: unknown): void => {
        const msg = raw as ChildToParent;
        if (msg.type === "emit" && msg.runId === runId) {
          // ADR 0104 — the child is untrusted code, so it may emit APPLICATION events only.
          // Every kernel fact about this run (EGRESS_DENIED, metering, …) is written by the
          // parent itself; a relayed one would be the tool attesting to its own conduct.
          if (KERNEL_EVENT_TYPES.has(msg.eventType)) {
            kill(
              new Error(
                `isolated tool "${this.spec.id}" emitted "${msg.eventType}", a kernel event type: an isolated tool may emit application events only (ADR 0104)`
              )
            );
            return;
          }
          try {
            ctx.emit(msg.eventType, msg.payload);
          } catch (err) {
            kill(err instanceof Error ? err : new Error(String(err)));
          }
          return;
        }
        if (msg.type === "fetch" && msg.runId === runId) {
          this.handleFetch(
            child,
            msg.fetchId,
            msg.url,
            msg.init,
            ctx,
            runAbort.signal,
            fault
          ).catch((err: unknown) => fault(err instanceof Error ? err : new Error(String(err))));
          return;
        }
        if (msg.type === "result" && msg.runId === runId) {
          settle(() => resolve(msg.output));
          return;
        }
        if (msg.type === "error" && msg.runId === runId) {
          settle(() => reject(new Error(msg.message)));
        }
      };

      if (ctx.signal?.aborted === true) {
        onAbort();
        return;
      }
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("disconnect", onDisconnect);
      if (!child.connected) {
        onDisconnect();
        return;
      }
      if (this.spec.timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            kill(
              new Error(`isolated tool "${this.spec.id}" exceeded timeoutMs=${this.spec.timeoutMs}`)
            ),
          this.spec.timeoutMs
        );
      }

      // A send that cannot be delivered reports through the callback; without one it would be an
      // 'error' event on the child.
      try {
        child.send(runMsg, (err) => {
          if (err !== null) onDisconnect();
        });
      } catch {
        onDisconnect();
      }
    });
  }

  private crashed(): Error {
    return new Error(`isolated tool "${this.spec.id}" crashed mid-run`);
  }

  private async handleFetch(
    child: ChildProcess,
    fetchId: number,
    url: string,
    init: Parameters<typeof brokeredFetch>[3],
    ctx: EffectContext,
    runSignal?: AbortSignal,
    onFault?: (err: Error) => void
  ): Promise<void> {
    // `ctx.emit` can throw (e.g. after the run settled). A tool reaches these emits at will, so
    // one that throws must never escape as an unhandled rejection: fail the run, as the message
    // relay does, and keep going so the tool is still answered.
    const emit = (eventType: string, payload: Record<string, unknown>): void => {
      try {
        ctx.emit(eventType, payload);
      } catch (err) {
        onFault?.(err instanceof Error ? err : new Error(String(err)));
      }
    };
    // The child may already be gone (run killed / timed out) by the time a reply is ready.
    const reply = (m: ParentToChild): void => {
      if (child.connected === false) return;
      try {
        // With a callback a failed send is reported to it — without one it is emitted as an
        // 'error' event, which nothing listens for once the run is over.
        child.send(m, () => undefined);
      } catch {
        // channel closed — nobody left to tell
      }
    };
    // K7.3 — volume, the half the allowlist does not cover. Counted BEFORE the
    // request is opened, and released in `finally`, so a refusal costs nothing
    // and a crash cannot strand a slot.
    const limit = this.spec.maxConcurrentFetches ?? DEFAULT_MAX_CONCURRENT_FETCHES;
    if (this.inFlightFetches >= limit) {
      const reason = `exceeded ${limit} concurrent brokered fetches`;
      emit("EGRESS_DENIED", {
        toolId: this.spec.id,
        stepId: ctx.stepId,
        target: url,
        reason,
      });
      reply({ type: "fetch-result", fetchId, ok: false, error: reason });
      return;
    }
    this.inFlightFetches += 1;
    // The slot outlives the request when a DNS lookup does: getaddrinfo cannot be cancelled and
    // holds a libuv threadpool thread, so releasing on abort would let pending lookups pile up
    // without bound. Released once the fetch is finished AND its lookup (if any) has settled.
    let lookupPending = false;
    let finished = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlightFetches -= 1;
    };
    // L24 — one deadline for the whole fetch, plus the run's own end. Both abort the underlying
    // request; the slot is released in `finally` either way.
    const fetchAbort = new AbortController();
    const timer = setTimeout(
      () => fetchAbort.abort(new FetchTimeoutError(this.fetchTimeoutMs)),
      this.fetchTimeoutMs
    );
    const onRunEnd = (): void => fetchAbort.abort(runSignal?.reason);
    if (runSignal?.aborted === true) onRunEnd();
    else runSignal?.addEventListener("abort", onRunEnd, { once: true });
    try {
      const res = await brokeredFetch(this.spec.id, this.allowlist, url, init, fetchAbort.signal, {
        lookupStarted: (settled) => {
          lookupPending = true;
          void settled.then(() => {
            lookupPending = false;
            if (finished) release();
          });
        },
      });
      const ok: ParentToChild = {
        type: "fetch-result",
        fetchId,
        ok: true,
        status: res.status,
        headers: res.headers,
        body: res.body,
      };
      reply(ok);
    } catch (err) {
      if (err instanceof EgressDeniedError) {
        // K7.3 — the violation is a durable, auditable fact (folded like
        // EFFECT_DENIED), refused before any connection was opened.
        emit("EGRESS_DENIED", {
          toolId: this.spec.id,
          stepId: ctx.stepId,
          target: err.target,
          reason: err.reason,
        });
      }
      const timedOut = fetchAbort.signal.reason instanceof FetchTimeoutError;
      reply({
        type: "fetch-result",
        fetchId,
        ok: false,
        error: timedOut ? (fetchAbort.signal.reason as FetchTimeoutError).message : String(err),
        ...(timedOut && { code: "FETCH_TIMEOUT" as const }),
        ...(!timedOut && fetchAbort.signal.aborted && { code: "FETCH_ABORTED" as const }),
      });
    } finally {
      clearTimeout(timer);
      runSignal?.removeEventListener("abort", onRunEnd);
      finished = true;
      if (!lookupPending) release();
    }
  }
}
