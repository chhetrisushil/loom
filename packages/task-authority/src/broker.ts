import type { TaintedValue } from "@loomwork/classify";
import {
  type GrantKeys,
  type LeaseSpec,
  type TaskGrant,
  type UnsignedTaskGrant,
  sealKeys,
  signTaskGrant,
  taskGrantDigest,
  validateGrantShape,
  widensReadsOrSandbox,
} from "./grant";
import { LINEAGE_ORIGIN_MAX, LINEAGE_ORIGIN_PREFIX } from "./lineage";

export interface MintRequest {
  taskId: string;
  issuedTo: string;
  effects: string[];
  leases: Record<string, LeaseSpec>;
  ttlMs: number;
  parent?: { taskId: string };
  /**
   * R30: the tenant and end user the task acts for, signed into the grant. A child INHERITS both from its
   * parent; naming a different value (or one the parent lacks) is refused, so a child never changes identity.
   */
  tenant?: string;
  onBehalfOf?: string;
  /** S-R4: signed into the grant. A child's `reads` must be covered by the parent's; a child of an isolated parent must be isolated. */
  reads?: string[];
  sandbox?: "isolated";
  /**
   * D6: per lease, the `lease.<n>.reserved` total in the PARENT's own fold (read by the supervisor). When
   * given with `parent`, the broker refuses unless the sum of the parent's children's high-water ceilings,
   * this one included, stays within it. Both sides only grow, so the check is sound whenever it runs.
   */
  parentReserved?: Record<string, number>;
}
export interface RenewalRequest {
  taskId: string;
  epoch: number;
  spent: Record<string, number>;
  renewals: number;
  effectClassesCaused?: string[];
  justification?: TaintedValue<string> | string;
  /**
   * ADR 0150 D7 (`directedBy` park): the renewal is a request to APPROVE a cross-lineage step. `lineages` is the foreign
   * set the approver is shown and `hash` its full sha256 (`foreignSetHash`); a grant carries the approved hash back.
   */
  reason?: "cross-lineage";
  lineages?: string[];
  hash?: string;
}
export type RenewalVerdict =
  | { granted: true; epoch: number; digest: string }
  | { granted: false; reason: string };
/**
 * Where the principal codec reads a task's CURRENT grant. taskIds MUST NOT be reused or reissued to another
 * holder (the `ta1:` ref's MAC binds the holder, R15; a reused id would still be one task's history).
 * After a revoke the execution's owner is unknown to the execution access policy (ADR 0111 `unknownOwner`).
 */
