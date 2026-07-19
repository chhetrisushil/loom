import { z } from "zod";

// ── ADR 0064 — sandbox contract types ────────────────────────────────────────
//
// The contract SHAPE follows @loom/isolate's IsolatedToolSpec (static spec,
// scalar-marshaled context, no closures over parent state) — but the engine is
// QuickJS-in-WASM: capability-EMPTY by construction. Nothing exists inside the
// VM except what is injected (a JSON-marshaled `input`), so no-I/O is a
// property, not a scrub list.

/** Read-side view of the content store (structural — no plugin dependency; the claimCheck idiom). */
export interface ScriptReader {
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
}

export interface SandboxLimits {
  /** QuickJS heap ceiling. Default 32 MiB. */
  memoryBytes?: number;
  /**
   * CPU budget as interrupt-handler ticks (QuickJS invokes the handler
   * periodically during execution). Default 10_000 — generous for reshaping,
   * lethal for runaway loops.
   */
  interruptBudget?: number;
  /** Wall-clock ceiling for a single eval. Default 1_000ms. */
  wallClockMs?: number;
}

/** Static description of a sandbox executor (P5 — wiring is static). */
export interface SandboxSpec {
  /** The effect id this executor registers under. Default `"sandbox.eval"`. */
  id?: string;
  limits?: SandboxLimits;
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

/** Declared failure channels (ADR 0060). */
export const SANDBOX_ERRORS = {
  scriptMissing: z.object({ ref: z.string() }),
  limitExceeded: z.object({ kind: z.enum(["cpu", "memory", "wallClock"]) }),
  shapeMismatch: z.object({ expected: z.string(), observed: z.string() }),
};
