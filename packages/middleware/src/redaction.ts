import { pathsOfClass } from "@loom/classify";
import type { StepDefinition } from "@loom/core";
import type { EffectContext, EffectMiddleware } from "@loom/effect-runtime";

// ── K10.3 — redaction markers: keep secrets OUT of the log entirely ───────────
//
// K10.2 (crypto-shredding) stores an encrypted secret IN the log and erases it
// by destroying the key. K10.3 goes further for values that must never be
// persisted at all: a step's input carries a deterministic REFERENCE
// (`secretRef("stripe-key")`) instead of the raw secret, so the STEP_STARTED
// event — and the fold, and every snapshot — only ever contains the reference.
// A `SecretResolver` resolves the reference to the real value at effect-execution
// time (this middleware runs kernel-side, before the K7 boundary, so an isolated
// tool receives the resolved value while the parent's LOG never sees it — A5).
// The MUST is "secrets never enter the log", and it holds with or without K7.

/** The deterministic reference that stands in for a secret in step I/O and the log. */
export interface SecretRef {
  readonly __loomSecret: string;
}

export function secretRef(id: string): SecretRef {
  return { __loomSecret: id };
}

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { __loomSecret?: unknown }).__loomSecret === "string"
  );
}

/**
 * Resolves secret references to their real values (read) and, for output
 * redaction, stores a value under a reference (write). Back it with a vault /
 * KMS / secret manager in production; the resolver is the boundary the plaintext
 * lives behind. `InMemorySecretResolver` is for tests.
 */
export interface SecretResolver {
  resolve(id: string): Promise<unknown> | unknown;
  /** Optional — required only when `redactOutput` mints references from results. */
  store?(id: string, value: unknown): Promise<void> | void;
}

export class InMemorySecretResolver implements SecretResolver {
  constructor(private readonly secrets: Map<string, unknown> = new Map()) {}
  resolve(id: string): unknown {
    if (!this.secrets.has(id)) throw new Error(`no secret registered for reference "${id}"`);
    return this.secrets.get(id);
  }
  store(id: string, value: unknown): void {
    this.secrets.set(id, value);
  }
}

export interface RedactionOptions {
  resolver: SecretResolver;
  /**
   * Output dot-paths (per effect) whose values must NOT enter the log: the value
   * is stored in the resolver under a deterministic reference
   * (`executionId:stepId:path`) and REPLACED by that reference in the result, so
   * STEP_COMPLETED logs the reference. Requires `resolver.store`. Omit to only
   * resolve input references (the common case).
   */
  redactOutput?: (info: { stepId: string }) => readonly string[];
}

async function deepResolve(value: unknown, resolver: SecretResolver): Promise<unknown> {
  if (isSecretRef(value)) return resolver.resolve(value.__loomSecret);
  if (Array.isArray(value)) return Promise.all(value.map((v) => deepResolve(v, resolver)));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await deepResolve(v, resolver);
    return out;
  }
  return value;
}

function getPath(
  root: unknown,
  path: string
): { parent: Record<string, unknown>; leaf: string } | undefined {
  const segs = path.split(".");
  let cursor = root as Record<string, unknown> | undefined;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cursor?.[segs[i] as string];
    cursor =
      typeof next === "object" && next !== null ? (next as Record<string, unknown>) : undefined;
    if (cursor === undefined) return undefined;
  }
  const leaf = segs[segs.length - 1] as string;
  return cursor !== undefined && Object.hasOwn(cursor, leaf) ? { parent: cursor, leaf } : undefined;
}

/**
 * K10.3 — redaction middleware. Runs on the effect path (like metering/safety):
 *  - **input**: resolves every `SecretRef` in the effect input to its real value
 *    before the tool runs, WITHOUT touching the logged input (STEP_STARTED keeps
 *    the reference — the secret never enters the log).
 *  - **output** (optional): replaces marked result fields with deterministic
 *    references (storing the value in the resolver), so STEP_COMPLETED logs the
 *    reference, not the secret.
 *
 * Unwired (no middleware), effects run byte-identically; with it but no refs in
 * play, it is a deep-walk pass-through (G2).
 */
export function redactionMiddleware(options: RedactionOptions): EffectMiddleware {
  return async (ctx: EffectContext, input: unknown, next): Promise<unknown> => {
    // Input phase — resolve references into the value the tool actually sees,
    // WITHOUT touching the logged input (STEP_STARTED keeps the reference).
    const resolvedInput = await deepResolve(input, options.resolver);
    const result = await next(resolvedInput);

    // Output phase — redact marked result fields into references.
    const paths = options.redactOutput?.({ stepId: ctx.stepId }) ?? [];
    if (paths.length === 0) return result;
    if (options.resolver.store === undefined) {
      throw new Error("redactOutput requires a SecretResolver with store()");
    }
    const redacted = structuredClone(result);
    for (const path of paths) {
      const hit = getPath(redacted, path);
      if (hit === undefined) continue;
      const refId = `${ctx.executionId}:${ctx.stepId}:${path}`;
      await options.resolver.store(refId, hit.parent[hit.leaf]);
      hit.parent[hit.leaf] = secretRef(refId); // the LOG gets the reference
    }
    return redacted;
  };
}

// ── K10-R2 — derive output redaction from `secret()` marks ────────────────────
//
// Instead of hand-authoring a `redactOutput: ({stepId}) => paths` callback, mark the
// field once — `apiToken: secret(z.string())` — and derive it. A step's output fields
// classified `"secret"` are the ones that must never be persisted; each becomes a
// redactOutput path (relative to the effect RESULT, which is why there is no `output.`
// prefix — the crypto map operates on the event payload, redaction on the raw result).
//
// This is the low-risk half of K10-R2: it drives the EXISTING effect-path redaction seam
// off the R1 taxonomy, with NO kernel change. Automatic secret substitution before
// STEP_STARTED in the hot path remains deferred (its determinism stakes are higher).

/**
 * Precompute a `stepId → secret output paths` lookup from step definitions, for O(1) access
 * in the per-effect redactOutput callback (a Map, not a per-call schema walk). Steps with no
 * `secret()`-marked output field are omitted, so an all-unmarked app yields an empty Map and
 * the redaction pass stays a no-op (G2).
 */
export function secretOutputPathsByStep(
  // Only id + output schema are read; Pick drops the invariant handler field so concrete
  // `StepDefinition<In, Out>` values pass without a cast.
  steps: readonly Pick<StepDefinition, "id" | "outputSchema">[]
): Map<string, readonly string[]> {
  const byStep = new Map<string, readonly string[]>();
  for (const step of steps) {
    if (step.outputSchema === undefined) continue;
    const paths = pathsOfClass(step.outputSchema, "secret");
    if (paths.length > 0) byStep.set(step.id, paths);
  }
  return byStep;
}

/**
 * A {@link RedactionOptions.redactOutput} callback derived from `secret()` marks — pass the
 * result of {@link secretOutputPathsByStep} (or let `defineConfig({ secrets })` wire it).
 */
export function redactOutputFrom(
  byStep: Map<string, readonly string[]>
): (info: { stepId: string }) => readonly string[] {
  return ({ stepId }) => byStep.get(stepId) ?? [];
}