export interface GrantSource {
  current(taskId: string): Promise<TaskGrant | undefined>;
  revoked?(digest: string): Promise<boolean>;
  /**
   * Bind a task to ONE execution (R16): the first claim wins, a repeat by the same `executionId` is true,
   * any other execution gets false. An unknown or revoked task is false.
   *
   * MUST be an atomic compare-and-set: first caller wins, idempotent for the same `executionId`. A
   * non-atomic implementation (read, then write) lets two executions both claim the same task.
   */
  claim(taskId: string, executionId: string): Promise<boolean>;
  /** The execution that holds `taskId` (see `claim`), or undefined. Side-effect free: authorization checks use this, never `claim`. */
  holder(taskId: string): Promise<string | undefined>;
}
export interface GrantBroker extends GrantSource {
  mint(r: MintRequest): Promise<TaskGrant>;
  renew(r: RenewalRequest): Promise<RenewalVerdict>;
  revoke(taskId: string, reason: string): Promise<void>;
  /**
   * D6: record, once, what a COMPLETED child left unused (`high-water ceiling - spend[n]`; `spend` is its net
   * `lease.<n> + reserved - returned`). Called by the supervisor only; a revoked or parentless task records
   * nothing (R7), and a second call changes nothing.
   * REFUND (ADR 0150 D12): when the parent is NOT held by an execution (`holder(parent)` is undefined: a schedule
   * grant has no fold), the broker also lowers the child's reserved high-water mark by the unused amount, so the
   * parent's headroom is restored exactly once, the child's grant is REVOKED (it is done: a renewal must not re-inflate
   * the reservation, and `renew` refuses a settled child) and `takeReturn` then yields nothing. Only a child that STARTED
   * (`holder(child)` set) is refunded; an unclaimed one is released through `settleUnstarted`, and `settleChild` on it is a no-op. A HELD parent keeps the
   * slice-1 rule: the amount is takeable once into its fold's `returned` meter and headroom is not released.
   */
  settleChild(taskId: string, spend: Record<string, number>): Promise<void>;
  /**
   * D6: the ONE-TIME take of what `settleChild` recorded for `taskId`, if it is a child of `parentTaskId`
   * (else, or when nothing is recorded yet, or already taken: `{}`). MUST be an atomic compare-and-set.
   */
  takeReturn(taskId: string, parentTaskId: string): Promise<Record<string, number>>;
  /**
   * R33: record, at the broker, the reservation `parentTaskId` made in its fold for the child `childId` (the
   * supervisor's id, `<parentExecutionId>::<key>`). Idempotent for the same `(parent, childId, lease)`; a
   * different lease for a known child, an unknown or revoked parent, or a bad amount is refused. Called by
   * the reserve step AFTER the fold meters it, so a record never exceeds what the fold reserved.
   */
  reserve(parentTaskId: string, childId: string, lease: Record<string, number>): Promise<void>;
  /**
   * R33: the child `childId` will never start (its mint was refused, or the supervisor gave up). Makes the
   * WHOLE reservation takeable once through `takeReturn`, and revokes a grant minted for it but never claimed.
   * A child is EITHER started (`settleChild`, or already claimed) OR unstarted, never both: whichever comes
   * first wins and the other changes nothing. No record, or a started child: nothing happens.
   * MUST be atomic with `claim`: "not claimed" and the revoke are ONE compare-and-set, or a child could start
   * (claim wins) and ALSO be paid its whole reservation. A broker must also keep a NEVER-DECREASING per-parent
   * total of what it carved (minted ceilings, plus an unminted child's reservation once settled unstarted) and
   * compare `parentReserved` against THAT, not against the live (releasable) high-water sum: a returned
   * reservation must not let an unreserved child be minted on top of the parent's refilled lease (R36).
   * Called by the supervisor for any child it cannot start; a TRANSIENT failure there (fold unreadable,
   * broker timeout) therefore becomes a permanent "unstarted" outcome: the child is never retried (M3).
   */
  settleUnstarted(childId: string, parentTaskId: string): Promise<void>;
}

/** A request was refused (parent missing/expired/revoked, scope widened, ceiling over headroom, duplicate, bad ttl, unserializable). */
export class GrantBrokerError extends Error {
  override name = "GrantBrokerError";
}

export const MAX_REQUEST_BYTES = 64 * 1024;

/** @internal Per-task state shared by the ledger and the renewal path. */
export interface Rec {
  grant: TaskGrant;
  ttlMs: number;
  digests: string[];
  parent?: string | undefined;
  children: Set<string>;
  /** Per lease, the highest ceiling ever granted to this task: its reservation against the parent (R11). */
  high: Record<string, number>;
  /** R37: per lease, the epoch-0 (minted) ceiling. Never changes; the default renewal tranche. */
  minted: Record<string, number>;
  spent: Record<string, number>;
  justifications: TaintedValue<string>[];
  revoked?: string;
  /** D6: unused amounts recorded by `settleChild`; `taken` once `takeReturn` handed them out. */
  settled?: Record<string, number>;
  taken?: boolean;
}

/** @internal R33: a reservation recorded at the broker. `outcome` is set once: the first of started / unstarted. */
export interface Reservation {
  parent: string;
  lease: Record<string, number>;
  outcome?: "started" | "unstarted";
  taken?: boolean;
}

/** Clone a caller request FIRST (getters, toJSON resolved once), capped in size; callers validate the CLONE. */
export function cloneRequest<T>(v: T): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(v);
  } catch {
    throw new GrantBrokerError("request is not serializable");
  }
  if (text === undefined || text.length > MAX_REQUEST_BYTES)
    throw new GrantBrokerError("request is not serializable or too large");
  return JSON.parse(text) as T;
}

