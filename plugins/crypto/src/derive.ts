import { pathsOfClass } from "@loom/classify";
import type { StepDefinition } from "@loom/core";

// ── K10-R1 — derive the encryption wiring from classified schemas ──────────────
//
// Instead of hand-authoring `{ STEP_COMPLETED: ["output.ssn"] }` at the store (which drifts
// from the schema and repeats a fact the schema already knows), mark the field once —
// `ssn: sensitive(z.string())` — and derive the map. The convention this encodes is the
// STEP_COMPLETED payload shape: a step's output is stored under `output.*`, so a step whose
// outputSchema marks `ssn` "sensitive" contributes `STEP_COMPLETED → "output.ssn"`.
//
// Only the "sensitive" class maps to at-rest encryption. "secret" is a different mechanism
// (never persisted — substituted/redacted before append), and "internal" is egress-only;
// neither belongs in the crypto map, so both are correctly excluded here.

/** The STEP_COMPLETED payload nests a step's output under this key. */
const OUTPUT_PREFIX = "output";

/**
 * Build the {@link EncryptingEventStore} `sensitive` map from step definitions: every field
 * marked `sensitive(...)` in a step's `outputSchema` becomes a `STEP_COMPLETED` dot-path
 * `output.<path>`. Paths are unioned and de-duplicated across steps (all steps share the
 * STEP_COMPLETED event type); the store applies each path only to events that actually carry
 * it, so unioning across differently-shaped steps is safe.
 *
 * Deterministic output — schema-declaration order, de-duplicated via a seen-set (O(n), not a
 * quadratic includes-scan) with a stable result array (P2/G1).
 */
export function sensitivePathsFromSteps(
  // Only the output schema is read; Pick drops the (invariant) handler field so concrete
  // `StepDefinition<In, Out>` values pass without a cast.
  steps: readonly Pick<StepDefinition, "outputSchema">[]
): Record<string, string[]> {
  const seen = new Set<string>();
  const stepCompleted: string[] = [];
  for (const step of steps) {
    const schema = step.outputSchema;
    if (schema === undefined) continue;
    for (const path of pathsOfClass(schema, "sensitive")) {
      const dotted = `${OUTPUT_PREFIX}.${path}`;
      if (!seen.has(dotted)) {
        seen.add(dotted);
        stepCompleted.push(dotted);
      }
    }
  }
  // Omit the event key entirely when nothing is marked — an empty `sensitive` map is the
  // zero-overhead unwired path (A4/G2), byte-identical to not wrapping the store.
  return stepCompleted.length > 0 ? { STEP_COMPLETED: stepCompleted } : {};
}
