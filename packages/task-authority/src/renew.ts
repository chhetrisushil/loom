import { isTainted, tainted } from "@loomwork/classify";
import {
  type GrantBroker,
  type GrantBrokerError,
  InMemoryGrantLedger,
  type RenewalRequest,
  type RenewalVerdict,
  cloneRequest,
} from "./broker";
import { foreignSetHash } from "./directedBy";
import { MAX_APPROVALS } from "./grant";
import {
  type GrantKeys,
  type LeaseSpec,
  type TaskGrant,
  signTaskGrant,
  taskGrantDigest,
} from "./grant";

/**
 * Decides a renewal. MUST be synchronous: there is no await between the epoch check and the commit, so two
 * renewals at one epoch cannot both be granted. A non-`false`, non-plain-object result (a Promise, null) denies.
 */
export type RenewalPolicy = (
  req: Readonly<RenewalRequest>,
  history: Readonly<{ renewals: number; spentSoFar: Record<string, number> }>
) => false | { leases?: Record<string, number> };

export const MAX_JUSTIFICATION = 4096;
export const MAX_JUSTIFICATIONS_KEPT = 16;
export const MAX_DEFAULT_RENEWALS = 8;

/** Bounds on an untrusted (already cloned) renewal request; returns a reason when out of bounds. */
function badRenewal(r: RenewalRequest): string | undefined {
  const { spent, effectClassesCaused: c, justification: j } = r ?? {};
  if (typeof spent !== "object" || spent === null || Array.isArray(spent))
    return "spent must be an object";
  const keys = Object.keys(spent);
  if (keys.length > 10) return "spent has more than 10 keys";
  if (!keys.every((k) => Number.isFinite(spent[k]) && (spent[k] as number) >= 0))
    return "spent values must be finite and non-negative";
  if (
    c !== undefined &&
    (!Array.isArray(c) || c.length > 32 || !c.every((e) => typeof e === "string" && e.length <= 64))
  )
    return "effectClassesCaused over 32 entries or an entry over 64 chars";
  if (r?.reason !== undefined) {
    const { lineages: l, hash: h } = r;
    if (
      r.reason !== "cross-lineage" ||
      typeof h !== "string" ||
      !/^[0-9a-f]{64}$/.test(h) ||
      !Array.isArray(l) ||
      l.length > 64 ||
      !l.every((x) => typeof x === "string" && x.length <= 300)
    )
      return "a cross-lineage request needs a sha256 hash and at most 64 lineages of at most 300 chars";
    // The approval is bound to the hash, but the APPROVER reads `lineages`: a request whose hash is not the hash of the
    // lineages it shows could get a different set approved than the one the approver saw (a forged renewable error).
    if (h !== foreignSetHash(l))
      return "the cross-lineage hash is not the hash of the lineages shown";
  } else if (r?.lineages !== undefined || r?.hash !== undefined)
    return "lineages/hash need a reason";
  const text = isTainted(j) ? j.value : j;
  if (j !== undefined && (typeof text !== "string" || text.length > MAX_JUSTIFICATION))
    return `justification must be a string of at most ${MAX_JUSTIFICATION} code units`;
  return undefined;
}

const deny = (reason: string): RenewalVerdict => ({ granted: false, reason });

/**
 * Reference broker with renewal. Each renewal appends a digest, so a custom policy that always grants makes
 * the digest list grow with the renewal count (the default policy stops at 8, topping up exhausted leases by their minted ceiling). Stored justifications are a
 * ring of the last 16 per task; `spent` is the last reported value.
 */
export class InMemoryGrantBroker extends InMemoryGrantLedger implements GrantBroker {
  private readonly policy: RenewalPolicy;
  /** Why the built-in policy denied the renewal in flight (read synchronously right after it returns). */
  private denyWhy = "policy denied the renewal";

  private readonly approveCross: boolean | ((r: Readonly<RenewalRequest>) => boolean) | undefined;

  constructor(o: {
    secret: GrantKeys;
    now?: (() => number) | undefined;
    policy?: RenewalPolicy | undefined;
    /**
     * ADR 0150 D7: grant a renewal that APPROVES a cross-lineage step (`directedBy` `park`). Default: refused, so a
     * lease top-up policy never approves one by accident. `true`, or a predicate over the request (which names the foreign set).
     */
    approveCrossLineage?: boolean | ((r: Readonly<RenewalRequest>) => boolean) | undefined;
  }) {
    super(o);
    this.approveCross = o.approveCrossLineage;
    this.policy = o.policy ?? ((r, h) => this.topUp(r, h));
  }