/**
 * Reference in-process ledger (ADR 0150 D13): mint, current, revoked, revoke. Not an enforcement point.
 * Reservations: the sum of ALL children's HIGH-WATER ceilings (max ever granted; revoking or renewing down releases nothing) for a lease never exceeds the parent's
 * ceiling. Only `settleUnstarted`, and `settleChild` when no execution holds the parent (D12 refund), release one;
 * with a held parent the unused amount is taken once into its fold (`takeReturn`).
 * Bad input surfaces as `GrantBrokerError` (broker rules) or `TaskGrantShapeError` (grant shape), never a TypeError.
 * Keys: `secret` is a `GrantKeys` ring fixed at construction. There is no live rotation API, and rebuilding the
 * broker loses its in-memory ledger; a real broker persists its ledger and is rebuilt with the new ring.
 */
export class InMemoryGrantLedger {
  protected readonly tasks = new Map<string, Rec>();
  protected readonly revokedDigests = new Set<string>();
  protected readonly claims = new Map<string, string>();
  protected readonly reservations = new Map<string, Reservation>();
  /** R36: per parent and lease, everything ever carved (minted ceilings, unminted-unstarted reservations). Never decreases. */
  protected readonly carved = new Map<string, Record<string, number>>();
  protected carve(parent: string, lease: string, amount: number): void {
    const c = this.carved.get(parent) ?? {};
    c[lease] = (c[lease] ?? 0) + amount;
    this.carved.set(parent, c);
  }
  protected readonly secret: GrantKeys;
  protected readonly now: () => number;

  constructor(o: { secret: GrantKeys; now?: (() => number) | undefined }) {
    this.secret = sealKeys(o.secret);
    this.now = o.now ?? Date.now;
  }

