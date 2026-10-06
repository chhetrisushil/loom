import type { EffectContext, EffectMiddleware } from "@loom/effect-runtime";

// ── Behavioral safety ring (Loom 2.0 K6) ─────────────────────────────────────
//
// K2 governs *who may act*; K3 governs *how much it costs*. Neither governs
// *whether the action or its output is safe* — the guarantee an autonomous
// intelligent system most needs. K6 adds a governed check on the effect path:
// pluggable validators inspect an effect's INPUT before it runs (block an unsafe
// action, like K3 admission control) and its OUTPUT after (stop an unsafe result
// from propagating). A block is a durable `SAFETY_BLOCKED` fact (folded into a
// reserved `variables._safety` audit list) and throws `SafetyViolationError`,
// which fails the step via the normal `STEP_FAILED` path — exactly like a K3 quota
// trip. Opt-in and replay-safe: unwired, an effect runs identically to today
// (P10); a block is a logged fact served from the log on replay (P9), so a blocked
// run reconstructs identically. Validators run only on live execution (replay
// serves completed/failed steps from the log and never re-invokes them); keep them
// cheap and pure for latency and auditability, and route any ML/LLM classifier
// verdict through the decision seam (P9) if it must be reproduced.

export type SafetyPhase = "input" | "output" | "delta";

export interface SafetyCheckInfo {
  phase: SafetyPhase;
  stepId: string;
  /** The effect input ("input" and "output" phases; `undefined` on "delta"). */
  input: unknown;
  /** The effect result — present only on the "output" phase. */
  result?: unknown;
  /**
   * The RUNNING text of a streamed call — present only on the "delta" phase. It is the
   * last {@link SafetyOptions.deltaWindow} characters received so far INCLUDING the delta
   * under test, so a pattern split across deltas is seen whole (up to the window).
   */
  text?: string;
}

export interface SafetyVerdict {
  ok: boolean;
  reason?: string;
}

export interface SafetyValidator {
  id: string;
  phase: SafetyPhase;
  category?: string;
  /**
   * Return `{ ok: false }` to block. Should be pure/deterministic. A `"delta"`-phase
   * validator receives `info.text` (the running streamed text) and runs ONLY on a
   * streamed call, severing the stream before the offending delta is delivered.
   */
  check(info: SafetyCheckInfo): SafetyVerdict;
  /**
   * ADR 0119 — the DELTA FORM of an `"output"` validator: the same policy applied to the
   * running text of a streamed call (`info.phase === "delta"`, `info.text`). An output
   * validator WITHOUT one cannot see a stream, so when any is configured the runtime
   * REFUSES streaming to every delta sink — per-call and configured (`EffectMiddleware.inspectsOutput`) rather than stream
   * text past it. The output form still runs on the final result either way.
   */
  checkDelta?(info: SafetyCheckInfo): SafetyVerdict;
}

export interface SafetyOptions {
  validators: readonly SafetyValidator[];
  /**
   * ADR 0119 — how many trailing characters of a streamed call's running text a delta
   * check sees (default 4096). It bounds per-delta cost (the check is O(window), not
   * O(text so far)). A pattern that SPANS more than the window across deltas can evade
   * the delta check; the output form still sees the whole result, but by then the
   * caller's live tail has already received it. Text BEFORE a match completes is also
   * delivered (a card number is severed at its last digit, not its first) — a delta
   * form narrows what a live tail can show, it does not make a stream as safe as a
   * buffered result.
   */
  deltaWindow?: number;
}

export class SafetyViolationError extends Error {
  readonly validatorId: string;
  readonly category: string | undefined;
  readonly reason: string;
  constructor(validatorId: string, reason: string, category?: string) {
    super(`Safety violation [${validatorId}]: ${reason}`);
    this.name = "SafetyViolationError";
    this.validatorId = validatorId;
    this.category = category;
    this.reason = reason;
  }
}

