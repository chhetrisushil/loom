import type {
  SandboxBackend,
  SandboxBackendCapabilities,
  SandboxOutcome,
  SandboxRequest,
} from "@loom/sandbox";
import { type QuickJSWASMModule, getQuickJS } from "quickjs-emscripten";
import { SandboxWorkerPool } from "./SandboxWorkerPool";
import { type EvalLimits, type EvalOutcome, evalInFreshRuntime } from "./evalCore";
import type { SandboxWorkers } from "./types";

// ── ADR 0144 — QuickJS as a SandboxBackend ───────────────────────────────────
//
// The reference backend. Everything QuickJS-specific lives here: the interrupt budget, the worker
// pool, and the INTERPRETATION of the engine's own error text (`InternalError: out of memory`).
// The generic effect (@loom/sandbox) maps the closed outcome vocabulary this returns to channels.

export const DEFAULT_INTERRUPT_BUDGET = 10_000;

/** An `InternalError` message naming the VM's heap ceiling — QuickJS has no other wording for it. */
const OUT_OF_MEMORY = /out of memory|memory limit/i;

export interface QuickJsSandboxBackendOptions {
  /**
   * CPU budget as interrupt-handler ticks (QuickJS invokes the handler periodically during
   * execution). Default 10_000 — generous for reshaping, lethal for runaway loops.
   */
  interruptBudget?: number;
  /** Evaluate on worker threads (ADR 0089). Omitted or `count: 0` keeps the in-process engine. */
  workers?: SandboxWorkers;
}

export class QuickJsSandboxBackend implements SandboxBackend {
  readonly capabilities: SandboxBackendCapabilities;

  /** @internal The lazily-compiled in-process module (tests assert it is untouched by a refused call). */
  module: QuickJSWASMModule | undefined;
  private readonly interruptBudget: number;
  /** @internal Present only when the caller opted into worker threads (ADR 0089). */
  readonly pool: SandboxWorkerPool | undefined;

  constructor(options: QuickJsSandboxBackendOptions = {}) {
    const workers = options.workers ?? {};
    this.interruptBudget = options.interruptBudget ?? DEFAULT_INTERRUPT_BUDGET;
    this.pool =
      workers.count === undefined || workers.count === 0
        ? undefined
        : new SandboxWorkerPool({
            size: workers.count,
            ...(workers.hardKillGraceMs !== undefined && {
              hardKillGraceMs: workers.hardKillGraceMs,
            }),
            ...(workers.startupLivenessMs !== undefined && {
              startupLivenessMs: workers.startupLivenessMs,
            }),
            ...(workers.coldStartMs !== undefined && { coldStartMs: workers.coldStartMs }),
          });
    this.capabilities = {
      language: "javascript",
      // Capability-EMPTY by construction: no fs, net, process or timers exist in the VM.
      network: "none",
      // In-process the wall clock is checked only when QuickJS calls the interrupt handler (soft);
      // a worker pool adds the terminate-the-thread backstop (hard).
      wallClock: this.pool === undefined ? "soft" : "hard",
      memory: true,
      cpu: true,
      freshPerRun: true,
    };
  }

  /**
   * Advisory pre-warm (M6): compile the WASM module — the real cold-start cost. In worker mode
   * this spawns the threads and compiles the module on each, so no request pays the spawn either.
   */
  async warm(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.warm();
      return;
    }
    this.module ??= await getQuickJS();
  }

  /** Shut the worker pool down. No-op in-process. */
  async close(): Promise<void> {
    await this.pool?.close();
  }

  async evaluate(request: SandboxRequest): Promise<SandboxOutcome> {
    const limits: EvalLimits = {
      memoryBytes: request.limits.memoryBytes,
      interruptBudget: this.interruptBudget,
      wallClockMs: request.limits.wallClockMs,
    };
    let outcome: EvalOutcome;
    if (this.pool !== undefined) {
      outcome = await this.pool.runJson(request.script, request.inputJson, limits, request.signal);
    } else {
      this.module ??= await getQuickJS();
      outcome = evalInFreshRuntime(
        this.module,
        request.script,
        request.inputJson,
        limits,
        () => request.signal?.aborted === true
      );
    }
    return interpretQuickJsOutcome(outcome);
  }
}

/** @internal Engine outcome → the SPI's closed vocabulary. The only place QuickJS error text is read. */
export function interpretQuickJsOutcome(outcome: EvalOutcome): SandboxOutcome {
  if (outcome.ok) return { ok: true, value: outcome.value };
  if (outcome.duringSeed === true) {
    // No script code has run yet. The only realistic cause is the VM heap ceiling: `input` passed
    // the caller-side `maxInputBytes` check but still overflows `memoryBytes` once parsed.
    if (OUT_OF_MEMORY.test(outcome.message)) return { ok: false, kind: "inputTooLarge" };
    // `input` is always well-formed JSON, so nothing else should fail a bare `JSON.parse` of it —
    // report it as infrastructure rather than guess a channel for a shape nothing has observed.
    // The text keeps its historical `sandbox: input marshalling failed:` prefix (ADR 0144 Consequences).
    const prefix = "sandbox: input marshalling failed:";
    return {
      ok: false,
      kind: "infrastructure",
      message: outcome.message.startsWith(prefix)
        ? outcome.message
        : `${prefix} ${outcome.message}`,
    };
  }
  if (outcome.tripped !== undefined) return { ok: false, kind: "limit", limit: outcome.tripped };
  const thrown = outcome.thrown;
  // The engine reports its own kills as an `InternalError` (the QuickJS memory limit has no
  // callback, so there is no trip record for it). Text is read ONLY there: a script's
  // `throw new Error("connection interrupted")` is its own outcome, not a resource kill.
  // Residual: a script can construct `new InternalError("out of memory")` itself; that deliberate
  // forgery is reported as the kill it claims to be — still typed, still bounded.
  if (thrown?.name === "InternalError") {
    if (OUT_OF_MEMORY.test(thrown.message)) return { ok: false, kind: "limit", limit: "memory" };
    // Interrupted without a recorded trigger — attribute to CPU budget.
    if (/^interrupted$/i.test(thrown.message)) return { ok: false, kind: "limit", limit: "cpu" };
  }
  if (thrown !== undefined) {
    return thrown.name === undefined
      ? { ok: false, kind: "threw", message: thrown.message }
      : { ok: false, kind: "threw", name: thrown.name, message: thrown.message };
  }
  // No thrown value and no guard: nothing the script did explains this.
  return { ok: false, kind: "infrastructure", message: outcome.message };
}
