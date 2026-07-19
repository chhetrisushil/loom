import { fail } from "@loom/core";
import type { Effect, EffectContext, ErrorChannelSchema } from "@loom/effect-runtime";
import { type QuickJSWASMModule, getQuickJS } from "quickjs-emscripten";
import { shapeHash } from "./shape";
import { SANDBOX_ERRORS, SandboxEvalInput, type SandboxEvalInputValue } from "./types";
import type { SandboxLimits, ScriptReader } from "./types";

// ── ADR 0064 — the hardened eval effect ──────────────────────────────────────
//
// A fresh QuickJS runtime per call: memory limit + interrupt budget + wall
// clock enforced IN-ENGINE (the only place that can stop a synchronous runaway
// loop), nothing injected but a JSON-marshaled `input`, the completion value
// marshaled back out as JSON. Resource kills and shape mismatches complete on
// DECLARED channels (ADR 0060) — a planner catches and re-plans, and replay
// substitutes without re-burning CPU. Environment violations (a script touching
// fetch/require/process) are ReferenceErrors — deliberately UNTYPED: an
// environment bug is not a domain outcome.

const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTERRUPT_BUDGET = 10_000;
const DEFAULT_WALL_CLOCK_MS = 1_000;

export class SandboxEvalEffect implements Effect {
  readonly kind = "tool" as const;
  /** Pure function of (script, input) — at-least-once re-runs are safe by construction (K9.3). */
  readonly idempotent = true;
  readonly errors: Record<string, ErrorChannelSchema> = SANDBOX_ERRORS;

  private module: QuickJSWASMModule | undefined;
  private readonly limits: Required<SandboxLimits>;

  constructor(
    private readonly scripts: ScriptReader,
    limits: SandboxLimits = {}
  ) {
    this.limits = {
      memoryBytes: limits.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      interruptBudget: limits.interruptBudget ?? DEFAULT_INTERRUPT_BUDGET,
      wallClockMs: limits.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
    };
  }

  /** Advisory pre-warm (M6): compile the WASM module — the real cold-start cost. */
  async warm(): Promise<void> {
    this.module ??= await getQuickJS();
  }

  async execute(rawInput: unknown, ctx: EffectContext): Promise<unknown> {
    const call: SandboxEvalInputValue = SandboxEvalInput.parse(rawInput);

    const bytes = await this.scripts.get(call.scriptRef);
    if (bytes === null) {
      fail("scriptMissing", { ref: call.scriptRef.__loomContent });
    }
    const script = new TextDecoder().decode(bytes);

    this.module ??= await getQuickJS();
    const output = this.evalInFreshRuntime(script, call.input, ctx);

    if (call.expectedOutputShapeHash !== undefined) {
      const observed = shapeHash(output);
      if (observed !== call.expectedOutputShapeHash) {
        fail("shapeMismatch", { expected: call.expectedOutputShapeHash, observed });
      }
    }
    return output;
  }

  private evalInFreshRuntime(script: string, input: unknown, ctx: EffectContext): unknown {
    const module = this.module;
    if (module === undefined) throw new Error("sandbox: engine not initialized");

    const runtime = module.newRuntime();
    // Which guard tripped — the interrupt handler is the ONLY thing that can
    // stop a synchronous runaway loop, so wall-clock rides it too.
    let tripped: "cpu" | "wallClock" | undefined;
    let ticks = 0;
    runtime.setMemoryLimit(this.limits.memoryBytes);

    const vm = runtime.newContext();
    try {
      // The ONLY thing the VM sees: a JSON-marshaled `input` global — seeded as
      // a STRING parsed in-VM (audit PERF-B4: evalCode of an object literal
      // makes the engine parse the input as JS source, slower than JSON.parse
      // and — before the fix — charged against the caller's interrupt budget).
      // No fetch, no require, no process, no timers — capability-empty by
      // construction.
      const json = vm.newString(JSON.stringify(input ?? null));
      vm.setProp(vm.global, "__loomInputJson", json);
      json.dispose();
      const seed = vm.evalCode(
        "globalThis.input = JSON.parse(globalThis.__loomInputJson); delete globalThis.__loomInputJson;"
      );
      if (seed.error !== undefined) {
        const err = vm.dump(seed.error) as { message?: string };
        seed.error.dispose();
        throw new Error(`sandbox: input marshalling failed: ${err.message ?? "unknown"}`);
      }
      seed.value.dispose();

      // Install the guards AFTER seeding, so the user script alone pays the
      // interrupt budget and wall clock.
      const deadline = Date.now() + this.limits.wallClockMs;
      runtime.setInterruptHandler(() => {
        if (ctx.signal?.aborted === true) return true;
        if (Date.now() > deadline) {
          tripped = "wallClock";
          return true;
        }
        if (++ticks > this.limits.interruptBudget) {
          tripped = "cpu";
          return true;
        }
        return false;
      });

      const result = vm.evalCode(script);
      if (result.error !== undefined) {
        const err = vm.dump(result.error) as { name?: string; message?: string };
        result.error.dispose();
        this.mapEngineError(err, tripped, ctx);
      }
      const output = vm.dump(result.value) as unknown;
      // Audit MEM-MEDIUM — `dump` DISPOSES the handle itself when the value is
      // a Promise (verified against quickjs-emscripten 0.31 internals); an
      // unconditional dispose then throws QuickJSUseAfterFree. Guard on alive.
      if (result.value.alive) result.value.dispose();
      return output;
    } finally {
      // Audit MEM-MEDIUM corollary — if vm.dispose() ever throws, the runtime's
      // WASM-heap allocation must still be reclaimed (this.module is a process
      // singleton; a skipped runtime.dispose() leaks the heap permanently).
      try {
        vm.dispose();
      } finally {
        runtime.dispose();
      }
    }
  }

  private mapEngineError(
    err: { name?: string; message?: string },
    tripped: "cpu" | "wallClock" | undefined,
    ctx: EffectContext
  ): never {
    // Audit SEC-5 — script-authored text flows into the durable STEP_FAILED
    // record; bound it so an adversarial script cannot bloat the immutable log.
    const message = `${err.name ?? "Error"}: ${err.message ?? "unknown"}`.slice(0, 2048);
    if (ctx.signal?.aborted === true) {
      // Cancellation is the kernel's outcome (STEP_CANCELLED), not a channel.
      throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error(message);
    }
    if (tripped !== undefined) {
      fail("limitExceeded", { kind: tripped });
    }
    if (/out of memory|memory limit/i.test(message)) {
      fail("limitExceeded", { kind: "memory" });
    }
    if (/interrupted/i.test(message)) {
      // Interrupted without a recorded trigger — attribute to CPU budget.
      fail("limitExceeded", { kind: "cpu" });
    }
    // Ordinary script error (incl. ReferenceError for fetch/require/process) —
    // deliberately untyped: an environment violation is a bug, not an outcome.
    throw new Error(`sandbox script failed: ${message}`);
  }
}