export function safetyMiddleware(options: SafetyOptions): EffectMiddleware {
  const inputValidators = options.validators.filter((v) => v.phase === "input");
  const outputValidators = options.validators.filter((v) => v.phase === "output");
  // The delta checks: a delta-phase validator's `check`, an output validator's `checkDelta`.
  const deltaChecks: Array<{ v: SafetyValidator; run: (i: SafetyCheckInfo) => SafetyVerdict }> = [];
  for (const v of options.validators) {
    if (v.phase === "delta") deltaChecks.push({ v, run: (i) => v.check(i) });
    else if (v.phase === "output" && v.checkDelta !== undefined) {
      const f = v.checkDelta.bind(v);
      deltaChecks.push({ v, run: f });
    }
  }
  const uncoveredOutput = outputValidators.some((v) => v.checkDelta === undefined);
  const window = Math.max(1, options.deltaWindow ?? 4096);

  const block = (ctx: EffectContext, v: SafetyValidator, phase: SafetyPhase, reason: string) => {
    ctx.emit("SAFETY_BLOCKED", {
      stepId: ctx.stepId,
      validatorId: v.id,
      phase,
      reason,
      ...(v.category !== undefined && { category: v.category }),
    });
    throw new SafetyViolationError(v.id, reason, v.category);
  };

  const run = (ctx: EffectContext, validators: SafetyValidator[], info: SafetyCheckInfo): void => {
    for (const v of validators) {
      const verdict = v.check(info);
      if (!verdict.ok) block(ctx, v, info.phase, verdict.reason ?? "blocked");
    }
  };

  const mw = async (ctx: EffectContext, input: unknown, next: () => Promise<unknown>) => {
    run(ctx, inputValidators, { phase: "input", stepId: ctx.stepId, input });
    const result = await next();
    if (outputValidators.length > 0) {
      run(ctx, outputValidators, { phase: "output", stepId: ctx.stepId, input, result });
    }
    return result;
  };

  return Object.assign(mw, {
    // An output validator with no delta form cannot see a stream: tell the runtime so it
    // refuses a live sink instead of streaming text past it (fail-closed).
    ...(uncoveredOutput && { inspectsOutput: true as const }),
    ...(deltaChecks.length > 0 && {
      deltaGuard: (ctx: EffectContext) => {
        let text = "";
        return (delta: string): void => {
          text = (text + delta).slice(-window);
          for (const { v, run: check } of deltaChecks) {
            const verdict = check({ phase: "delta", stepId: ctx.stepId, input: undefined, text });
            if (!verdict.ok) block(ctx, v, "delta", verdict.reason ?? "blocked");
          }
        };
      },
    }),
  }) as EffectMiddleware;
}

// ── Built-in validators ──────────────────────────────────────────────────────

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/** Block if the checked value (input or result) matches any pattern (jailbreak/policy). */
export function denyPatterns(
  patterns: readonly RegExp[],
  opts: { id?: string; phase?: SafetyPhase; category?: string } = {}
): SafetyValidator {
  const phase = opts.phase ?? "output";
  const scan = (text: string): SafetyVerdict => {
    for (const p of patterns) {
      if (p.test(text)) return { ok: false, reason: `matched ${p}` };
    }
    return { ok: true };
  };
  return {
    id: opts.id ?? "deny-patterns",
    phase,
    category: opts.category ?? "policy",
    check(info) {
      return scan(
        info.phase === "delta"
          ? (info.text ?? "")
          : asText(phase === "output" ? info.result : info.input)
      );
    },
    // The delta form of the default (output) validator: the same patterns over the running
    // text, so a default config protects a stream. An input-phase validator has none.
    ...(phase === "output" && { checkDelta: (info: SafetyCheckInfo) => scan(info.text ?? "") }),
  };
}

/** Block if the checked value contains obvious PII (email, US SSN, card-like digits). */
export function piiValidator(opts: { id?: string; phase?: SafetyPhase } = {}): SafetyValidator {
  const PII: RegExp[] = [
    /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, // email
    /\b\d{3}-\d{2}-\d{4}\b/, // US SSN
    /\b(?:\d[ -]?){13,16}\b/, // card-like
  ];
  return {
    ...denyPatterns(PII, { id: opts.id ?? "pii", ...(opts.phase && { phase: opts.phase }) }),
    category: "pii",
  };
}

/** A minimal Zod-compatible shape — anything with a `safeParse`. */
export interface SchemaLike {
  safeParse(value: unknown): { success: boolean };
}

/** Enforce an effect's output schema at runtime (schemas are defined-but-unchecked today). */
export function schemaValidator(schema: SchemaLike, opts: { id?: string } = {}): SafetyValidator {
  return {
    id: opts.id ?? "schema",
    phase: "output",
    category: "schema",
    check(info) {
      return schema.safeParse(info.result).success
        ? { ok: true }
        : { ok: false, reason: "output failed schema validation" };
    },
  };
}

/** A real kill-switch: block every effect while `isTripped()` returns true (distinct from K4). */
export function killSwitch(isTripped: () => boolean, opts: { id?: string } = {}): SafetyValidator {
  return {
    id: opts.id ?? "kill-switch",
    phase: "input",
    category: "kill-switch",
    check() {
      return isTripped() ? { ok: false, reason: "kill-switch engaged" } : { ok: true };
    },
  };
}
