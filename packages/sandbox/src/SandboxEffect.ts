import { createHash } from "node:crypto";
import { TypedFailure, fail } from "@loom/core";
import type { Effect, EffectContext, ErrorChannelSchema } from "@loom/effect-runtime";
import { SANDBOX_MESSAGE_LIMIT, boundText } from "./boundText";
import { SANDBOX_ERRORS, SandboxEvalInput, type SandboxEvalInputValue } from "./errors";
import type { ScriptReader } from "./errors";
import { readCapabilities, validateOutcome } from "./outcome";
import { shapeHash } from "./shape";
import type { SandboxBackend, SandboxBackendCapabilities, SandboxOutcome } from "./types";

// ── ADR 0064 / 0144 — the guarantees around a backend ────────────────────────
//
// `evaluate()` on a backend is the only engine-specific step. Everything around it — the input
// ceiling and serialisability check, the content-address check on the script bytes, the output
// ceiling, the shape check, bounded and storable error text, cancellation precedence and the
// outcome → channel mapping — lives here ONCE, so a backend author cannot get it subtly wrong.

export const DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_WALL_CLOCK_MS = 1_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * How long past `wallClockMs` a backend may take to settle before the effect stops waiting
 * (ADR 0144 D2). Generous on purpose: a remote backend legitimately spends a cold start, a
 * queue wait and a hard-kill grace outside the script's own clock.
 */
export const DEFAULT_BACKEND_GRACE_MS = 60_000;
/** The largest delay `setTimeout` honours; a larger one fires immediately. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * Matches `DEFAULT_MEMORY_BYTES`, not `DEFAULT_MAX_OUTPUT_BYTES`: real reshaping inputs measured
 * 1.47–30.9 MB all succeed under the default heap, so a 1 MiB default would refuse calls that work.
 * Derived from the SAME constant on purpose, so the two cannot drift apart.
 */
export const DEFAULT_MAX_INPUT_BYTES = DEFAULT_MEMORY_BYTES;

/** Bound on `inputNotSerializable`'s `reason`. */
const REASON_LIMIT = 2048;

export interface SandboxEffectLimits {
  /** Heap ceiling handed to the backend. Default 32 MiB. */
  memoryBytes?: number;
  /** Wall-clock ceiling handed to the backend. Default 1_000ms. */
  wallClockMs?: number;
  /** Ceiling on the JSON size of the value a script may return. Default 1 MiB. */
  maxOutputBytes?: number;
  /** Ceiling on the JSON size of the caller-supplied `input`. Default 32 MiB. */
  maxInputBytes?: number;
}

export interface SandboxEffectOptions {
  limits?: SandboxEffectLimits;
  /**
   * Permit a backend whose scripts can reach a network (`network !== "none"`). Refused by
   * default; the same shape as `trustDescriptions` (ADR 0125 D14). An effect over such a backend
   * is NOT idempotent: the script is no longer a pure function of (script, input).
   */
  allowNetwork?: boolean;
  /**
   * Permit a backend that reuses its environment between runs (`freshPerRun: false`). Refused by
   * default: one model-written script could leave state for the next, which may be another tenant's.
   */
  allowReusedEnvironment?: boolean;
  /**
   * How long past `limits.wallClockMs` to wait for the backend to settle before giving up with an
   * UNTYPED `sandbox backend did not settle within …` error (ADR 0144 D2). Default 60_000. Must be
   * a finite number >= 0; it must cover everything the backend does OUTSIDE the script's clock
   * (cold start, queueing, a hard-kill grace).
   */
  backendGraceMs?: number;
}

