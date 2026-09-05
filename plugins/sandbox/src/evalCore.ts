import type { QuickJSWASMModule } from "quickjs-emscripten";

// ── ADR 0089 — the one implementation of the guarded eval ────────────────────
//
// Extracted from SandboxEvalEffect so the in-process path and the worker path
// share it BYTE FOR BYTE. Two copies of a memory limit, an interrupt budget and
// a wall clock is two things to keep in step, and the one that drifts is the one
// nobody is running in the test that matters.
//
// It returns an OUTCOME rather than throwing typed failures, because typed
// failures are kernel policy: `fail()` mints a TypedFailure that cannot cross a
// worker boundary, and — following K7's rule that authorize/meter/validate stay
// on the kernel side of an isolation boundary — deciding which channel a kill
// completes on is the effect's job, not the sandbox's.

/** Resource ceilings, fully resolved (no optionals — defaulting happens above). */
export interface EvalLimits {
  memoryBytes: number;
  interruptBudget: number;
  wallClockMs: number;
}

/** Which in-engine guard stopped the script, when one did. */
export type TrippedGuard = "cpu" | "wallClock";

export type EvalOutcome =
  | { ok: true; value: unknown }
  | {
      ok: false;
      /** `Name: message` from the engine, already bounded (see MESSAGE_LIMIT). */
      message: string;
      /** Set only when a guard fired; absent for an ordinary script error. */
      tripped?: TrippedGuard;
    };

/**
 * Script-authored error text flows into a durable STEP_FAILED record (audit
 * SEC-5), so it is bounded before it can bloat the immutable log.
 */
const MESSAGE_LIMIT = 2048;

/**
 * Evaluate `script` in a FRESH QuickJS runtime with `input` as the only global.
 *
 * Synchronous by nature: QuickJS evaluation cannot yield. Whichever thread calls
 * this is blocked for the duration, which is why {@link SandboxWorkerPool}
 * exists — not because the guards are weaker here, but because the caller's
 * event loop should not be the thing that waits.
 *
 * `isAborted` is polled from the interrupt handler so a cooperative caller can
 * stop a script between bytecode ops. It is a courtesy, not a guarantee: a
 * script that allocates heavily between interrupt callbacks reaches neither this
 * nor the wall clock (see the ADR's soft-bound note), and only a hard kill ends
 * that one.
 */
export function evalInFreshRuntime(
  module: QuickJSWASMModule,
  script: string,
  input: unknown,
  limits: EvalLimits,
  isAborted: () => boolean = () => false
): EvalOutcome {
  const runtime = module.newRuntime();
  // Which guard tripped — the interrupt handler is the ONLY thing that can
  // stop a synchronous runaway loop, so wall-clock rides it too.
  let tripped: TrippedGuard | undefined;
  let ticks = 0;
  runtime.setMemoryLimit(limits.memoryBytes);

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
    const deadline = Date.now() + limits.wallClockMs;
    runtime.setInterruptHandler(() => {
      if (isAborted()) return true;
      if (Date.now() > deadline) {
        tripped = "wallClock";
        return true;
      }
      if (++ticks > limits.interruptBudget) {
        tripped = "cpu";
        return true;
      }
      return false;
    });

    const result = vm.evalCode(script);
    if (result.error !== undefined) {
      const err = vm.dump(result.error) as { name?: string; message?: string };
      result.error.dispose();
      const message = `${err.name ?? "Error"}: ${err.message ?? "unknown"}`.slice(0, MESSAGE_LIMIT);
      return tripped === undefined ? { ok: false, message } : { ok: false, message, tripped };
    }
    const value = vm.dump(result.value) as unknown;
    // Audit MEM-MEDIUM — `dump` DISPOSES the handle itself when the value is
    // a Promise (verified against quickjs-emscripten 0.31 internals); an
    // unconditional dispose then throws QuickJSUseAfterFree. Guard on alive.
    if (result.value.alive) result.value.dispose();
    return { ok: true, value };
  } finally {
    // Audit MEM-MEDIUM corollary — if vm.dispose() ever throws, the runtime's
    // WASM-heap allocation must still be reclaimed (the module is a process
    // singleton; a skipped runtime.dispose() leaks the heap permanently).
    try {
      vm.dispose();
    } finally {
      runtime.dispose();
    }
  }
}
