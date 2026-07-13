import { externalizedPaths } from "@loom/classify";
import type { StepDefinition } from "@loom/core";

// ── ADR 0046 — derive the externalize map from `externalized()` marks ──────────
//
// Mark a field once — `doc: externalized(z.object({...}))` — and derive the
// ContentResolvingEventStore `externalize` map, instead of hand-authoring
// `{ STEP_COMPLETED: ["output.doc"] }`. Mirrors `sensitivePathsFromSteps` (crypto): a step's
// output is stored under `output.*` in STEP_COMPLETED, so an externalized output field
// contributes `STEP_COMPLETED → "output.<path>"`.

/** The STEP_COMPLETED payload nests a step's output under this key. */
const OUTPUT_PREFIX = "output";

/**
 * Build the {@link ContentResolvingEventStore} `externalize` map from step definitions: every
 * field marked `externalized()` in a step's `outputSchema` becomes a `STEP_COMPLETED` dot-path
 * `output.<path>`. Paths are unioned + O(n) de-duplicated across steps; an empty map when
 * nothing is marked (zero-overhead unwired path, G2).
 */
export function externalizePathsFromSteps(
  // Only the output schema is read; Pick drops the invariant handler field so concrete
  // `StepDefinition<In, Out>` values pass without a cast.
  steps: readonly Pick<StepDefinition, "outputSchema">[]
): Record<string, string[]> {
  const seen = new Set<string>();
  const stepCompleted: string[] = [];
  for (const step of steps) {
    const schema = step.outputSchema;
    if (schema === undefined) continue;
    for (const path of externalizedPaths(schema)) {
      const dotted = `${OUTPUT_PREFIX}.${path}`;
      if (!seen.has(dotted)) {
        seen.add(dotted);
        stepCompleted.push(dotted);
      }
    }
  }
  return stepCompleted.length > 0 ? { STEP_COMPLETED: stepCompleted } : {};
}
