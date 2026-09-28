import { createHash } from "node:crypto";
import { fail } from "@loom/core";
import type { Effect, EffectContext, ErrorChannelSchema } from "@loom/effect-runtime";
import { type QuickJSWASMModule, getQuickJS } from "quickjs-emscripten";
import { SandboxWorkerPool } from "./SandboxWorkerPool";
import { type EvalLimits, type EvalOutcome, evalInFreshRuntime } from "./evalCore";
import { shapeHash } from "./shape";
import { SANDBOX_ERRORS, SandboxEvalInput, type SandboxEvalInputValue } from "./types";
import type { SandboxLimits, SandboxWorkers, ScriptReader } from "./types";

// ── ADR 0064 — the hardened eval effect ──────────────────────────────────────
//
// A fresh QuickJS runtime per call: memory limit + interrupt budget + wall
// clock enforced IN-ENGINE (the only place that can stop a synchronous runaway
// loop), nothing injected but a JSON-marshaled `input`, the completion value
// marshaled back out as JSON. Resource kills and shape mismatches complete on
// DECLARED channels (ADR 0060) — a planner catches and re-plans, and replay
// substitutes without re-burning CPU. So does the script's own exception
// (`scriptError`, incl. a ReferenceError for fetch/require/process): a caller can
// tell "the script threw on this input" from an infrastructure failure (worker
// pool, integrity, cancellation), which stays UNTYPED.

const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTERRUPT_BUDGET = 10_000;
const DEFAULT_WALL_CLOCK_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Same order as `DEFAULT_MAX_OUTPUT_BYTES` — see `SandboxLimits.maxInputBytes`. */
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;

/**
 * A byte-size option must be a finite number >= 0 (mirrors `nonNegativeMs` in
 * `SandboxWorkerPool.ts`): `NaN` makes every `>` comparison false — a bound that
 * never fires — and a negative value is not a size, so both silently disable the
 * limit instead of refusing it at construction, as `SandboxWorkerPoolOptions`
 * already refuses a bad duration.
 */
