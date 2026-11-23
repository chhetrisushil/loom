import type { EffectContext, EffectMiddleware } from "@loomwork/effect-runtime";
import type { GrantSource } from "./broker";
import {
  GrantRevokedError,
  LeaseDurabilityError,
  LeaseExhaustedError,
  LeaseUnmappedError,
} from "./errors";
import { type TaskGrant, taskGrantDigest, verifyTaskGrant } from "./grant";

export interface TaskLeaseOptions {
  secret: string;
  source?: GrantSource;
  /** Refuse an effect that no lease counts (default: it runs uncounted). */
  strictLeases?: boolean;
  /** Revocation check budget in ms; on expiry the grant is treated as revoked (default 5000). */
  revocationTimeoutMs?: number;
}

const MAX_EXECUTIONS = 1024;
const MAX_DECIDED = 256;
const MAX_CLEAN = 4096;

interface Entry {
  inflight: Map<string, number>;
  /** Highest total (settled + in flight) this process counted per lease: a snapshot taken before a sibling's meter is stale. */
  floor: Map<string, number>;
  decided: Set<string>;
}

/**
 * ADR 0150 D3/D4/D5. A leased effect is counted BEFORE it runs: spent = max(fold + in-flight, floor)
 * reservations, reserved synchronously (concurrent effects hold snapshots taken before each other's
 * meter). The meter is emitted and flushed (ADR 0151) before `next()`, so a counted attempt is durable
 * before its side effect. A context without `flush` refuses the leased effect.
 * Limitation: `EffectContext` carries no resource, so effects map by `toolId` only (not `toolId:resource`).
 */
export function taskLeaseMiddleware(opts: TaskLeaseOptions): EffectMiddleware {
  const timeoutMs = opts.revocationTimeoutMs ?? 5000;
  const entries = new Map<string, Entry>();
  const clean = new Set<string>();

  const entryFor = (id: string): Entry => {
    let e = entries.get(id);
    if (e !== undefined) {
      entries.delete(id); // refresh recency
    } else {
      e = { inflight: new Map(), floor: new Map(), decided: new Set() };
      for (const [k, v] of entries) {
        if (entries.size < MAX_EXECUTIONS) break;
        if ([...v.inflight.values()].every((n) => n === 0)) entries.delete(k);
      }
    }
    entries.set(id, e);
    return e;
  };

  async function revoked(digest: string): Promise<boolean> {
    const check = opts.source?.revoked;
    if (check === undefined || clean.has(digest)) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      });
      const isRevoked = await Promise.race([
        check.call(opts.source, digest).catch(() => true),
        timeout,
      ]);
      if (!isRevoked) {
        if (clean.size >= MAX_CLEAN) clean.delete(clean.values().next().value as string);
        clean.add(digest);
      }
      return isRevoked;
    } finally {
      clearTimeout(timer);
    }
  }

  return async (ctx: EffectContext, _input, next) => {
    const claimed = ctx.principal?.taskGrant as TaskGrant | undefined;
    if (claimed === undefined) return next();
    const grant = verifyTaskGrant(opts.secret, claimed);
    if (grant === undefined) throw new Error("task grant failed verification (lease middleware)");
    const toolId = ctx.toolId ?? "";
    const lease = Object.keys(grant.leases)
      .sort()
      .find((n) => grant.leases[n]?.effects.includes(toolId));
    if (lease === undefined) {
      if (opts.strictLeases === true) throw new LeaseUnmappedError(toolId);
      return next();
    }
    if (ctx.flush === undefined) throw new LeaseDurabilityError(toolId);
    const digest = taskGrantDigest(grant);
    if (await revoked(digest)) throw new GrantRevokedError(`${grant.taskId}`);

    // Synchronous from here to the reservation: no await between reading `spent` and taking it.
    const ceiling = (grant.leases[lease] as { ceiling: number }).ceiling;
    const dim = `lease.${lease}`;
    const e = entryFor(ctx.executionId);
    const inflight = e.inflight.get(lease) ?? 0;
    const fold = ctx.resources?.custom?.[dim];
    const spent = Math.max(
      (typeof fold === "number" ? fold : 0) + inflight,
      e.floor.get(lease) ?? 0
    );
    if (spent >= ceiling) {
      const err = new LeaseExhaustedError(lease, ceiling, spent, grant.epoch);
      ctx.emit("QUOTA_EXCEEDED", { stepId: ctx.stepId, level: "lease", reason: err.message });
      throw err;
    }
    e.inflight.set(lease, inflight + 1);
    e.floor.set(lease, spent + 1);
    try {
      const key = `${ctx.stepId}#${ctx.attempt}#${grant.epoch}`;
      if (!e.decided.has(key)) {
        if (e.decided.size >= MAX_DECIDED)
          e.decided.delete(e.decided.values().next().value as string);
        e.decided.add(key);
        ctx.emit("DECISION_RECORDED", {
          decisionId: `task-authority:grant:${grant.epoch}`,
          choice: { digest, exp: grant.exp, epoch: grant.epoch },
        });
      }
      ctx.emit("RESOURCE_METERED", { custom: { [dim]: 1 } });
      await ctx.flush();
      return await next();
    } finally {
      e.inflight.set(lease, (e.inflight.get(lease) ?? 1) - 1);
    }
  };
}