/**
 * A byte-size option must be a finite number >= 0: `NaN` makes every `>` comparison false — a
 * bound that never fires — and a negative value is not a size, so both would silently disable the
 * limit instead of refusing it at construction.
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

export class SandboxEffect implements Effect {
  readonly kind = "tool" as const;
  /**
   * Pure function of (script, input) — at-least-once re-runs are safe by construction (K9.3) —
   * exactly when the scripts cannot reach a network AND no state carries between runs (ADR 0144 D4).
   */
  readonly idempotent: boolean;
  readonly errors: Record<string, ErrorChannelSchema> = SANDBOX_ERRORS;
  /** The VETTED, frozen snapshot of what the backend declared at construction (ADR 0144 D4). */
  readonly capabilities: Readonly<SandboxBackendCapabilities>;

  private readonly limits: Required<SandboxEffectLimits>;
  private readonly backendGraceMs: number;

  constructor(
    private readonly scripts: ScriptReader,
    readonly backend: SandboxBackend,
    options: SandboxEffectOptions = {}
  ) {
    if (typeof backend !== "object" || backend === null || typeof backend.evaluate !== "function") {
      throw new Error("sandbox: backend must implement evaluate()");
    }
    // Read ONCE and keep the copy: a getter or a later mutation can no longer change what was vetted.
    const caps = readCapabilities(backend.capabilities);
    this.capabilities = caps;
    if (caps.network !== "none" && options.allowNetwork !== true) {
      throw new Error(
        `sandbox: backend declares network "${caps.network}"; pass allowNetwork: true to accept a sandbox whose scripts can reach a network`
      );
    }
    if (!caps.freshPerRun && options.allowReusedEnvironment !== true) {
      throw new Error(
        "sandbox: backend declares freshPerRun: false; pass allowReusedEnvironment: true to accept a sandbox that carries state from one run to the next"
      );
    }
    this.idempotent = caps.network === "none" && caps.freshPerRun;
    this.backendGraceMs = nonNegativeBytes(
      "backendGraceMs",
      options.backendGraceMs,
      DEFAULT_BACKEND_GRACE_MS
    );
    const limits = options.limits ?? {};
    this.limits = {
      memoryBytes: limits.memoryBytes ?? DEFAULT_MEMORY_BYTES,
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
  }

  /** Advisory pre-warm: delegates to the backend. */
  async warm(): Promise<void> {
    await this.backend.warm?.();
  }

  /** Release the backend's pools / connections. A host that never calls this may keep the process alive. */
  async close(): Promise<void> {
    await this.backend.close?.();
  }

  async execute(rawInput: unknown, ctx: EffectContext): Promise<unknown> {
    const call: SandboxEvalInputValue = SandboxEvalInput.parse(rawInput);

    // Bound what the CALLER supplies, not just what the script emits — measured ONCE, here,
    // BEFORE the script is even fetched (a refused call never pays a content-store round trip).
    // `input` is `z.unknown()`: nothing upstream bounds it, and every other limit is charged to
    // the script's own execution, which has not started yet. `inputJson` is handed to the backend
    // verbatim, never re-stringified, so this is the only full serialization of `input`.
    let inputJson: string | undefined;
    try {
      // `JSON.stringify`'s lib type claims it always returns `string`; at runtime it can return
      // `undefined` for a top-level function/Symbol/`toJSON`, which the check below catches.
      inputJson =
        call.input === undefined ? "null" : (JSON.stringify(call.input) as string | undefined);
    } catch (err) {
      // A BigInt, a circular reference, or a string past V8's length ceiling throw HERE,
      // before any engine is touched. Deterministic, so typed and non-retryable.
      fail("inputNotSerializable", {
        reason: boundText(err instanceof Error ? err.message : String(err), REASON_LIMIT),
      });
    }
    if (inputJson === undefined) {
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
    // Verify the bytes against the address they were fetched by: `ContentStore.get` carries no
    // obligation to return bytes that hash to the ref, and this is the one consumer that RUNS them.
    // An integrity failure is the infrastructure's fault, not the script's outcome: UNTYPED.
    assertContentAddress(bytes, call.scriptRef.__loomContent);
    const script = new TextDecoder().decode(bytes);

    const outcome = await this.evaluate(script, inputJson, ctx);
    if (!outcome.ok) this.mapFailure(outcome, inputBytes);

    // Bound what the script EMITS: the return value becomes a durable STEP_COMPLETED payload.
    // Checked before the shape check so an oversized output is the resource kill it is.
    //
    // The value returned is the JSON ROUND-TRIP of what the backend produced (ADR 0144 D3): a
    // durable store keeps the step output as JSON, so replay hands the flow the JSON form, and the
    // first run must hand it the same thing (`NaN` → `null`; a prototype, a getter, a Date → plain).
    let output: unknown;
    if (outcome.value !== undefined) {
      let text: string | undefined;
      try {
        text = JSON.stringify(outcome.value) as string | undefined;
      } catch (err) {
        throw new Error(
          `sandbox: backend returned a value that is not JSON (${boundText(err instanceof Error ? err.message : String(err), REASON_LIMIT)})`
        );
      }
      if (text === undefined) {
        throw new Error("sandbox: backend returned a value that is not JSON");
      }
      if (Buffer.byteLength(text, "utf8") > this.limits.maxOutputBytes) {
        fail("limitExceeded", { kind: "output" });
      }
      output = JSON.parse(text);
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
   * Call the backend and validate what came back. Cancellation wins over everything: an aborted
   * signal throws the kernel's cancellation whatever the backend reported — or threw — and even
   * if it never settles (the call is RACED against the abort and a `wallClockMs + backendGraceMs`
   * deadline). The backend gets a COMBINED signal, aborted on either, so a well-behaved one stops.
   * Timers and listeners are released on every path.
   */
  private async evaluate(
    script: string,
    inputJson: string,
    ctx: EffectContext
  ): Promise<SandboxOutcome> {
    const caller = ctx.signal;
    const combined = new AbortController();
    const waitMs = Math.min(this.limits.wallClockMs + this.backendGraceMs, MAX_TIMER_MS);
    const deadlineError = new Error(
      `sandbox backend did not settle within ${this.limits.wallClockMs + this.backendGraceMs}ms`
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let raw: unknown;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          combined.abort(deadlineError);
          reject(deadlineError);
        }, waitMs);
        if (caller !== undefined) {
          onAbort = () => {
            combined.abort(caller.reason);
            reject(caller.reason);
          };
          if (caller.aborted) onAbort();
          else caller.addEventListener("abort", onAbort, { once: true });
        }
      });
      // Nothing waits on `interrupted` once the race is lost; never an unhandled rejection.
      interrupted.catch(() => {});
      raw = await Promise.race([
        this.backend.evaluate({
          script,
          inputJson,
          limits: { wallClockMs: this.limits.wallClockMs, memoryBytes: this.limits.memoryBytes },
          signal: combined.signal,
        }),
        interrupted,
      ]);
    } catch (err) {
      throwIfAborted(ctx, err);
      if (err === deadlineError) throw err;
      throw classifyThrown(err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) caller?.removeEventListener("abort", onAbort);
    }
    // Cancellation is the kernel's outcome (STEP_CANCELLED), not a channel — checked BEFORE the
    // outcome is even validated, so a malformed outcome on a cancelled run is still a cancellation.
    throwIfAborted(ctx);
    try {
      return validateOutcome(raw);
    } catch (err) {
      throw classifyThrown(err);
    }
  }

  /** Outcome → channel. The one place the vocabulary lives. */
  private mapFailure(outcome: Extract<SandboxOutcome, { ok: false }>, inputBytes: number): never {
    switch (outcome.kind) {
      case "limit":
        return fail("limitExceeded", { kind: outcome.limit });
      case "inputTooLarge":
        // No script code has run yet — never `limitExceeded` (a re-authored SCRIPT cannot shrink
        // the caller's input). `limit` is the ceiling that actually overflowed: the heap.
        return fail("inputTooLarge", { bytes: inputBytes, limit: this.limits.memoryBytes });
      case "threw": {
        // The script's own exception on this input: a pure function of (script, input), so an
        // outcome — typed, substituted on replay, never retried.
        const payload =
          outcome.name === undefined
            ? { message: outcome.message }
            : { name: outcome.name, message: outcome.message };
        const text =
          outcome.name === undefined ? outcome.message : `${outcome.name}: ${outcome.message}`;
        return fail(
          "scriptError",
          payload,
          `sandbox script failed: ${boundText(text, SANDBOX_MESSAGE_LIMIT)}`
        );
      }
      case "infrastructure":
        // Retryable, like the worker pool's failures: only what the script itself did is typed.
        throw new Error(`sandbox backend failed: ${outcome.message}`);
    }
  }
}

