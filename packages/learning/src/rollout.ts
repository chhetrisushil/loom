import { createHash, createHmac } from "node:crypto";
import type { DecideCapable } from "./decideWithPolicy";
import type { RolloutState } from "./registry";
import type { Policy, PolicyChoice, PolicyContext, PolicyStamp, RolloutStamp } from "./types";
import type { VersionRef } from "./types";

// ── Acting through a rollout (R18, ADR 0124) ─────────────────────────────────
//
// `decideWithRollout` is `decideWithPolicy` for a policy that has a registry: it reads who is
// live, lets the right version act, and records the answer to "who acted, who merely watched"
// in the decision's stamp. The rules:
//
//  - **shadow never acts.** The incumbent's choice is the decision; the candidate is run on the
//    same context and its choice (and propensity) is recorded beside it. A candidate that throws
//    is recorded as an error and changes nothing.
//  - **canary is a deterministic split.** The unit key (a user, a tenant, an execution) is hashed
//    with the rollout's salt to a bucket in [0,1); bucket < fraction means the candidate acts.
//    Same unit, same salt, same bucket - on every run and every process, with no stored
//    assignment. The bucket is recorded in the decision, and the decision is recorded ONCE: a
//    replay serves the recorded choice and stamp whatever the registry says by then (P9).
//  - **fail closed toward the incumbent.** A candidate version the process has no code for acts
//    as the incumbent and records why. An incumbent it has no code for is an error: there is no
//    safe thing left to do.
//
// The propensity recorded is the ACTING policy's own, conditional on the arm. Pooling arms into
// one importance-weighted estimate needs the marginal probability of the action, which requires
// the other policy's probability for it - and `Policy.select` only reveals the probability of the
// action it sampled. So evaluate per arm: `sliceByVersion(trajs, "policy")`. `armProbability` is
// recorded for callers who can reconstruct the marginal themselves.

/** How the process turns a registered (id, version) into runnable code. */
export type PolicyResolver<A> = (id: string, version: string) => Policy<A> | undefined;

/** Where a rollout's state comes from. `PolicyRegistry` satisfies it; wrap it to add a cache. */
export interface RolloutSource {
  resolve(id: string): Promise<RolloutState | undefined>;
}

export interface DecideWithRolloutOptions {
  rationale?: unknown;
  source?: string;
  /** Prompt/model versions in force, recorded in `policy.refs` (see `promptVersion`). */
  refs?: { prompt?: VersionRef; model?: VersionRef };
  /**
   * A server-held secret mixed into the bucket (HMAC). WITHOUT it the split is a public function of
   * the salt (`<id>:<version>`, visible in the registry) and the unit key, so anyone who can choose
   * their own `unitKey` can pick the arm they land in. Either way `unitKey` MUST be assigned by the
   * server (a user id from the authenticated principal), never taken from request text; the secret
   * is the second line of defence, not a substitute.
   */
  bucketSecret?: string;
}

const BUCKET_BITS = 48;

/**
 * The traffic bucket of a unit for a rollout: a stable number in [0,1).
 * 48 bits of SHA-256, so the fraction is resolved far finer than any rollout needs and the
 * result is identical on every platform.
 */
export function rolloutBucket(salt: string, unitKey: string, secret?: string): number {
  const digest =
    secret === undefined
      ? createHash("sha256").update(`${salt}\u0000${unitKey}`).digest()
      : createHmac("sha256", secret).update(`${salt}\u0000${unitKey}`).digest();
  const hi = digest.readUIntBE(0, 6);
  return hi / 2 ** BUCKET_BITS;
}

function sel<A>(
  p: Policy<A>,
  ctx: PolicyContext,
  actions: readonly A[]
): { ok: true; choice: PolicyChoice<A> } | { ok: false; error: string } {
  try {
    const choice = p.select(ctx, actions);
    return { ok: true, choice };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) };
  }
}

/**
 * Resolve an action through the policy a registry says is live for `policyId`, recorded as a
 * durable decision that names the version that acted (and what the other arm would have done).
 *
 * `unitKey` is the stable identity traffic is split on - NOT an execution id unless you want a
 * different arm per run. A user or tenant keeps its arm across executions.
 */
