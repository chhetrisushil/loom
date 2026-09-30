import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import { knownEventTypes } from "@loom/replay-vm";
import { EgressDeniedError, brokeredFetch } from "./broker";
import type { ChildToParent, IsolatedToolSpec, ParentToChild } from "./types";

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

/**
 * A child never became ready: it did not finish spawning and loading the tool module within
 * `coldStartMs`, or it exited while warming (L23; mirrors `SandboxWorkerStartupError`).
 *
 * The phases a run's `timeoutMs` deliberately does NOT charge still need a bound, or a wedged
 * child holds the tool forever. This is that bound. It is the ENVIRONMENT failing, not the tool,
 * so it is a named class rather than a generic `Error` (retry middleware can tell it apart from
 * a tool's own failure). The child is killed and replaced on the next call.
 */
export class IsolatedToolStartupError extends Error {
  override readonly name = "IsolatedToolStartupError";
  constructor(
    readonly toolId: string,
    /** How long the parent waited, in ms. */
    readonly waitedMs: number,
    /** The allowance: `coldStartMs`. */
    readonly limitMs: number,
    /** Which phase never finished (only the cold spawn + module load exists here). */
    readonly phase = "spawn"
  ) {
    super(
      `isolated tool "${toolId}": child never became ready (waited ${waitedMs} ms, allowed coldStartMs=${limitMs}) — the child was discarded`
    );
  }
}

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
    if (cur !== undefined && cur.proc.exitCode === null && !cur.proc.killed) {
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
    const entry: ChildEntry = { proc, ready: Promise.resolve(), isReady: false, closed: false };
    entry.ready = this.awaitReady(entry);
    // Callers that need the outcome await `ready`; this only keeps an unobserved failure
    // (a pre-warm nobody waited on, a close() mid-warm) from being an unhandled rejection.
    entry.ready.catch(() => undefined);
    this.entry = entry;
    return entry;
  }

  /**
   * L23 — resolve once the child has booted AND loaded the tool module. Its allowance is its own
   * (`coldStartMs`), measured from spawn, never a run's `timeoutMs`. Any exit while warming is
   * death (typed error), whatever the code: a child killed this soon can exit 0. On failure the
   * child is discarded so the next call starts fresh.
   */
  private awaitReady(entry: ChildEntry): Promise<void> {
    const { proc } = entry;
    const startedAt = Date.now();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(allowance);
        proc.off("message", onMessage);
        proc.off("exit", onExit);
        proc.off("error", onError);
      };
      const discard = (): void => {
        if (this.entry === entry) this.entry = undefined;
      };
      const onMessage = (msg: unknown): void => {
        if ((msg as ChildToParent).type !== "ready") return;
        cleanup();
        entry.isReady = true;
        resolve();
      };
      const onExit = (): void => {
        cleanup();
        discard();
        reject(
          entry.closed
            ? new Error(`isolated tool "${this.spec.id}" closed`)
            : new IsolatedToolStartupError(this.spec.id, Date.now() - startedAt, this.coldStartMs)
        );
      };
      const onError = (err: Error): void => {
        cleanup();
        discard();
        proc.kill("SIGKILL");
        reject(err);
      };
      const allowance = setTimeout(() => {
        cleanup();
        // Discard synchronously: no caller may observe the doomed child in the gap before `exit`.
        discard();
        proc.kill("SIGKILL");
        reject(
          new IsolatedToolStartupError(this.spec.id, Date.now() - startedAt, this.coldStartMs)
        );
      }, this.coldStartMs);
      proc.on("message", onMessage);
      proc.once("exit", onExit);
      proc.once("error", onError);
      proc.send({ type: "warm", modulePath: this.spec.modulePath } satisfies ParentToChild);
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

    return new Promise<unknown>((resolve, reject) => {
      // L24 — aborted the moment the run settles (result, error, kill, crash), so no brokered
      // fetch outlives the run that issued it.
      const runAbort = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        runAbort.abort(new Error("run ended"));
        if (timer !== undefined) clearTimeout(timer);
        child.removeListener("message", onMessage);
        child.removeListener("exit", onExit);
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

      const onAbort = (): void => {
        const reason = ctx.signal?.reason;
        kill(reason instanceof Error ? reason : new Error("isolated tool aborted"));
      };

      const onExit = (): void => {
        if (this.entry?.proc === child) this.entry = undefined;
        settle(() => reject(new Error(`isolated tool "${this.spec.id}" crashed mid-run`)));
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
          void this.handleFetch(child, msg.fetchId, msg.url, msg.init, ctx, runAbort.signal);
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
      if (this.spec.timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            kill(
              new Error(`isolated tool "${this.spec.id}" exceeded timeoutMs=${this.spec.timeoutMs}`)
            ),
          this.spec.timeoutMs
        );
      }

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
      child.send(runMsg);
    });
  }

  private async handleFetch(
    child: ChildProcess,
    fetchId: number,
    url: string,
    init: Parameters<typeof brokeredFetch>[3],
    ctx: EffectContext,
    runSignal?: AbortSignal
  ): Promise<void> {
    // The child may already be gone (run killed / timed out) by the time a reply is ready.
    const reply = (m: ParentToChild): void => {
      try {
        child.send(m);
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
      ctx.emit("EGRESS_DENIED", {
        toolId: this.spec.id,
        stepId: ctx.stepId,
        target: url,
        reason,
      });
      reply({ type: "fetch-result", fetchId, ok: false, error: reason });
      return;
    }
    this.inFlightFetches += 1;
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
      const res = await brokeredFetch(this.spec.id, this.allowlist, url, init, fetchAbort.signal);
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
        ctx.emit("EGRESS_DENIED", {
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
      this.inFlightFetches -= 1;
    }
  }
}
