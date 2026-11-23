import { createHash } from "node:crypto";
import {
  CapabilityDeniedError,
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
  /**
   * Origin prefixes the app declares foreign, ADDED to the default `"a2a-inbound:"` (an A2A peer is always another principal).
   * `inbox:` and `mcp:` stay NON-foreign (S-R3) unless listed here (`["inbox:"]`) or `foreign: "any-untrusted"` is set.
   */
  foreignPrefixes?: readonly string[];
  /** `false` drops the default `"a2a-inbound:"` prefix (the only way to treat an A2A peer as not foreign). Default `true`. */
  defaultForeignPrefixes?: boolean;
}

/**
 * The full sha256 hex of a foreign set (JSON of the sorted, de-duplicated list, so no separator ambiguity). A park names it
 * in its renewal request, and a renewed grant carries it in `approvedLineages` to approve exactly that set.
 */
export const foreignSetHash = (foreign: readonly string[]): string =>
  createHash("sha256")
    .update(JSON.stringify([...new Set(foreign)].sort()))
    .digest("hex");
/** What an UNTRACKED run's park names as its "foreign set", so approving it is an explicit act (never the empty set). */
export const UNTRACKED_ORIGIN = "unknown:seen-origins-untracked";
const show = (foreign: readonly string[]): string =>
  `${foreign.slice(0, 3).join(", ").slice(0, 200)}${foreign.length > 3 ? ` (+${foreign.length - 3})` : ""}`;

/**
 * ADR 0150 D7, S5b: per leased effect, read the run's seen origins and apply `action` when a FOREIGN lineage (or an
 * overflowed / unprovable set) directed it. A grant covering the step is not enough: the paper's laundering case.
 * - `attribute`: emit `DECISION_RECORDED { decisionId: "task-authority:directed-by", choice: { lineages } }`, then run.
 * - `deny`: `CapabilityDeniedError`, reason `task-grant:cross-lineage: ...` (terminal, like any capability denial).
 * - `park`: throw a RENEWABLE `CrossLineageParkError` carrying `{ lineages, hash }`; `withRenewal` (or the agent loop's authority
 *   renewal) puts them in the renewal request the approver sees. The approval is a SIGNED field of the renewed grant
 *   (`approvedLineages`, written by a broker that granted a request naming this hash): the retry runs only when the acting
 *   grant lists the hash of the SAME foreign set, so an unrelated renewal approves nothing, and the approval survives later renewals.
 * - UNTRACKED (`ctx.seenOrigins` absent: the `kernel.features.seenOrigins` gate is off, or the run predates it) FAILS
 *   CLOSED: `park` parks on the explicit set `[UNTRACKED_ORIGIN]` (so only a request naming that exact set approves it, never
 *   "empty"), every other action DENIES (`task-grant:untracked`). `attribute` cannot honestly let an untracked run through.
 * - Overflow counts as foreign, and it is STICKY for the run (the set never shrinks). So is every `unknown:` label.
 * - A principal with NO task grant is not governed here (the grant authorizer decides).
 * - A denied or parked call has already burned one lease unit (this runs after `taskLeaseMiddleware`); to avoid that, place
 *   `directedBy` BEFORE the lease middleware (it verifies the grant itself).
 * - `appliesTo` defaults to LEASED effects only; an effect no lease counts is not governed unless the app lists it.
 * Place it AFTER `taskLeaseMiddleware`. Residual (needs an attested sender, deferred): content a writer WITHOUT a grant
 * labels `lineage:<your own root>` reads as yours (so can a grant-holder on a raw path); `foreign: "any-untrusted"` closes it.
 */
export function directedBy(opts: DirectedByOptions): EffectMiddleware {
  const secret = sealKeys(opts.secret);
  const action = opts.action ?? "attribute";
  const mode = opts.foreign ?? "lineage";
  const list = Array.isArray(opts.appliesTo) ? new Set<string>(opts.appliesTo) : undefined;
  const pred = typeof opts.appliesTo === "function" ? opts.appliesTo : undefined;
  const prefixes = [
    ...new Set([
      ...(opts.defaultForeignPrefixes === false ? [] : ["a2a-inbound:"]),
      ...(opts.foreignPrefixes ?? []),
    ]),
  ];
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
    // Lineage mode: another lineage, the overflow marker, ANY `unknown:` label (the kernel's truncation and scan-bound
    // labels, whose lineage cannot be compared), and the app's `foreignPrefixes`. Not foreign: `mcp:`, `inbox:`, own lineage.
    const isForeign = (o: string): boolean =>
      mode === "any-untrusted"
        ? o !== own
        : o === SEEN_ORIGINS_OVERFLOW ||
          o.startsWith("unknown:") ||
          (o.startsWith(LINEAGE_ORIGIN_PREFIX) && o !== own) ||
          prefixes.some((p) => o.startsWith(p));
    const foreign = origins === undefined ? [UNTRACKED_ORIGIN] : origins.filter(isForeign);
    if (origins !== undefined && foreign.length === 0) return next();

    const hash = foreignSetHash(foreign);
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
    // The approval is evidence ON THE SIGNED GRANT (a broker granted a renewal naming exactly this set), nothing else.
    if (action === "park" && grant.approvedLineages?.includes(hash) !== true)
      throw new CrossLineageParkError(grant.taskId, grant.epoch, foreign, hash);
    const key = `${ctx.executionId}|${ctx.stepId}|${ctx.attempt}|${grant.epoch}`;
    if (!decided.has(key)) {
      ctx.emit("DECISION_RECORDED", {
        decisionId: "task-authority:directed-by",
        choice: { lineages: foreign, toolId, rootId: grant.rootId, epoch: grant.epoch },
      });
      await ctx.flush?.(); // durable BEFORE the effect: the record is never lost to a crash between the two
      if (decided.size >= 4096) decided.delete(decided.values().next().value as string);
      decided.add(key);
    }
    return next();
  };
}
