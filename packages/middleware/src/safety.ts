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

export type SafetyPhase = "input" | "output";

export interface SafetyCheckInfo {
  phase: SafetyPhase;
  stepId: string;
  /** The effect input (both phases). */
  input: unknown;
  /** The effect result — present only on the "output" phase. */
  result?: unknown;
}

export interface SafetyVerdict {
  ok: boolean;
  reason?: string;
}

export interface SafetyValidator {
  id: string;
  phase: SafetyPhase;
  category?: string;
  /** Return `{ ok: false }` to block. Should be pure/deterministic. */
  check(info: SafetyCheckInfo): SafetyVerdict;
}

export interface SafetyOptions {
  validators: readonly SafetyValidator[];
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

  const run = (ctx: EffectContext, validators: SafetyValidator[], info: SafetyCheckInfo): void => {
    for (const v of validators) {
      const verdict = v.check(info);
      if (!verdict.ok) {
        const reason = verdict.reason ?? "blocked";
        ctx.emit("SAFETY_BLOCKED", {
          stepId: ctx.stepId,
          validatorId: v.id,
          phase: info.phase,
          reason,
          ...(v.category !== undefined && { category: v.category }),
        });
        throw new SafetyViolationError(v.id, reason, v.category);
      }
    }
  };

  return async (ctx: EffectContext, input: unknown, next): Promise<unknown> => {
    run(ctx, inputValidators, { phase: "input", stepId: ctx.stepId, input });
    const result = await next();
    if (outputValidators.length > 0) {
      run(ctx, outputValidators, { phase: "output", stepId: ctx.stepId, input, result });
    }
    return result;
  };
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
  return {
    id: opts.id ?? "deny-patterns",
    phase,
    category: opts.category ?? "policy",
    check(info) {
      const text = asText(phase === "output" ? info.result : info.input);
      for (const p of patterns) {
        if (p.test(text)) return { ok: false, reason: `matched ${p}` };
      }
      return { ok: true };
    },
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
