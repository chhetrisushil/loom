import { DEFAULT_BACKEND_GRACE_MS, SandboxEffect } from "@loom/sandbox";
import { QuickJsSandboxBackend } from "./QuickJsSandboxBackend";
import {
  DEFAULT_COLD_START_MS,
  DEFAULT_HARD_KILL_GRACE_MS,
  DEFAULT_STARTUP_LIVENESS_MS,
  type SandboxWorkerPool,
} from "./SandboxWorkerPool";
import type { SandboxLimits, SandboxWorkers, ScriptReader } from "./types";

// ── ADR 0064 — the hardened eval effect, QuickJS preconfigured ───────────────
//
// A fresh QuickJS runtime per call: memory limit + interrupt budget + wall clock enforced IN-ENGINE
// (the only place that can stop a synchronous runaway loop), nothing injected but a JSON-marshaled
// `input`, the completion value marshaled back out as JSON. Resource kills and shape mismatches
// complete on DECLARED channels (ADR 0060), and so does the script's own exception (`scriptError`);
// infrastructure failures (worker pool, integrity, cancellation) stay UNTYPED.
//
// Since ADR 0144 the guarantees live in `SandboxEffect` (@loom/sandbox) and the engine in
// `QuickJsSandboxBackend`; this class keeps the original constructor so no consumer changes a line.
export class SandboxEvalEffect extends SandboxEffect {
  /** Present only in worker mode. Kept on the effect (as before ADR 0144) for hosts and tests that inspect it. */
  protected readonly pool: SandboxWorkerPool | undefined;

  /** The in-process QuickJS module, once compiled (inspected by tests; untouched by a refused call). */
  protected get module(): unknown {
    return (this.backend as QuickJsSandboxBackend).module;
  }

  constructor(scripts: ScriptReader, limits: SandboxLimits = {}, workers: SandboxWorkers = {}) {
    const backend = new QuickJsSandboxBackend({
      ...(limits.interruptBudget !== undefined && { interruptBudget: limits.interruptBudget }),
      workers,
    });
    // The effect gives up on a backend that never settles after `wallClockMs + backendGraceMs`
    // (ADR 0144 D2). A worker pool may legitimately spend a cold compile, a hard-kill grace and a
    // startup-liveness wait outside the script's own clock, so the grace must cover the configured
    // sum (plus slack) or a slow-but-healthy cold start would be reported as a hang.
    const poolWorstCase =
      workers.count === undefined || workers.count === 0
        ? 0
        : (workers.hardKillGraceMs ?? DEFAULT_HARD_KILL_GRACE_MS) +
          (workers.startupLivenessMs ?? DEFAULT_STARTUP_LIVENESS_MS) +
          (workers.coldStartMs ?? DEFAULT_COLD_START_MS) +
          10_000;
    super(scripts, backend, {
      backendGraceMs: Math.max(DEFAULT_BACKEND_GRACE_MS, poolWorstCase),
      limits: {
        ...(limits.memoryBytes !== undefined && { memoryBytes: limits.memoryBytes }),
        ...(limits.wallClockMs !== undefined && { wallClockMs: limits.wallClockMs }),
        ...(limits.maxOutputBytes !== undefined && { maxOutputBytes: limits.maxOutputBytes }),
        ...(limits.maxInputBytes !== undefined && { maxInputBytes: limits.maxInputBytes }),
      },
    });
    this.pool = backend.pool;
  }
}
