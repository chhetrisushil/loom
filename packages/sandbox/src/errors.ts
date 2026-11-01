import { z } from "zod";

/** Read-side view of the content store (structural — no plugin dependency; the claimCheck idiom). */
export interface ScriptReader {
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
}

/** The step input: which script (by content address), what input, what shape to expect back. */
export const SandboxEvalInput = z.object({
  /** Content-addressed script ref — a blueprint pins its reshaping logic by hash (immutable provenance).
   * `z.custom` keeps the inferred type exactly `{ __loomContent: string }`, so a `ContentRef` assigns directly. */
  scriptRef: z.custom<{ __loomContent: string }>(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { __loomContent?: unknown }).__loomContent === "string"
  ),
  /** JSON input exposed to the script as the global `input`. */
  input: z.unknown().optional(),
  /** Canonical hash of the expected output SHAPE (jsonSchemaHash over the structural skeleton). */
  expectedOutputShapeHash: z.string().optional(),
});

export type SandboxEvalInputValue = z.infer<typeof SandboxEvalInput>;

/**
 * Declared failure channels (ADR 0060).
 *
 * `scriptError` is the script's OWN exception on this input — anything it threw,
 * including a non-Error (`throw 42`), a SyntaxError in its source, and a
 * ReferenceError for a global the capability-empty VM does not have. It carries
 * only the thrown value's `name` (when it has a string one) and a text `message`,
 * both bounded; never a stack. A guard kill is `limitExceeded` even when the
 * script catches it and rethrows. Infrastructure failures — the backend, the
 * content address check, cancellation — stay untyped.
 *
 * `inputTooLarge` and `inputNotSerializable` are about the CALLER's `input`, checked
 * before the script or either engine is touched — never `limitExceeded`, which is
 * recorded as the SCRIPT's own outcome and routes to drift-repair (re-author the
 * script), a fix that cannot shrink or reshape a caller's input. Both are deterministic
 * given the same input, so both are non-retryable.
 *
 * UNTRUSTED TEXT: `name` and `message` are authored by the script, which is often
 * model-written. They are bounded and well-formed (no lone surrogates, no NUL) but
 * NOT taint-wrapped (ADR 0085) — treat them as data for a planner or a log, and never
 * place them in a prompt's instruction position.
 */
export const SANDBOX_ERRORS = {
  scriptMissing: z.object({ ref: z.string() }),
  limitExceeded: z.object({ kind: z.enum(["cpu", "memory", "wallClock", "output"]) }),
  shapeMismatch: z.object({ expected: z.string(), observed: z.string() }),
  scriptError: z.object({
    name: z.string().max(128).optional(),
    message: z.string().max(2048),
  }),
  /**
   * The caller-supplied `input`, once JSON-encoded, is bigger than `maxInputBytes`
   * (`bytes` over `limit`) — OR an input under that ceiling still overflowed the VM heap
   * while being PARSED (`limit` is then `memoryBytes`, the ceiling that actually overflowed).
   * Both are the same class of problem — this input does not fit at this configuration —
   * against one of two ceilings; `limit` says which.
   */
  inputTooLarge: z.object({ bytes: z.number(), limit: z.number() }),
  /**
   * `input` cannot be turned into JSON at all: `JSON.stringify` threw (a BigInt, a
   * circular reference, or a string past V8's length ceiling), or it returned the JS
   * value `undefined` instead of text (a function, a Symbol, or an explicit `toJSON`
   * returning `undefined` at the top level). `reason` is loom-authored, short, and bounded.
   */
  inputNotSerializable: z.object({ reason: z.string().max(2048) }),
};
