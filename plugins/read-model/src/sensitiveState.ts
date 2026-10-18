// ── ADR 0132 D11 — the persist-time half of the sensitive-state guard ─────────
// Pure functions only. The engine calls `assertStateClean` after every handler result and before
// anything is written; it never reads a store, a clock or a key. Ciphertext is recognised by SHAPE
// (ADR 0130 D2), so this works on a node that does not load the crypto plugin.

/** Same budget as ADR 0130 D2's bounded walk. Exhausting it is "cannot verify", never "clean". */
export const GUARD_WALK_BUDGET = 100_000;
/** Shorter strings / integers are not lifted: "ok" or 3 would flag ordinary state (documented limit). */
export const MIN_LIFTED_STRING = 6;
export const MIN_LIFTED_DIGITS = 6;

/** Scalar values found under the sensitive paths of the event being folded. */
export interface Lifted {
  readonly strings: ReadonlySet<string>;
  readonly numbers: ReadonlySet<number>;
}
export const NOTHING_LIFTED: Lifted = { strings: new Set<string>(), numbers: new Set<number>() };

/** A plain object with an OWN string `__loomEnc`: a crypto-plugin ciphertext envelope (ADR 0130 D2). */
export function isCipherEnvelope(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.hasOwn(v, "__loomEnc") &&
    typeof (v as { __loomEnc?: unknown }).__loomEnc === "string"
  );
}

export function isLiftable(v: unknown): v is string | number {
  if (typeof v === "string") return v.length >= MIN_LIFTED_STRING;
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    String(Math.abs(Math.trunc(v))).length >= MIN_LIFTED_DIGITS
  );
}

/**
 * Iterative breadth-first visit of every node under `root` (objects and arrays; depth cannot blow the
 * stack). Returns false when the node budget ran out, which callers MUST treat as unverifiable.
 */
export function walkBounded(root: unknown, visit: (value: unknown) => void): boolean {
  const queue: unknown[] = [root];
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > GUARD_WALK_BUDGET) return false;
    const v = queue[i];
    visit(v);
    if (typeof v !== "object" || v === null) continue;
    for (const child of Array.isArray(v) ? v : Object.values(v)) queue.push(child);
  }
  return queue.length <= GUARD_WALK_BUDGET;
}

export interface SensitiveStateContext {
  readonly modelId: string;
  readonly executionId: string;
  readonly eventType: string;
  readonly sequence: number;
}
export type SensitiveStateReason = "sealed-envelope" | "lifted-value" | "unverifiable";

const WHY: Record<SensitiveStateReason, string> = {
  "sealed-envelope": "the new state holds a sealed envelope",
  "lifted-value": "the new state holds a value copied from a sensitive path",
  unverifiable: "the new state is too large to verify",
};

/** Names the model, execution, event and state path. NEVER carries a value, a key or ciphertext. */
export class SensitiveStateError extends Error {
  readonly name = "SensitiveStateError";
  constructor(
    readonly context: SensitiveStateContext,
    readonly reason: SensitiveStateReason,
    readonly statePath: string
  ) {
    super(
      `folded read model "${context.modelId}": ${WHY[reason]} at ${statePath} (execution "${context.executionId}", ${context.eventType} #${context.sequence}) — a folded state is stored in plaintext and must not hold sensitive data (ADR 0132 D11)`
    );
  }
}

/** A key that spells an integer lifted from a sensitive path (`{ "123456789": … }`). */
function liftedNumberKey(lifted: Lifted, key: string): boolean {
  const n = Number(key);
  return Number.isSafeInteger(n) && String(n) === key && lifted.numbers.has(n);
}

/** Refuse a state that would persist ciphertext or a value lifted from a sensitive path. */
export function assertStateClean(ctx: SensitiveStateContext, state: unknown, lifted: Lifted): void {
  const queue: [unknown, string][] = [[state, "$"]];
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > GUARD_WALK_BUDGET) throw new SensitiveStateError(ctx, "unverifiable", "$");
    const [v, path] = queue[i] as [unknown, string];
    if (typeof v === "string") {
      if (lifted.strings.has(v)) throw new SensitiveStateError(ctx, "lifted-value", path);
      continue;
    }
    if (typeof v === "number") {
      if (lifted.numbers.has(v)) throw new SensitiveStateError(ctx, "lifted-value", path);
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    if (isCipherEnvelope(v)) throw new SensitiveStateError(ctx, "sealed-envelope", path);
    if (Array.isArray(v)) {
      v.forEach((child, j) => queue.push([child, `${path}[${j}]`]));
      continue;
    }
    for (const [k, child] of Object.entries(v)) {
      // A key that IS a lifted value is reported by position only: the path must not echo it.
      if (lifted.strings.has(k) || liftedNumberKey(lifted, k)) {
        throw new SensitiveStateError(ctx, "lifted-value", `${path}.<key>`);
      }
      queue.push([child, `${path}.${k}`]);
    }
  }
}
