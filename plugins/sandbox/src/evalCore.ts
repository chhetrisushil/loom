import { SANDBOX_MESSAGE_LIMIT, SANDBOX_NAME_LIMIT, boundText } from "@loom/sandbox";
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

/**
 * What the SCRIPT threw, reduced to the two fields that are safe to record: never a
 * stack (it names engine internals and is script-controllable noise), and both
 * bounded. Mirrors the `scriptError` channel payload, which the effect maps it onto.
 */
export interface ScriptThrow {
  /** The thrown value's `name`, when it is an Error-like object with a string name. */
  name?: string;
  /** Its `message`, or a text rendering of a non-Error throw (`throw 42` → `"42"`). */
  message: string;
}

export type EvalOutcome =
  | { ok: true; value: unknown }
  | {
      ok: false;
      /** `Name: message` from the engine, already bounded (see MESSAGE_LIMIT). */
      message: string;
      /** Set only when a guard fired; absent for an ordinary script error. */
      tripped?: TrippedGuard;
      /** The exception the script's own evaluation raised (incl. a SyntaxError). */
      thrown?: ScriptThrow;
      /**
       * Set when the failure happened SEEDING `input` — `JSON.parse`ing it inside the VM,
       * before the script ran at all. Never the script's fault (no script code has run yet),
       * so the caller must not attribute it to one the way `thrown`/`tripped` are. The only
       * realistic cause is the VM's heap ceiling: `input` passed the caller-side
       * `maxInputBytes` check but still overflows `memoryBytes` once parsed (parsing can
       * expand a JSON text well past its own byte length).
       */
      duringSeed?: true;
    };

/** Script-authored text bounds (ADR 0144: `boundText` lives in @loom/sandbox, which re-bounds it anyway). */
export const MESSAGE_LIMIT = SANDBOX_MESSAGE_LIMIT;
export const NAME_LIMIT = SANDBOX_NAME_LIMIT;
export { boundText };

/**
 * Reduce a dumped thrown value to {@link ScriptThrow}. An Error-like object (a string
 * `name` or `message`) keeps those two fields and nothing else; any other value is
 * rendered as text — a string as itself, an object as JSON, the rest via `String`.
 *
 * The value is already a HOST copy (`vm.dump` ran any getter, Proxy trap or `toJSON` the
 * script planted, inside the VM with the guards still armed), so nothing here re-enters
 * script code; the guards on `JSON.stringify` below are for host-side oddities (cycles,
 * BigInt) only.
 */
function toScriptThrow(thrown: unknown): ScriptThrow {
  if (typeof thrown === "object" && thrown !== null) {
    const { name, message } = thrown as { name?: unknown; message?: unknown };
    if (typeof name === "string" || typeof message === "string") {
      const out: ScriptThrow = {
        message: typeof message === "string" ? boundText(message, MESSAGE_LIMIT) : "",
      };
      if (typeof name === "string") out.name = boundText(name, NAME_LIMIT);
      return out;
    }
  }
  return { message: boundText(renderThrown(thrown), MESSAGE_LIMIT) };
}

function renderThrown(thrown: unknown): string {
  if (typeof thrown === "string") return thrown;
  if (typeof thrown === "object" && thrown !== null) {
    try {
      return JSON.stringify(thrown) ?? String(thrown);
    } catch {
      return "[unserializable thrown value]";
    }
  }
  return String(thrown);
}

/**
 * Evaluate `script` in a FRESH QuickJS runtime with `input` as the only global.
 *
 * Synchronous by nature: QuickJS evaluation cannot yield. Whichever thread calls
 * this is blocked for the duration, which is why {@link SandboxWorkerPool}
 * exists — not because the guards are weaker here, but because the caller's
 * event loop should not be the thing that waits.
 *
 * `inputJson` is already JSON text (the caller's `input ?? null`, `JSON.stringify`d
 * once) rather than the raw value: every caller here already needs that string for
 * something else — measuring `maxInputBytes`, or (worker mode) putting it on the wire —
 * so seeding the VM from it directly avoids a second full serialization of the same
 * input on the same thread.
 *
 * `onScriptStart` is called with the instant the wall clock starts — after the runtime
 * exists and the input is seeded — so an outside observer can measure the SAME budget.
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
  inputJson: string,
  limits: EvalLimits,
  isAborted: () => boolean = () => false,
  onScriptStart?: (startedAt: number) => void
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
    // construction. `inputJson` is already the caller's JSON text, so this is
    // the only place it is turned into a VM value.
    const json = vm.newString(inputJson);
    vm.setProp(vm.global, "__loomInputJson", json);
    json.dispose();
    const seed = vm.evalCode(
      "globalThis.input = JSON.parse(globalThis.__loomInputJson); delete globalThis.__loomInputJson;"
    );
    if (seed.error !== undefined) {
      const err = vm.dump(seed.error) as { message?: string };
      seed.error.dispose();
      // Returned as an outcome, not thrown: this is the sandbox reporting what happened
      // (ADR 0089 D3), and deciding what a seed failure MEANS (a resource limit? a caller
      // mistake? untyped?) is the effect's job — same division as `tripped`/`thrown` below.
      return {
        ok: false,
        message: boundText(
          `sandbox: input marshalling failed: ${err.message ?? "unknown"}`,
          MESSAGE_LIMIT
        ),
        duringSeed: true,
      };
    }
    seed.value.dispose();

    // Install the guards AFTER seeding, so the user script alone pays the
    // interrupt budget and wall clock.
    const startedAt = Date.now();
    const deadline = startedAt + limits.wallClockMs;
    // The wall clock starts HERE, and so must anything outside the VM that measures it.
    // The worker pool's hard kill used to stamp its own start before the runtime was
    // created and the input seeded (L13), so a big input — or a loaded host — spent the
    // script's budget before the script ran, and worker mode killed on `wallClock` what
    // in-process mode completed. One origin, handed out, so the two clocks cannot drift.
    onScriptStart?.(startedAt);
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
      // Known, pre-existing: a thrown (or returned) object nested ~100k deep aborts inside
      // `dump`/`dispose` (a QuickJS GC assertion) and surfaces as an untyped host error.
      let dumped: unknown;
      try {
        dumped = vm.dump(result.error);
      } catch {
        dumped = "[unserializable thrown value]";
      }
      if (result.error.alive) result.error.dispose();
      if (tripped !== undefined) {
        // A guard fired: whatever surfaced (usually InternalError "interrupted", or a
        // script's own rethrow from a catch) is the kill, not the script's outcome.
        const err = (typeof dumped === "object" && dumped !== null ? dumped : {}) as {
          name?: unknown;
          message?: unknown;
        };
        const name = typeof err.name === "string" ? err.name : "Error";
        const text = typeof err.message === "string" ? err.message : "unknown";
        return { ok: false, message: boundText(`${name}: ${text}`, MESSAGE_LIMIT), tripped };
      }
      const thrown = toScriptThrow(dumped);
      const message = boundText(
        thrown.name === undefined ? thrown.message : `${thrown.name}: ${thrown.message}`,
        MESSAGE_LIMIT
      );
      return { ok: false, message, thrown };
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
