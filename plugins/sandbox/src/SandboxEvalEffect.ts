import { createHash } from "node:crypto";
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
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Throw unless `bytes` hash to `address` (`sha256:<hex>`, the ContentRef format). */
function assertContentAddress(bytes: Uint8Array, address: string): void {
  const [algorithm, expected] = address.split(":", 2);
  if (algorithm !== "sha256" || expected === undefined) {
    // Refuse rather than skip: an address this code cannot check is an unverifiable script,
    // and silently running it would make the guarantee decorative.
    throw new Error(`sandbox: unsupported script content address "${address}" (expected sha256:)`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `sandbox: script bytes do not match their content address (pinned sha256:${expected}, got sha256:${actual})`
    );
  }
}

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
      maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
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
    // Verify the bytes against the address they were fetched by.
    //
    // The ref is content-ADDRESSED and the contract calls that "immutable provenance" — but
    // `ContentStore.get` carries no obligation to return bytes that hash to the ref, so a
    // buggy or tampered backend could serve different SOURCE than the pin names, and this
    // effect would execute it. Cheap next to spinning up a VM, and this is the one consumer
    // that runs the bytes rather than merely reading them.
    //
    // An integrity failure is an environment violation, not a domain outcome, so it throws
    // rather than completing on a declared channel (the same reasoning as a ReferenceError
    // for `fetch`/`require`).
    assertContentAddress(bytes, call.scriptRef.__loomContent);
    const script = new TextDecoder().decode(bytes);

    this.module ??= await getQuickJS();
    const output = this.evalInFreshRuntime(script, call.input, ctx);

    // Bound what the script EMITS, not just what it consumes. The return value becomes a
    // durable STEP_COMPLETED payload, so an unbounded one lets a script bloat an
    // append-only log — the same threat the 2 KB cap on error text already addresses.
    // Checked before the shape check so an oversized output is reported as the resource
    // kill it is, rather than as a shape mismatch.
    const outputBytes =
      output === undefined ? 0 : Buffer.byteLength(JSON.stringify(output), "utf8");
    if (outputBytes > this.limits.maxOutputBytes) {
      fail("limitExceeded", { kind: "output" });
    }

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