export async function decideWithRollout<A>(
  ctx: DecideCapable,
  decisionId: string,
  rollout: { source: RolloutSource; policyId: string; resolve: PolicyResolver<A> },
  unitKey: string,
  context: PolicyContext,
  actions: readonly A[],
  opts: DecideWithRolloutOptions = {}
): Promise<A> {
  if (actions.length === 0) {
    throw new Error(`decideWithRollout("${decisionId}"): no actions to choose from`);
  }
  if (unitKey === "") throw new Error(`decideWithRollout("${decisionId}"): unitKey is required`);

  let acted: PolicyChoice<A> | undefined;
  let stamp: PolicyStamp | undefined;
  let failure: unknown;
  try {
    const state = await rollout.source.resolve(rollout.policyId);
    if (state === undefined || state.incumbent === undefined) {
      throw new Error(`policy "${rollout.policyId}" has no live version in the registry`);
    }
    const incumbent = rollout.resolve(rollout.policyId, state.incumbent);
    if (incumbent === undefined) {
      throw new Error(
        `no code for incumbent ${rollout.policyId}@${state.incumbent} in this process`
      );
    }
    // The stamp names the code that RAN. A resolver that hands back other code than the registry
    // named would record a version that did not act, and every evaluation sliced by it would lie.
    if (incumbent.version !== state.incumbent) {
      throw new Error(
        `resolver returned ${incumbent.id}@${incumbent.version} for incumbent ${rollout.policyId}@${state.incumbent}`
      );
    }
    let candidate =
      state.candidate === undefined
        ? undefined
        : rollout.resolve(rollout.policyId, state.candidate);
    let candidateMismatch: string | undefined;
    if (candidate !== undefined && candidate.version !== state.candidate) {
      candidateMismatch = `resolver returned ${candidate.id}@${candidate.version} for candidate ${rollout.policyId}@${state.candidate}`;
      candidate = undefined;
    }

    let mode: RolloutStamp["mode"] = "full";
    let bucket: number | undefined;
    let useCandidate = false;
    let armProbability = 1;
    if (state.mode === "canary" && state.candidate !== undefined) {
      mode = "canary";
      bucket = rolloutBucket(state.salt, unitKey, opts.bucketSecret);
      const f = state.canaryFraction ?? 0;
      useCandidate = bucket < f;
      armProbability = useCandidate ? f : 1 - f;
    } else if (state.mode === "shadow" && state.candidate !== undefined) {
      mode = "shadow";
    }

    let actingPolicy = incumbent;
    let otherPolicy = candidate;
    let otherVersion = state.candidate;
    let candidateMissing: string | undefined;
    let fellBack = false;
    if (useCandidate) {
      if (candidate === undefined) {
        candidateMissing =
          candidateMismatch ??
          `no code for candidate ${rollout.policyId}@${state.candidate} in this process`;
        // The incumbent acts instead: the stamp's arm probability is the INCUMBENT arm's, with the
        // fallback flagged, never the candidate slice the unit's bucket fell in.
        armProbability = 1 - (state.canaryFraction ?? 0);
        fellBack = true;
      } else {
        actingPolicy = candidate;
        otherPolicy = incumbent;
        otherVersion = state.incumbent;
      }
    }

    const mine = sel(actingPolicy, context, actions);
    if (!mine.ok) throw new Error(`acting policy threw: ${mine.error}`);
    acted = mine.choice;

    let shadow: RolloutStamp["shadow"];
    if (mode !== "full" && otherVersion !== undefined) {
      if (otherPolicy === undefined) {
        shadow = {
          id: rollout.policyId,
          version: otherVersion,
          action: null,
          error: candidateMissing ?? "no code for this version in this process",
        };
      } else {
        const other = sel(otherPolicy, context, actions);
        shadow = other.ok
          ? {
              id: rollout.policyId,
              version: otherVersion,
              action: other.choice.action,
              ...(other.choice.propensity !== undefined && {
                propensity: other.choice.propensity,
              }),
            }
          : { id: rollout.policyId, version: otherVersion, action: null, error: other.error };
      }
    } else if (candidateMissing !== undefined) {
      shadow = {
        id: rollout.policyId,
        version: state.candidate as string,
        action: null,
        error: candidateMissing,
      };
    }

    stamp = {
      id: actingPolicy.id,
      version: actingPolicy.version,
      ...(acted.propensity !== undefined && { propensity: acted.propensity }),
      ...(opts.refs !== undefined && { refs: opts.refs }),
      rollout: {
        registry: rollout.policyId,
        mode,
        ...(bucket !== undefined && { bucket }),
        acted: { id: actingPolicy.id, version: actingPolicy.version },
        ...(shadow !== undefined && { shadow }),
        ...(mode === "canary" && { armProbability }),
        ...(fellBack && { fellBack: true }),
      },
    };
  } catch (err) {
    failure = err;
  }

  return ctx.decide<A>(
    decisionId,
    () => {
      if (acted === undefined) throw failure;
      return acted.action;
    },
    {
      context,
      ...(stamp !== undefined && { policy: stamp }),
      alternatives: actions,
      ...(opts.rationale !== undefined && { rationale: opts.rationale }),
      ...(opts.source !== undefined && { source: opts.source }),
    }
  );
}
