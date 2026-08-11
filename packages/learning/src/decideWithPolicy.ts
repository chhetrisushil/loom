import type { Policy, PolicyChoice, PolicyContext } from "./types";

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
      policy?: { id: string; version: string; propensity?: number };
    }
  ): Promise<T>;
}

export interface DecideWithPolicyOptions {
  /** Extra provenance, passed straight through to `ctx.decide`. */
  rationale?: unknown;
  source?: string;
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
 * **Why `select` is called before `decide`:** the kernel takes `DecideOptions` by
 * value, so the propensity has to exist before the call. That means on replay the
 * policy is consulted and its answer thrown away — `select` must stay pure and
 * cheap, as the SPI requires. Critically, a policy that has since changed and now
 * THROWS on an old context must not break the replay of an old execution, so the
 * failure is deferred into the decider: `decide` short-circuits from the log and
 * never runs it. On a first run there is no recorded choice, the decider runs, and
 * the error surfaces as it should.
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

  let chosen: PolicyChoice<A> | undefined;
  let failure: unknown;
  try {
    chosen = policy.select(context, actions);
  } catch (err) {
    failure = err;
  }

  return ctx.decide<A>(
    decisionId,
    () => {
      if (chosen === undefined) throw failure;
      return chosen.action;
    },
    {
      context,
      policy: {
        id: policy.id,
        version: policy.version,
        ...(chosen?.propensity !== undefined && { propensity: chosen.propensity }),
      },
      alternatives: actions,
      ...(opts.rationale !== undefined && { rationale: opts.rationale }),
      ...(opts.source !== undefined && { source: opts.source }),
    }
  );
}
