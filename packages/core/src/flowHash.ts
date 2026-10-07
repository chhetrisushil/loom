import { sha256Hex } from "./sha256";
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
//  - zod schemas and handler code — not stably serializable at runtime. The
//    structural hash is therefore BODY-BLIND: an edit that changes which step ids a
//    re-run asks for goes unseen here. ADR 0113 closes that two ways, neither of which
//    hashes `toString()`: an opt-in toolchain-supplied `FlowDefinition.codeFingerprint`
//    (recorded as `EXECUTION_STARTED.codeHash`), and the runtime's replay-divergence
//    detector (a recorded step the re-run never asked for).
//
// The hash is computed from the normalized in-memory definition — never from
// bundler output — so a rebuild with identical structure yields an identical
// hash (no resume-refusal flapping from non-reproducible builds).
//
// DYNAMIC STEPS (the interpreter pattern, ADR 0061): steps minted at runtime
// inside a runner body (`${id}#${index}`) are deliberately OUTSIDE this hash —
// K11.1 guards the compiled structural skeleton only. Fold-compatibility of a
// data-dependent sequence is guaranteed by the step-identity rule instead (the
// sequence of durable-step identities must be a pure function of logged
// inputs), and dynamic steps bind a static `toolId` to a registered effect, so
// the effect registry — not this hash or the compiler manifest — is their
// load-bearing map.

function canonicalRetry(retry: RetryPolicy | undefined): string {
  if (retry === undefined) return "";
  return `${retry.maxAttempts}:${retry.backoffMs ?? ""}:${retry.backoffMultiplier ?? ""}`;
}

function canonicalStep(step: StepDefinition): string {
  return [step.id, step.toolId ?? step.id, step.timeoutMs ?? "", canonicalRetry(step.retry)].join(
    "|"
  );
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

function canonicalFlow<TIn, TOut>(definition: FlowDefinition<TIn, TOut>): string {
  return [
    definition.id,
    definition.version,
    definition.deadlineMs ?? "",
    ...definition.steps.map(canonicalStep),
  ].join("\n");
}

/**
 * K11.1 — deterministic content hash of a flow's fold-relevant structure.
 * Recorded in the `EXECUTION_STARTED` payload (`flowHash`) and compared by
 * `resume()`/recovery against the registered flow, so changed flow code never
 * silently folds an in-flight execution's log.
 *
 * ADR 0113 D1 — SHA-256 over the same canonical structure (no new inputs), prefixed `sha256:`.
 * The first generation was a 32-bit FNV-1a (`fnv1a:`), which a deploy-time accident can collide;
 * a log that recorded one is still compared against {@link legacyFlowContentHash} — see
 * {@link flowHashMatches}.
 */
export function flowContentHash<TIn, TOut>(definition: FlowDefinition<TIn, TOut>): string {
  return `sha256:${sha256Hex(canonicalFlow(definition))}`;
}

/**
 * The pre-ADR-0113 hash (`fnv1a:`, 32 bits) of the same canonical structure. Kept ONLY so an
 * execution that recorded one is not stranded by the upgrade; new starts never record it.
 */
export function legacyFlowContentHash<TIn, TOut>(definition: FlowDefinition<TIn, TOut>): string {
  return `fnv1a:${fnv1a(canonicalFlow(definition))}`;
}

/**
 * Whether `recorded` (a `flowHash` read from a log) names `definition`'s structure, whichever
 * generation of hash recorded it: a `fnv1a:` recording is compared with the legacy hash of the
 * definition, anything else with the current one.
 */
export function flowHashMatches<TIn, TOut>(
  recorded: string,
  definition: FlowDefinition<TIn, TOut>
): boolean {
  return recorded.startsWith("fnv1a:")
    ? recorded === legacyFlowContentHash(definition)
    : recorded === flowContentHash(definition);
}
