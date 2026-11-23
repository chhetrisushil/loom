import type { EffectContext, EffectMiddleware } from "@loomwork/effect-runtime";
import type { GrantSource } from "./broker";
import { CHILD_LEASE_TOOL } from "./childLease";
import {
  GrantRevokedError,
  LeaseDimensionDroppedError,
  LeaseDurabilityError,
  LeaseExhaustedError,
  LeaseGrantInvalidError,
  LeaseUnmappedError,
} from "./errors";
import { type TaskGrant, taskGrantDigest, verifyTaskGrant } from "./grant";

export interface TaskLeaseOptions {
  secret: string;
  source?: GrantSource;
  /** Refuse an in-scope effect that no lease counts. Default TRUE; `false` lets it run uncounted. */
  strictLeases?: boolean;
  /** Revocation check budget in ms; on expiry the grant is treated as revoked (default 5000). */
  revocationTimeoutMs?: number;
  /** How long a clean (not revoked) answer is trusted, in ms (default 1000). A revoked answer is sticky. */
  revocationCacheMs?: number;
  /** Clock for the revocation cache; defaults to `Date.now`. */
  now?: () => number;
}

const MAX_KEYS = 4096;
const TIMEOUT = Symbol("revocation-timeout");

const spentOf = (ctx: EffectContext, dim: string): number => {
  const custom = ctx.readResources?.().custom;
  return custom !== undefined && Object.hasOwn(custom, dim) ? (custom[dim] as number) : 0;
};
const addCapped = (set: Set<string>, key: string): void => {
  if (set.size >= MAX_KEYS) set.delete(set.values().next().value as string);
  set.add(key);
};

/**
 * ADR 0150 D3/D4/D5. A leased effect is counted BEFORE it runs, on LIVE fold state: one synchronous
 * block reads `readResources()`, refuses at the ceiling, emits the digest decision and the meter, and
 * re-reads to confirm the meter folded (it is not, when the fold's custom-dimension cap is full).
 * Then `await flush()` makes it durable (ADR 0151) and `next()` runs. No in-process counters: the
 * fold is the one source of spend, so concurrent siblings, retries and restarts all see it.
 *
 * Wiring (R22):
 * - Place it INSIDE (after) any retry middleware in `effectMiddleware`; outside, a retry re-runs the
 *   effect under one count.
 * - Run `TaskGrantAuthorizer` alongside: this middleware checks neither expiry nor holder.
 * - `QUOTA_EXCEEDED` folds a sticky `_resources.exceeded` that survives a renewal.
 * Effects map by `toolId` only (the context carries no resource); a grant whose lease effects are
 * resource-qualified or overlapping is refused at shape validation.
 */
export function taskLeaseMiddleware(opts: TaskLeaseOptions): EffectMiddleware {
  const timeoutMs = opts.revocationTimeoutMs ?? 5000;
  const cacheMs = opts.revocationCacheMs ?? 1000;
  const now = opts.now ?? Date.now;
  const strict = opts.strictLeases !== false;
  const cleanUntil = new Map<string, number>();
  const revoked = new Set<string>();
  const decided = new Set<string>();

  // Anything but a clean boolean `false` is revoked (fail closed): true, undefined, a throw, a hang.
  async function isRevoked(digest: string): Promise<boolean> {
    const check = opts.source?.revoked;
    if (check === undefined) return false;
    if (revoked.has(digest)) return true;
    if ((cleanUntil.get(digest) ?? 0) > now()) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        Promise.resolve()
          .then(() => check.call(opts.source, digest))
          .catch(() => undefined),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        }),
      ]);
      if (answer === false) {
        if (cleanUntil.size >= MAX_KEYS)
          cleanUntil.delete(cleanUntil.keys().next().value as string);
        cleanUntil.set(digest, now() + cacheMs);
        return false;
      }
      if (answer === true) {
        if (revoked.size >= MAX_KEYS) revoked.delete(revoked.values().next().value as string);
        revoked.add(digest);
      }
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  return async (ctx: EffectContext, _input, next) => {
    const claimed = ctx.principal?.taskGrant as TaskGrant | undefined;
    if (claimed === undefined) return next();
    const grant = verifyTaskGrant(opts.secret, claimed);
    if (grant === undefined) throw new LeaseGrantInvalidError();
    const toolId = ctx.toolId ?? "";
    const digest = taskGrantDigest(grant);
    if (toolId === CHILD_LEASE_TOOL) {
      // D6 bookkeeping, not a leased side effect: uncounted, but a revoked task still cannot meter
      if (await isRevoked(digest)) throw new GrantRevokedError(grant.taskId);
      return next();
    }
    const lease = Object.keys(grant.leases).find((n) => grant.leases[n]?.effects.includes(toolId));
    if (lease === undefined) {
      if (strict) throw new LeaseUnmappedError(toolId);
      return next();
    }
    if (ctx.flush === undefined || ctx.readResources === undefined) {
      throw new LeaseDurabilityError(toolId);
    }
    if (await isRevoked(digest))
      throw new GrantRevokedError(grant.taskId, grant.taskId, grant.epoch);

    // ONE synchronous block: no await between reading the live spend and the meter that raises it.
    const ceiling = (grant.leases[lease] as { ceiling: number }).ceiling;
    const dim = `lease.${lease}`;
    // D6: what the parent has handed to children still counts against it, until they return it.
    const own = spentOf(ctx, dim);
    const spent = own + spentOf(ctx, `${dim}.reserved`) - spentOf(ctx, `${dim}.returned`);
    if (spent >= ceiling) {
      const err = new LeaseExhaustedError(lease, ceiling, spent, grant.epoch, grant.taskId);
      ctx.emit("QUOTA_EXCEEDED", { stepId: ctx.stepId, level: "lease", reason: err.message });
      throw err;
    }
    const key = `${ctx.executionId}|${ctx.stepId}|${ctx.attempt}|${grant.epoch}`;
    if (!decided.has(key)) {
      ctx.emit("DECISION_RECORDED", {
        decisionId: `task-authority:grant:${grant.epoch}`,
        choice: { digest, exp: grant.exp, epoch: grant.epoch },
      });
      addCapped(decided, key);
    }
    ctx.emit("RESOURCE_METERED", { custom: { [dim]: 1 } });
    if (spentOf(ctx, dim) !== own + 1) throw new LeaseDimensionDroppedError(lease);
    await ctx.flush();
    return next();
  };
}
