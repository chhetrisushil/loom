import { createHash } from "node:crypto";
import { fail } from "@loom/core";
import type { Effect, EffectContext, ErrorChannelSchema } from "@loom/effect-runtime";
import { type QuickJSWASMModule, getQuickJS } from "quickjs-emscripten";
import { SandboxWorkerPool } from "./SandboxWorkerPool";
import { type EvalLimits, type EvalOutcome, boundText, evalInFreshRuntime } from "./evalCore";
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
/**
 * Matches `DEFAULT_MEMORY_BYTES`, not `DEFAULT_MAX_OUTPUT_BYTES` — see
 * `SandboxLimits.maxInputBytes` for why: real reshaping inputs measured 1.47–30.9 MB all
 * succeed today under the default heap, so a 1 MiB default would refuse calls that
 * currently work. Derived from the SAME constant on purpose, so the two can never drift
 * apart into a default that (mis)implies a headroom relationship that does not hold.
 */
const DEFAULT_MAX_INPUT_BYTES = DEFAULT_MEMORY_BYTES;

/** Bound on `inputNotSerializable`'s `reason` and the seed-failure message text. */
const REASON_LIMIT = 2048;

/** An `InternalError` message naming the VM's heap ceiling — QuickJS has no other wording for it. */
const OUT_OF_MEMORY = /out of memory|memory limit/i;

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
      maxOutputBytes: nonNegativeBytes(
        "maxOutputBytes",
        limits.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES
      ),
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
    // here, BEFORE the script is even fetched (so a refused call never pays a content-store
    // round trip, and the ordering means an oversized/unserializable input is reported even
    // when the scriptRef is also bad — a deliberate precedence change from before this
    // limit existed, when `scriptMissing` would have fired first). `input` is `z.unknown()`:
    // nothing upstream bounds it, and every other limit is charged to the script's own
    // execution, which has not started yet — JSON-stringifying a huge `input`, posting it to
    // a worker and parsing it back, or seeding it into a fresh VM, all run OUTSIDE the
    // guarded window. Unbounded, that is bounded only by the worker pool's startup-liveness
    // window (ADR 0089 D4): a 200 MB input can hold a worker busy for ~10 s and then fail
    // with the untyped `SandboxWorkerStartupError`, which default retry middleware retries.
    //
    // `inputJson` is reused verbatim below to seed the VM (in-process) or post to a worker —
    // never re-stringified — so this `JSON.stringify` is the only full serialization of
    // `input` on this call, in either mode, and it necessarily happens on THIS thread before
    // its size is known (there is no way to measure "the JSON size" without producing the
    // JSON). `call.input === undefined` (no input at all) costs nothing, mirroring how an
    // `undefined` OUTPUT is 0 bytes, not the 4 bytes of the `"null"` it seeds either way.
    let inputJson: string | undefined;
    try {
      // `JSON.stringify`'s lib type claims it always returns `string`; at runtime it can
      // return the JS value `undefined` for a top-level function/Symbol/`toJSON`, which the
      // check below catches — the cast only corrects the (inaccurate) declared type.
      inputJson =
        call.input === undefined ? "null" : (JSON.stringify(call.input) as string | undefined);
    } catch (err) {
      // A BigInt (`TypeError: Do not know how to serialize a BigInt`), a circular reference
      // (`TypeError: Converting circular structure to JSON`), or a string past V8's length
      // ceiling (`RangeError: Invalid string length`) all throw HERE, synchronously, before
      // either engine is touched. Deterministic — retrying the same input cannot help — so
      // this is typed and non-retryable, not the untyped throw (and three wasted retries)
      // a caller would otherwise see.
      fail("inputNotSerializable", {
        reason: boundText(err instanceof Error ? err.message : String(err), REASON_LIMIT),
      });
    }
    if (inputJson === undefined) {
      // A function, a Symbol, or an explicit `toJSON` returning `undefined` all serialize
      // the TOP-LEVEL value to the JS value `undefined` rather than throwing (nested
      // occurrences are instead dropped or nulled, which is fine). `input` would be
      // unusable to the script — a caller mistake, not "no input" (which seeds a literal
      // `null` and is unaffected).
      fail("inputNotSerializable", {
        reason:
          "input serializes to `undefined` (a function, a Symbol, or a toJSON returning undefined)",
      });
    }
    const inputBytes = call.input === undefined ? 0 : Buffer.byteLength(inputJson, "utf8");
    if (inputBytes > this.limits.maxInputBytes) {
      fail("inputTooLarge", { bytes: inputBytes, limit: this.limits.maxInputBytes });
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
    if (!outcome.ok) this.mapFailure(outcome, ctx, inputBytes);
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
      return this.pool.runJson(script, inputJson, limits, ctx.signal);
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
   *
   * `inputBytes` is the byte length already computed in `execute()` — reused rather than
   * recomputed, for the one channel here that needs to report it (`inputTooLarge`, when a
   * seed OOMs).
   */
  private mapFailure(
    outcome: Extract<EvalOutcome, { ok: false }>,
    ctx: EffectContext,
    inputBytes: number
  ): never {
    const message = outcome.message;
    if (ctx.signal?.aborted === true) {
      // Cancellation is the kernel's outcome (STEP_CANCELLED), not a channel.
      throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error(message);
    }
    if (outcome.duringSeed === true) {
      // No script code has run yet — never `limitExceeded` (the script outcome channel that
      // routes to drift-repair, where a re-authored SCRIPT cannot shrink the caller's input).
      // The only realistic cause is the VM heap ceiling: `input` passed the caller-side
      // `maxInputBytes` check (or the caller raised it) but still overflows `memoryBytes`
      // once parsed. Deterministic given the same input and limits, so typed and
      // non-retryable either way.
      if (OUT_OF_MEMORY.test(message)) {
        fail("inputTooLarge", { bytes: inputBytes, limit: this.limits.memoryBytes });
      }
      // `input` is always well-formed JSON (the caller produced it via `JSON.stringify`), so
      // nothing else should be able to fail a bare `JSON.parse` of it — stay untyped rather
      // than guess a channel for a shape nothing here has actually observed.
      throw new Error(`sandbox: input marshalling failed: ${message}`);
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
      if (OUT_OF_MEMORY.test(thrown.message)) {
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
