import { declareReach } from "@loom/verify";
import type { Policy, PolicyChoice, PolicyContext, PolicyStamp } from "./types";

// ── The one-line entry point (ADR 0080) ──────────────────────────────────────
//
// Everything else in this package is a read lens over the log. This is the write
// side: the single call that makes a decision learnable. It exists so that a
// developer's diff to opt into learning is one line, and so that the fields
// off-policy evaluation needs cannot be forgotten — a hand-rolled `ctx.decide`
// that omits `alternatives` or `propensity` produces a log that looks fine and
// silently cannot be evaluated later.

/** The subset of `ExecutionContext` this needs — structurally `ctx`. */
export interface DecideCapable {
  decide<T = unknown>(
    decisionId: string,
    decider: () => T | Promise<T>,
    opts?: {
      rationale?: unknown;
      source?: string;
      alternatives?: unknown;
      confidence?: number;
      context?: Record<string, unknown>;
      policy?: PolicyStamp;
    }
  ): Promise<T>;
}

/** The options object `decideWithPolicy`/`decideWithRollout` hand `ctx.decide` (policy filled in by the decider). */
export type DecideRecordOpts = NonNullable<Parameters<DecideCapable["decide"]>[2]>;

export interface DecideWithPolicyOptions {
  /** Extra provenance, passed straight through to `ctx.decide`. */
  rationale?: unknown;
  source?: string;
  /**
   * R18 - the prompt template and model configuration in force, as content-addressed refs
   * (`promptVersion` / `modelVersion`). Recorded in `policy.refs`; additive and never read by
   * replay, so a log written without it replays as before.
   */
  refs?: PolicyStamp["refs"];
}

/**
 * Resolve an action through a {@link Policy}, recorded as a durable decision.
 *
 * The choice goes through `ctx.decide`, so all the usual guarantees hold: it is
 * recorded once and served from the log on every replay (P9). A policy that
 * improves between runs therefore changes future outcomes without ever making a
 * past run replay differently — the property that makes continuous learning safe
 * here at all.
 *
 * What it records beyond a bare `decide`:
 *  - `context` — the observation, so the step is learnable later
 *  - `policy` — id, version and **propensity**, so it is *evaluable* later
 *  - `alternatives` — the action set, so a counterfactual has something to range over
 *
 * ```ts
 * const route = await decideWithPolicy(ctx, "route", policy,
 *   { intent, tokens, tenant }, routes);
 * ```
 *
 * **`select` runs inside the decider (R18 follow-up):** a replay serves the recorded choice
 * and never consults the policy, so a model-backed or side-effecting policy is not run for an
 * answer that would be thrown away, and a policy that has since changed and now THROWS on an old
 * context cannot break the replay of an old execution. The propensity must be in the record, but
 * `ctx.decide` takes its options by value, so the options object is handed over first and the
 * stamp is set on it by the decider; the kernel reads the options when it commits the record,
 * after the decider settled. On a first run the error from a throwing policy surfaces as it should.
 */
export async function decideWithPolicy<A>(
  ctx: DecideCapable,
  decisionId: string,
  policy: Policy<A>,
  context: PolicyContext,
  actions: readonly A[],
  opts: DecideWithPolicyOptions = {}
): Promise<A> {
  if (actions.length === 0) {
    throw new Error(`decideWithPolicy("${decisionId}"): no actions to choose from`);
  }

  // The stamp (propensity) cannot be known before the policy has chosen, and `ctx.decide` takes
  // its options by value. So the options object is handed over now and COMPLETED inside the
  // decider: the kernel reads `opts` only when it commits the record, after the decider settled.
  // A served (replayed) decision never runs the decider, so the policy is never consulted.
  const recordOpts: DecideRecordOpts = {
    context,
    alternatives: actions,
    ...(opts.rationale !== undefined && { rationale: opts.rationale }),
    ...(opts.source !== undefined && { source: opts.source }),
  };

  return ctx.decide<A>(
    decisionId,
    () => {
      const chosen: PolicyChoice<A> = policy.select(context, actions);
      recordOpts.policy = {
        id: policy.id,
        version: policy.version,
        ...(chosen.propensity !== undefined && { propensity: chosen.propensity }),
        ...(opts.refs !== undefined && { refs: opts.refs }),
      };
      return chosen.action;
    },
    recordOpts
  );
}

// L34 - declared reach (ADR 0086). The whole call is one `ctx.decide`; the decider only runs
// `policy.select`, a pure function of (context, actions), and is never handed a scope. It reaches no
// tool.
declareReach(decideWithPolicy, { run: [], transient: [] });