  async current(taskId: string): Promise<TaskGrant | undefined> {
    const r = this.tasks.get(taskId);
    return r && !r.revoked ? cloneRequest(r.grant) : undefined;
  }
  async holder(taskId: string): Promise<string | undefined> {
    return this.claims.get(taskId);
  }
  async reserve(
    parentTaskId: string,
    childId: string,
    lease: Record<string, number>
  ): Promise<void> {
    const want = cloneRequest(lease);
    const parent = this.tasks.get(parentTaskId);
    if (!parent || parent.revoked) throw new GrantBrokerError("parent is unknown or revoked");
    for (const [n, a] of Object.entries(want))
      if (!Object.hasOwn(parent.grant.leases, n) || !Number.isSafeInteger(a) || a <= 0)
        throw new GrantBrokerError(`reservation ${n}: unknown lease or bad amount`);
    const have = this.reservations.get(childId);
    if (have === undefined) this.reservations.set(childId, { parent: parentTaskId, lease: want });
    else if (have.parent !== parentTaskId || JSON.stringify(have.lease) !== JSON.stringify(want))
      throw new GrantBrokerError(`child ${childId} already has a different reservation`);
  }
  async settleUnstarted(childId: string, parentTaskId: string): Promise<void> {
    const v = this.reservations.get(childId);
    if (!v || v.parent !== parentTaskId || v.outcome !== undefined) return;
    const r = this.tasks.get(childId);
    if (r !== undefined) {
      // check-unclaimed and revoke in ONE synchronous block: a claim cannot interleave (it sees revoked)
      if (this.claims.has(childId)) return; // it started: settleChild's path, never both
      const revoking = this.revoke(childId, "never started"); // minted, never claimed: it can no longer start
      r.high = Object.fromEntries(Object.keys(r.high).map((n) => [n, 0])); // it holds no headroom (carved stays)
      await revoking;
    } else for (const [n, a] of Object.entries(v.lease)) this.carve(v.parent, n, a); // R36
    v.outcome = "unstarted";
    if (!this.claims.has(v.parent)) v.taken = true; // R26: a fold-less parent has nothing to take a return into
  }
  async settleChild(taskId: string, spend: Record<string, number>): Promise<void> {
    const child = this.tasks.get(taskId);
    // R26: a fold-less parent refunds only a child that STARTED (claimed); an unclaimed one goes through settleUnstarted
    if (child?.parent !== undefined && !this.claims.has(child.parent) && !this.claims.has(taskId))
      return;
    const v = this.reservations.get(taskId);
    if (v !== undefined) {
      if (v.outcome === "unstarted") return;
      v.outcome = "started";
    }
    const r = this.tasks.get(taskId);
    if (!r || r.revoked || r.parent === undefined || r.settled !== undefined) return;
    const unused = Object.fromEntries(
      Object.entries(r.high).map(([n, h]) => [
        n,
        Math.min(h, Math.max(0, h - (Number(spend[n]) || 0))),
      ])
    );
    if (this.claims.has(r.parent)) r.settled = unused;
    else {
      // REFUND (ADR 0150 D12): a parent no execution holds has NO fold to take a return into (a schedule grant),
      // so the unused part of the child's reservation goes straight back to the parent's headroom, once
      // (`settled` guards a second call). `takeReturn` then has nothing to hand out: no double count.
      // Only a STARTED child (claimed) is refunded (R26).
      for (const [n, u] of Object.entries(unused)) r.high[n] = (r.high[n] ?? 0) - u;
      r.settled = {};
      // R26: a completed run needs no live grant; revoking it stops a renewal re-inflating the high-water mark
      await this.revoke(taskId, "settled");
    }
  }
  async takeReturn(taskId: string, parentTaskId: string): Promise<Record<string, number>> {
    const v = this.reservations.get(taskId);
    if (v?.outcome === "unstarted" && v.parent === parentTaskId) {
      if (v.taken) return {};
      v.taken = true;
      return { ...v.lease };
    }
    const r = this.tasks.get(taskId);
    if (!r || r.parent !== parentTaskId || r.settled === undefined || r.taken) return {};
    r.taken = true;
    return { ...r.settled };
  }
  async revoked(digest: string): Promise<boolean> {
    return this.revokedDigests.has(digest);
  }
  async claim(taskId: string, executionId: string): Promise<boolean> {
    const r = this.tasks.get(taskId);
    if (!r || r.revoked) return false;
    const held = this.claims.get(taskId);
    if (held === undefined) this.claims.set(taskId, executionId);
    return held === undefined || held === executionId;
  }

  /** Ceiling of `lease` the parent has not yet handed to ANY child (revoked ones included) other than `except`. */
  protected headroom(parent: Rec, lease: string, except?: string): number {
    return (parent.grant.leases[lease]?.ceiling ?? 0) - this.reserved(parent, lease, except);
  }
  protected reserved(parent: Rec, lease: string, except?: string): number {
    let sum = 0;
    for (const id of parent.children)
      if (id !== except) sum += this.tasks.get(id)?.high[lease] ?? 0;
    return sum;
  }

