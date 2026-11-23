import { createHash } from "node:crypto";
import {
  CapabilityDeniedError,
  type EffectContext,
  type EffectMiddleware,
  SEEN_ORIGINS_OVERFLOW,
} from "@loomwork/effect-runtime";
import { TASK_GRANT_DENIAL } from "./authorizer";
import { CrossLineageParkError, LeaseGrantInvalidError } from "./errors";
import { type GrantKeys, type TaskGrant, sealKeys, verifyTaskGrant } from "./grant";
import { LINEAGE_ORIGIN_PREFIX } from "./lineage";

/** What `directedBy` does when a leased effect runs in a run that saw a foreign lineage (ADR 0150 D7). */
export type CrossLineageAction = "attribute" | "park" | "deny";

export interface DirectedByOptions {
  /** The grant secret (as `taskLeaseMiddleware`): the acting grant's rootId is read from the VERIFIED grant only. */
  secret: GrantKeys;
  /** Default `"attribute"`: record `task-authority:directed-by` before the effect and let it run. */
  action?: CrossLineageAction;
  /**
   * S-R2: which effects the policy covers, as `(toolId, resource?) => boolean` or a list of tool ids. Default: every
   * LEASED effect of the acting grant. The effect context carries no resource, so `resource` is always `undefined` here.
   */
  appliesTo?: ((toolId: string, resource?: string) => boolean) | readonly string[];
  /**
   * S-R3: `"lineage"` (default) triggers on a `lineage:` origin whose rootId differs from the acting grant's, and on the
   * kernel overflow marker. `"any-untrusted"` triggers on EVERY origin that is not the acting lineage (`mcp:`, `inbox:`,
   * `a2a-inbound:`...), which is also the setting that does not trust a `lineage:<own>` label a writer without a grant could forge.
   */
  foreign?: "lineage" | "any-untrusted";
}

/** The hash a park approval is bound to: the exact foreign set, so a NEW foreign origin parks again. */
const setHash = (foreign: readonly string[]): string =>
  createHash("sha256")
    .update([...foreign].sort().join("\n"))
    .digest("hex")
    .slice(0, 12);
const dimOf = (epoch: number, hash: string): string => `directed.e${epoch}.${hash}`;
const approvedAt = (ctx: EffectContext, epoch: number, hash: string): boolean => {
  const custom = ctx.readResources?.().custom;
  return epoch > 0 && ((custom?.[dimOf(epoch - 1, hash)] as number | undefined) ?? 0) > 0;
};
const show = (foreign: readonly string[]): string =>
  `${foreign.slice(0, 3).join(", ").slice(0, 200)}${foreign.length > 3 ? ` (+${foreign.length - 3})` : ""}`;

/**
 * ADR 0150 D7, S5b: per leased effect, read the run's seen origins and apply `action` when a FOREIGN lineage (or an
 * overflowed / unprovable set) directed it. A grant covering the step is not enough: the paper's laundering case.
 * - `attribute`: emit `DECISION_RECORDED { decisionId: "task-authority:directed-by", choice: { lineages } }`, then run.
 * - `deny`: `CapabilityDeniedError`, reason `task-grant:cross-lineage: ...` (terminal, like any capability denial).
 * - `park`: throw a RENEWABLE `CrossLineageParkError`; `withRenewal` (or the agent loop's authority renewal) parks on the
 *   renewal gate and a granted renewal is the approval. It is remembered as a `directed.e<epoch>.<hash>` meter written
 *   before the throw (reserved by `installTaskAuthority`): the retry, under epoch+1, runs only for the SAME foreign set.
 * - UNTRACKED (`ctx.seenOrigins` absent: the `kernel.features.seenOrigins` gate is off, or the run predates it) FAILS
 *   CLOSED: `park` parks (with an empty set), every other action DENIES (`task-grant:untracked`). There is no way to
 *   attribute what is not tracked, so `attribute` cannot honestly let it run.
 * - Overflow counts as foreign. A principal with NO task grant is not governed here (the grant authorizer decides).
 * Place it AFTER `taskLeaseMiddleware`. Residual (needs an attested sender, deferred): content a writer WITHOUT a grant
 * labels `lineage:<your own root>` reads as yours; `foreign: "any-untrusted"` closes it.
 */
export function directedBy(opts: DirectedByOptions): EffectMiddleware {
  const secret = sealKeys(opts.secret);
  const action = opts.action ?? "attribute";
  const mode = opts.foreign ?? "lineage";
  const list = Array.isArray(opts.appliesTo) ? new Set<string>(opts.appliesTo) : undefined;
  const pred = typeof opts.appliesTo === "function" ? opts.appliesTo : undefined;
  const decided = new Set<string>();

  return async (ctx, _input, next) => {
    const claimed = ctx.principal?.taskGrant as TaskGrant | undefined;
    if (claimed === undefined) return next();
    const grant = verifyTaskGrant(secret, claimed);
    if (grant === undefined) throw new LeaseGrantInvalidError();
    const toolId = ctx.toolId ?? "";
    const covered =
      list !== undefined
        ? list.has(toolId)
        : pred !== undefined
          ? pred(toolId, undefined)
          : Object.values(grant.leases).some((l) => l.effects.includes(toolId));
    if (!covered) return next();

    const origins = ctx.seenOrigins?.();
    const own = `${LINEAGE_ORIGIN_PREFIX}${grant.rootId}`;
    const foreign =
      origins === undefined
        ? []
        : origins.filter(
            (o) =>
              o === SEEN_ORIGINS_OVERFLOW ||
              (mode === "any-untrusted"
                ? o !== own
                : o.startsWith(LINEAGE_ORIGIN_PREFIX) && o !== own)
          );
    if (origins !== undefined && foreign.length === 0) return next();

    const hash = setHash(foreign);
    if (origins === undefined && action !== "park")
      throw new CapabilityDeniedError(
        toolId,
        `${TASK_GRANT_DENIAL.untracked}: the run's seen origins are not tracked, so it cannot be shown free of foreign direction`
      );
    if (action === "deny")
      throw new CapabilityDeniedError(
        toolId,
        `${TASK_GRANT_DENIAL.crossLineage}: cross-lineage direction (${show(foreign)})`
      );
    if (action === "park" && !approvedAt(ctx, grant.epoch, hash)) {
      ctx.emit("RESOURCE_METERED", { custom: { [dimOf(grant.epoch, hash)]: 1 } });
      await ctx.flush?.();
      throw new CrossLineageParkError(grant.taskId, grant.epoch, foreign);
    }
    const key = `${ctx.executionId}|${ctx.stepId}|${ctx.attempt}|${grant.epoch}`;
    if (!decided.has(key)) {
      ctx.emit("DECISION_RECORDED", {
        decisionId: "task-authority:directed-by",
        choice: { lineages: foreign, toolId, rootId: grant.rootId, epoch: grant.epoch },
      });
      if (decided.size >= 4096) decided.delete(decided.values().next().value as string);
      decided.add(key);
    }
    return next();
  };
}
