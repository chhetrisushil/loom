import type { FlowDefinition, RetryPolicy, StepDefinition } from "./types/definitions";

// ── K11.1 — the flow content hash ─────────────────────────────────────────────
//
// A deterministic fingerprint of a flow's FOLD-RELEVANT structure, recorded on
// EXECUTION_STARTED and compared on resume/recovery so an in-flight execution
// is never silently folded by different flow code after a deploy.
//
// What it covers — the step GRAPH: flow id + version, the ordered step list,
// each step's effect binding (toolId) and durable policies (retry, timeoutMs),
// and the flow deadline. These are exactly the divergences that change how a
// stored log folds/re-runs (deploy-sim's breaking categories: flow-missing,
// step-removed/renamed/re-bound).
//
// What it deliberately EXCLUDES:
//  - cosmetic metadata (name, description) — renames must not strand executions;
//  - zod schemas and handler code — not stably serializable at runtime. A
//    body-only edit folds an existing log identically (completed steps are
//    served from the log), so the structural hash is the fold-compatibility
//    fingerprint; code-level fingerprints (compiler chunk hashes) can be layered
//    in via the version-aware registry (K11.2 follow-up).
//
// The hash is computed from the normalized in-memory definition — never from
// bundler output — so a rebuild with identical structure yields an identical
// hash (no resume-refusal flapping from non-reproducible builds).

function canonicalRetry(retry: RetryPolicy | undefined): string {
  if (retry === undefined) return "";
  return `${retry.maxAttempts}:${retry.backoffMs ?? ""}:${retry.backoffMultiplier ?? ""}`;
}

function canonicalStep(step: StepDefinition): string {
  return [
    step.id,
    step.toolId ?? step.id,
    step.timeoutMs ?? "",
    canonicalRetry(step.retry),
  ].join("|");
}

/** FNV-1a over the canonical structure — stable, dependency-free, fast. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * K11.1 — deterministic content hash of a flow's fold-relevant structure.
 * Recorded in the `EXECUTION_STARTED` payload (`flowHash`) and compared by
 * `resume()`/recovery against the registered flow, so changed flow code never
 * silently folds an in-flight execution's log.
 */
export function flowContentHash<TIn, TOut>(definition: FlowDefinition<TIn, TOut>): string {
  const canonical = [
    definition.id,
    definition.version,
    definition.deadlineMs ?? "",
    ...definition.steps.map(canonicalStep),
  ].join("\n");
  return `fnv1a:${fnv1a(canonical)}`;
}