function nonNegativeBytes(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`sandbox: ${name} must be a finite number >= 0 (got ${String(value)})`);
  }
  return value;
}

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
  /** Present only when the caller opted into worker threads (ADR 0089). */
  private readonly pool: SandboxWorkerPool | undefined;

  constructor(
    private readonly scripts: ScriptReader,
    limits: SandboxLimits = {},
    workers: SandboxWorkers = {}
  ) {
    this.limits = {
      memoryBytes: limits.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      interruptBudget: limits.interruptBudget ?? DEFAULT_INTERRUPT_BUDGET,
      wallClockMs: limits.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
      maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxInputBytes: nonNegativeBytes(
        "maxInputBytes",
        limits.maxInputBytes,
        DEFAULT_MAX_INPUT_BYTES
      ),
    };
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
  }

  /**
   * Advisory pre-warm (M6): compile the WASM module — the real cold-start cost.
   * In worker mode this spawns the threads and compiles the module on each, so
   * no request pays the thread spawn either.
   */
  async warm(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.warm();
      return;
    }
    this.module ??= await getQuickJS();
  }

  /**
   * Shut the worker pool down. No-op in-process. A pool holds live threads, so a
   * host that never calls this keeps the process alive — the same contract as
   * `IsolatedToolEffect.close()`.
   */
  async close(): Promise<void> {
    await this.pool?.close();
  }

  async execute(rawInput: unknown, ctx: EffectContext): Promise<unknown> {
    const call: SandboxEvalInputValue = SandboxEvalInput.parse(rawInput);

    // Bound what the CALLER supplies, not just what the script emits — measured ONCE,
    // here, before the script is even fetched, so an oversized input never occupies a
    // worker or creates a VM. `input` is `z.unknown()`: nothing upstream bounds it, and
    // every other limit is charged to the script's own execution, which has not started
    // yet — JSON-stringifying a huge `input`, posting it to a worker and parsing it back,
    // or seeding it into a fresh VM, all run OUTSIDE the guarded window. Unbounded, that
    // is bounded only by the worker pool's startup-liveness window (ADR 0089 D4): a 200 MB
    // input can hold a worker busy for ~10 s and then fail with the untyped
    // `SandboxWorkerStartupError`, which default retry middleware retries.
    //
    // `inputJson` is reused verbatim below to seed the VM (in-process) or post to a
    // worker — never re-stringified — so this is the only full serialization of `input`
    // on this call, in either mode. `call.input === undefined` (no input at all) costs
    // nothing, mirroring how an `undefined` OUTPUT is 0 bytes, not the 4 bytes of the
    // `"null"` it seeds either way.
    const inputJson = call.input === undefined ? "null" : JSON.stringify(call.input);
    const inputBytes = call.input === undefined ? 0 : Buffer.byteLength(inputJson, "utf8");
    if (inputBytes > this.limits.maxInputBytes) {
      // Deterministic — retrying the same oversized input cannot help — so this MUST be a
      // typed failure: `retryMiddleware`'s default treats anything that is not a
      // `TypedFailure` as retryable, which is exactly the untyped `SandboxWorkerStartupError`
      // problem above, just for a call that never even needs a worker.
      fail("limitExceeded", { kind: "input" });
    }

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
    // An integrity failure is the infrastructure's fault (the store served the wrong bytes),
    // not an outcome of the script on this input, so it throws UNTYPED rather than completing
    // on a declared channel — the same line `scriptError` draws: only what the script itself
    // did is typed.
    assertContentAddress(bytes, call.scriptRef.__loomContent);
    const script = new TextDecoder().decode(bytes);

    const outcome = await this.evaluate(script, inputJson, ctx);
    if (!outcome.ok) this.mapFailure(outcome, ctx);
    const output = outcome.value;

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

  /**
   * Run the script on whichever engine is wired, and return the SAME outcome
   * type either way. The engines share `evalInFreshRuntime`, so a guard cannot
   * mean one thing in-process and another on a worker; only the thread differs.
   *
   * `inputJson` is already JSON text — measured against `maxInputBytes` by the caller —
   * so neither path re-serializes `input` from scratch.
   */
  private async evaluate(
    script: string,
    inputJson: string,
    ctx: EffectContext
  ): Promise<EvalOutcome> {
    const limits: EvalLimits = {
      memoryBytes: this.limits.memoryBytes,
      interruptBudget: this.limits.interruptBudget,
      wallClockMs: this.limits.wallClockMs,
    };
    if (this.pool !== undefined) {
      return this.pool.run(script, inputJson, limits, ctx.signal);
    }
    this.module ??= await getQuickJS();
    return evalInFreshRuntime(
      this.module,
      script,
      inputJson,
      limits,
      () => ctx.signal?.aborted === true
    );
  }

  /**
   * Outcome → channel. The one place the vocabulary lives: worker mode reports
   * what happened and this decides what it MEANS, so the boundary carries no
   * policy (K7.5 — the kernel side keeps authorize/meter/validate).
   */
  private mapFailure(outcome: Extract<EvalOutcome, { ok: false }>, ctx: EffectContext): never {
    const message = outcome.message;
    if (ctx.signal?.aborted === true) {
      // Cancellation is the kernel's outcome (STEP_CANCELLED), not a channel.
      throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error(message);
    }
    if (outcome.tripped !== undefined) {
      fail("limitExceeded", { kind: outcome.tripped });
    }
    // The engine reports its own kills as an `InternalError` (the QuickJS memory limit has
    // no callback, so there is no trip record for it). Text is read ONLY there: a script's
    // `throw new Error("connection interrupted")` is its own outcome, not a resource kill.
    // Residual: a script can construct `new InternalError("out of memory")` itself; that
    // deliberate forgery is reported as the kill it claims to be — still typed, still bounded.
    const thrown = outcome.thrown;
    if (thrown?.name === "InternalError") {
      if (/out of memory|memory limit/i.test(thrown.message)) {
        fail("limitExceeded", { kind: "memory" });
      }
      if (/^interrupted$/i.test(thrown.message)) {
        // Interrupted without a recorded trigger — attribute to CPU budget.
        fail("limitExceeded", { kind: "cpu" });
      }
    }
    if (thrown !== undefined) {
      // The script's own exception on this input (incl. a SyntaxError, and a
      // ReferenceError for fetch/require/process — the VM cannot tell a missing
      // capability from a typo). A pure function of (script, input), so it is an
      // outcome: typed, substituted on replay, never retried. The legacy text rides
      // the error message for anything that logged it.
      fail("scriptError", thrown, `sandbox script failed: ${message}`);
    }
    // No thrown value and no guard: nothing the script did explains this — untyped.
    throw new Error(`sandbox script failed: ${message}`);
  }
}
