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
  // Integers only (D11): a float's decimal form is not canonical, so it is not lifted.
  return (
    typeof v === "number" && Number.isInteger(v) && String(Math.abs(v)).length >= MIN_LIFTED_DIGITS
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
  readonly context: SensitiveStateContext;
  constructor(
    context: SensitiveStateContext,
    readonly reason: SensitiveStateReason,
    readonly statePath: string
  ) {
    super(
      `folded read model "${context.modelId}": ${WHY[reason]} at ${statePath} (execution "${context.executionId}", ${context.eventType} #${context.sequence}) — a folded state is stored in plaintext and must not hold sensitive data (ADR 0132 D11)`
    );
    // Copy only the four named fields: a wider caller object must not ride along on the error.
    this.context = {
      modelId: context.modelId,
      executionId: context.executionId,
      eventType: context.eventType,
      sequence: context.sequence,
    };
  }
}

/** Canonical decimal form: "123456789" <-> 123456789, but not "0123456789" or "1e3". */
function canonicalNumber(s: string): number | undefined {
  const n = Number(s);
  return Number.isInteger(n) && String(n) === s ? n : undefined;
}

/** A string equal to a lifted string, or the canonical decimal form of a lifted integer. */
function leaksString(lifted: Lifted, s: string): boolean {
  if (lifted.strings.has(s)) return true;
  const n = canonicalNumber(s);
  return n !== undefined && lifted.numbers.has(n);
}

/** A number equal to a lifted integer, or whose decimal form is a lifted string. */
function leaksNumber(lifted: Lifted, n: number): boolean {
  return lifted.numbers.has(n) || (Number.isInteger(n) && lifted.strings.has(String(n)));
}

type Segment = { readonly key: string } | { readonly index: number };
interface Node {
  readonly value: unknown;
  readonly parent: Node | undefined;
  readonly seg: Segment | undefined;
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A key is echoed only when it is a plain identifier that contains nothing lifted, in any case. */
function renderKey(lifted: Lifted, key: string): string {
  if (!PLAIN_KEY.test(key)) return "<key>";
  const lower = key.toLowerCase();
  for (const s of lifted.strings) if (lower.includes(s.toLowerCase())) return "<key>";
  for (const n of lifted.numbers) if (lower.includes(String(Math.abs(n)))) return "<key>";
  return key;
}

function render(lifted: Lifted, node: Node): string {
  const parts: string[] = [];
  for (let n: Node | undefined = node; n?.seg; n = n.parent) {
    parts.push("index" in n.seg ? `[${n.seg.index}]` : `.${renderKey(lifted, n.seg.key)}`);
  }
  return `$${parts.reverse().join("")}`;
}

/** Refuse a state that would persist ciphertext or a value lifted from a sensitive path. */
export function assertStateClean(ctx: SensitiveStateContext, state: unknown, lifted: Lifted): void {
  const queue: Node[] = [{ value: state, parent: undefined, seg: undefined }];
  const refuse = (reason: SensitiveStateReason, node: Node, keyAt?: string): never => {
    const path = render(lifted, node);
    throw new SensitiveStateError(ctx, reason, keyAt === undefined ? path : `${path}.<key>`);
  };
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > GUARD_WALK_BUDGET) throw new SensitiveStateError(ctx, "unverifiable", "$");
    const node = queue[i] as Node;
    const v = node.value;
    if (typeof v === "string") {
      if (leaksString(lifted, v)) refuse("lifted-value", node);
      continue;
    }
    if (typeof v === "number") {
      if (leaksNumber(lifted, v)) refuse("lifted-value", node);
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    if (isCipherEnvelope(v)) refuse("sealed-envelope", node);
    if (Array.isArray(v)) {
      v.forEach((child, index) => queue.push({ value: child, parent: node, seg: { index } }));
      continue;
    }
    for (const [key, child] of Object.entries(v)) {
      // A key that IS a lifted value is reported by position only: the path must not echo it.
      if (leaksString(lifted, key)) refuse("lifted-value", node, key);
      queue.push({ value: child, parent: node, seg: { key } });
    }
  }
}