  /**
   * The built-in policy (R37). Renews at most 8 times. Each lease the request reports exhausted
   * (`spent[name] >= current ceiling`) is raised by its ORIGINAL minted (epoch-0) ceiling: one tranche per
   * renewal. A lease that is not exhausted (an expired grant) keeps its ceiling. A CHILD's lease stays capped at
   * its minted ceiling (a top-up is a new parent reservation), so an exhausted child lease denies.
   * `spent` is caller-reported and untrusted: a dishonest reporter gets at most 8 extra tranches. This is the
   * reference broker; production brokers bring their own policy.
   */
  private topUp(req: Readonly<RenewalRequest>, h: { renewals: number }) {
    const rec = this.tasks.get(req.taskId);
    if (!rec || h.renewals >= MAX_DEFAULT_RENEWALS) return false;
    const leases: Record<string, number> = {};
    for (const [n, l] of Object.entries(rec.grant.leases)) {
      if (!((req.spent[n] ?? 0) >= l.ceiling)) continue;
      if (rec.parent) {
        this.denyWhy = `child lease ${n} exhausted: needs a new parent reservation`;
        return false;
      }
      leases[n] = l.ceiling + (rec.minted[n] ?? 0);
    }
    return { leases };
  }

  async renew(request: RenewalRequest): Promise<RenewalVerdict> {
    let req: RenewalRequest;
    try {
      req = cloneRequest(request);
    } catch (e) {
      return deny((e as GrantBrokerError).message);
    }
    const bad = badRenewal(req);
    if (bad) return deny(bad);
    const rec = this.tasks.get(req.taskId);
    if (!rec || rec.revoked) return deny("unknown or revoked task");
    const cur = rec.grant;
    if (req.epoch !== cur.epoch) return deny("stale epoch");
    // D7: approving a cross-lineage step is a decision the operator opts into, whatever the lease policy says.
    const crossOk = this.approveCross;
    if (
      req.reason === "cross-lineage" &&
      !(typeof crossOk === "function" ? crossOk(req) === true : crossOk === true)
    )
      return deny("cross-lineage approval is not enabled on this broker (approveCrossLineage)");
    if (req.justification !== undefined) {
      rec.justifications.push(tainted(req.justification as string, "task-authority:renewal"));
      if (rec.justifications.length > MAX_JUSTIFICATIONS_KEPT) rec.justifications.shift();
    }
    rec.spent = req.spent;
    let verdict: ReturnType<RenewalPolicy>;
    try {
      this.denyWhy = "policy denied the renewal";
      verdict = this.policy(req, {
        renewals: rec.digests.length - 1,
        spentSoFar: { ...rec.spent },
      });
    } catch {
      return deny("policy threw");
    }
    if (rec.revoked) return deny("task revoked during renewal"); // a policy may re-enter revoke()
    if (verdict === false) return deny(this.denyWhy);
    if (
      typeof verdict !== "object" ||
      verdict === null ||
      Array.isArray(verdict) ||
      typeof (verdict as { then?: unknown }).then === "function"
    )
      return deny("policy returned an invalid result");
    const want = verdict.leases ?? {};
    if (typeof want !== "object" || want === null || Array.isArray(want))
      return deny("policy leases must be an object");
    const leases: Record<string, LeaseSpec> = cloneRequest(cur.leases);
    const parent = rec.parent ? this.tasks.get(rec.parent) : undefined;
    for (const [name, ceiling] of Object.entries(want)) {
      const lease = leases[name];
      if (typeof ceiling !== "number") return deny(`lease ${name} ceiling must be a number`);
      if (!lease || !Object.hasOwn(leases, name))
        return deny(`policy named a lease the grant lacks: ${name}`);
      if (ceiling < this.reserved(rec, name))
        return deny(`lease ${name} below children's reservations`);
      // A child's ceiling was reserved in its parent's fold at the MINTED amount: a top-up is a new reservation.
      if (parent && ceiling > (rec.high[name] ?? 0))
        return deny(`lease ${name} ceiling exceeds the minted (reserved) amount`);
      lease.ceiling = ceiling;
    }
    let next: TaskGrant;
    try {
      const { sig: _sig, ...body } = cur;
      const now = this.now();
      const exp = Math.min(now + rec.ttlMs, parent?.grant.exp ?? Number.POSITIVE_INFINITY);
      if (parent && exp <= now) return deny("parent has expired"); // a root may still renew when expired (D5)
      // An unrelated renewal keeps `approvedLineages` through `...body`; a cross-lineage one appends (the 17th drops the oldest).
      const approved =
        req.reason === "cross-lineage"
          ? [
              ...(cur.approvedLineages ?? []).filter((h) => h !== req.hash),
              req.hash as string,
            ].slice(-MAX_APPROVALS)
          : undefined;
      next = signTaskGrant(this.secret, {
        ...body,
        leases,
        exp,
        epoch: cur.epoch + 1,
        ...(approved !== undefined && { approvedLineages: approved }),
      });
    } catch (e) {
      return deny(e instanceof Error ? e.message : "invalid renewal");
    }
    const digest = taskGrantDigest(next);
    rec.grant = next;
    rec.digests.push(digest);
    for (const [n, l] of Object.entries(leases))
      rec.high[n] = Math.max(rec.high[n] ?? 0, l.ceiling);
    return { granted: true, epoch: next.epoch, digest };
  }
}
