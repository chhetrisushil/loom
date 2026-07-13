import { REDACTED, maskPaths, pathsOfClass } from "@loom/classify";
import type { StepDefinition } from "@loom/core";
import type { StepTelemetryInfo, TelemetryAdapter } from "./types";

// ── K10-R6 — egress scrubbing (the "6th surface") ─────────────────────────────
//
// Encryption + redaction keep sensitive data out of the LOG, but telemetry is a separate
// egress: a step's `input`/`output` are handed to adapters that ship them to Datadog / an
// OTel collector / a dashboard — OUTSIDE the trust boundary. K10-R6 scrubs the fields the
// K10-R1 taxonomy already marks, at that boundary, before any adapter sees them.
//
// Scope: `sensitive` (personal/confidential) and `internal` (never-egress) fields are both
// masked. `secret` fields are already handled by K10-R2 (they never reach the log/telemetry
// in the first place), so they need no separate scrubbing here.

/** The mask an egress-scrubbed field is replaced by. Re-exported from `@loom/classify`. */
export const EGRESS_REDACTED = REDACTED;

/** Per-step dot-paths to scrub from the telemetry `input` / `output` payloads. */
export interface StepScrubPaths {
  readonly input: readonly string[];
  readonly output: readonly string[];
}

/**
 * Precompute a `stepId → {input,output} scrub paths` lookup from step schemas: every field
 * marked `sensitive()` or `internal()` (K10-R1) in a step's input/output schema. O(1) access
 * per telemetry callback (a Map, not a per-event schema walk). Steps with nothing to scrub
 * are omitted, so an unmarked app yields an empty Map and scrubbing is a pass-through (G2).
 */
export function scrubPathsByStep(
  // Only id + schemas are read; Pick drops the invariant handler field so concrete
  // `StepDefinition<In, Out>` values pass without a cast.
  steps: readonly Pick<StepDefinition, "id" | "inputSchema" | "outputSchema">[]
): Map<string, StepScrubPaths> {
  const byStep = new Map<string, StepScrubPaths>();
  for (const step of steps) {
    const input = step.inputSchema === undefined ? [] : egressPaths(step.inputSchema);
    const output = step.outputSchema === undefined ? [] : egressPaths(step.outputSchema);
    if (input.length > 0 || output.length > 0) byStep.set(step.id, { input, output });
  }
  return byStep;
}

/** The `sensitive` ∪ `internal` paths of a schema (both must be scrubbed from egress). */
function egressPaths(schema: Parameters<typeof pathsOfClass>[0]): string[] {
  return [...pathsOfClass(schema, "sensitive"), ...pathsOfClass(schema, "internal")];
}

/**
 * Wrap a telemetry adapter so a step's marked `input`/`output` fields are masked BEFORE the
 * inner adapter sees them (K10-R6). Non-step callbacks (flow lifecycle) pass through
 * untouched. With an empty map it is a pure pass-through (G2 — no clone, no walk).
 */
export function scrubbingAdapter(
  inner: TelemetryAdapter,
  byStep: Map<string, StepScrubPaths>
): TelemetryAdapter {
  if (byStep.size === 0) return inner;
  const scrubStep = (info: StepTelemetryInfo): StepTelemetryInfo => {
    const paths = byStep.get(info.stepId);
    if (paths === undefined) return info;
    // Clone only when there is something to change, and only the touched payloads.
    const next: StepTelemetryInfo = { ...info };
    if (info.input !== undefined && paths.input.length > 0) {
      next.input = maskPaths(info.input, paths.input);
    }
    if (info.output !== undefined && paths.output.length > 0) {
      next.output = maskPaths(info.output, paths.output);
    }
    return next;
  };
  // Keep every inner callback as-is (flow lifecycle + onStepRetry carry no step data), and
  // override only the three that surface `input`/`output` — and only when the inner adapter
  // implements them, so an absent callback stays absent (exactOptionalPropertyTypes).
  return {
    ...inner,
    ...(inner.onStepStart && { onStepStart: (info) => inner.onStepStart?.(scrubStep(info)) }),
    ...(inner.onStepComplete && {
      onStepComplete: (info) => inner.onStepComplete?.(scrubStep(info)),
    }),
    ...(inner.onStepFail && { onStepFail: (info) => inner.onStepFail?.(scrubStep(info)) }),
  };
}