  async mint(request: MintRequest): Promise<TaskGrant> {
    const req = cloneRequest(request);
    if (typeof req !== "object" || req === null)
      throw new GrantBrokerError("request must be an object");
    const { taskId, ttlMs } = req;
    const now = this.now();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now + ttlMs))
      throw new GrantBrokerError("ttlMs must be a positive safe integer");
    if (this.tasks.has(taskId)) throw new GrantBrokerError(`duplicate taskId ${taskId}`);
    // ADR 0150 D7: a ROOT id becomes the `lineage:<rootId>` origin, which the kernel truncates past 256 chars.
    if (
      req.parent === undefined &&
      LINEAGE_ORIGIN_PREFIX.length + String(taskId).length > LINEAGE_ORIGIN_MAX
    )
      throw new GrantBrokerError(
        `a root taskId longer than ${LINEAGE_ORIGIN_MAX - LINEAGE_ORIGIN_PREFIX.length} chars cannot be a lineage origin`
      );
    const unsigned: UnsignedTaskGrant = {
      taskId,
      rootId: taskId,
      issuedTo: req.issuedTo,
      effects: req.effects,
      leases: req.leases,
      exp: now + ttlMs,
      epoch: 0,
    };
    if (req.tenant !== undefined) unsigned.tenant = req.tenant;
    if (req.onBehalfOf !== undefined) unsigned.onBehalfOf = req.onBehalfOf;
    if (req.reads !== undefined) unsigned.reads = req.reads;
    if (req.sandbox !== undefined) unsigned.sandbox = req.sandbox;
    let parent: Rec | undefined;
    if (req.parent !== undefined) {
      const pid: unknown = req.parent?.taskId;
      parent = typeof pid === "string" ? this.tasks.get(pid) : undefined;
      if (!parent || parent.revoked) throw new GrantBrokerError("parent is unknown or revoked");
      if (parent.grant.exp <= now) throw new GrantBrokerError("parent has expired");
      for (const k of ["tenant", "onBehalfOf"] as const) {
        if (req[k] !== undefined && req[k] !== parent.grant[k])
          throw new GrantBrokerError(`a child cannot change ${k} (it inherits the parent's)`);
        if (parent.grant[k] !== undefined) unsigned[k] = parent.grant[k];
      }
      unsigned.rootId = parent.grant.rootId;
      unsigned.parentId = parent.grant.taskId;
      unsigned.exp = Math.min(unsigned.exp, parent.grant.exp);
    }
    validateGrantShape(unsigned); // before any comparison: a NaN or null spec never reaches `>`
    if (parent) {
      const pg = parent.grant;
      if (!unsigned.effects.every((e) => pg.effects.includes(e)))
        throw new GrantBrokerError("child effects exceed the parent's");
      const widened = widensReadsOrSandbox(pg, unsigned);
      if (widened !== undefined) throw new GrantBrokerError(widened);
      for (const [name, spec] of Object.entries(unsigned.leases)) {
        if (!Object.hasOwn(pg.leases, name))
          throw new GrantBrokerError(`parent has no lease ${name}`);
        if (spec.ceiling > this.headroom(parent, name))
          throw new GrantBrokerError(`lease ${name} ceiling exceeds the parent's headroom`);
        if (
          req.parentReserved !== undefined &&
          (this.carved.get(parent.grant.taskId)?.[name] ?? 0) + spec.ceiling >
            (Number(req.parentReserved[name]) || 0)
        )
          throw new GrantBrokerError(`lease ${name} exceeds what the parent reserved in its fold`);
      }
    }
    const resv = this.reservations.get(taskId);
    if (resv !== undefined) {
      if (resv.outcome === "unstarted" || resv.parent !== req.parent?.taskId)
        throw new GrantBrokerError(`child ${taskId} has no live reservation from that parent`);
      for (const [n, spec] of Object.entries(unsigned.leases))
        if (spec.ceiling > (resv.lease[n] ?? 0))
          throw new GrantBrokerError(`lease ${n} ceiling exceeds what was reserved for the child`);
    }
    const grant = signTaskGrant(this.secret, unsigned);
    this.tasks.set(taskId, {
      grant,
      ttlMs,
      digests: [taskGrantDigest(grant)],
      parent: parent?.grant.taskId,
      children: new Set(),
      high: Object.fromEntries(Object.entries(grant.leases).map(([n, l]) => [n, l.ceiling])),
      minted: Object.fromEntries(Object.entries(grant.leases).map(([n, l]) => [n, l.ceiling])),
      spent: {},
      justifications: [],
    });
    parent?.children.add(taskId);
    if (parent)
      for (const [n, l] of Object.entries(grant.leases))
        this.carve(parent.grant.taskId, n, l.ceiling);
    return cloneRequest(grant);
  }

  /** Revoke a task and every descendant, synchronously (no renewal can interleave); idempotent. */
  async revoke(taskId: string, reason: string): Promise<void> {
    const stack = [taskId];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      const rec = this.tasks.get(id);
      if (!rec || rec.revoked) continue;
      rec.revoked = reason;
      for (const d of rec.digests) this.revokedDigests.add(d);
      stack.push(...rec.children);
    }
  }
}