function throwIfAborted(ctx: EffectContext, fallback?: unknown): void {
  if (ctx.signal?.aborted !== true) return;
  const reason: unknown = ctx.signal.reason;
  if (reason instanceof Error) throw reason;
  throw fallback instanceof Error ? fallback : new Error("sandbox: cancelled");
}

/**
 * Whatever a backend throws is an UNTYPED failure, and its text is bounded (ADR 0144 D2): the
 * kernel records `String(err)` in STEP_FAILED, an append-only log. A `TypedFailure` is rewrapped —
 * a channel is a claim about what the SCRIPT did, and only the effect makes it. A small `Error`
 * passes through unchanged (so a backend's own error classes stay `instanceof`-checkable); anything
 * else becomes a bounded, storable `Error` carrying the original as `cause`.
 */
function classifyThrown(err: unknown): Error {
  let text: string;
  try {
    text = String(err);
  } catch {
    text = "unprintable value thrown by the sandbox backend";
  }
  const bounded = boundText(text, SANDBOX_MESSAGE_LIMIT);
  if (err instanceof TypedFailure) {
    return new Error(`sandbox backend threw a typed failure: ${bounded}`, { cause: err });
  }
  if (err instanceof Error && bounded === text) return err;
  return new Error(bounded, { cause: err });
}
