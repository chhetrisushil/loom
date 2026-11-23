import type { TaintedValue } from "@loomwork/classify";
import {
  type LeaseSpec,
  type TaskGrant,
  type UnsignedTaskGrant,
  signTaskGrant,
  taskGrantDigest,
  validateGrantShape,
} from "./grant";

export interface MintRequest {
  taskId: string;
  issuedTo: string;
  effects: string[];
  leases: Record<string, LeaseSpec>;
  ttlMs: number;
  parent?: { taskId: string };
}
export interface RenewalRequest {
  taskId: string;
  epoch: number;
  spent: Record<string, number>;
  renewals: number;
  effectClassesCaused?: string[];
  justification?: TaintedValue<string> | string;
}
export type RenewalVerdict =
  | { granted: true; epoch: number; digest: string }
  | { granted: false; reason: string };
export interface GrantSource {
  current(taskId: string): Promise<TaskGrant | undefined>;
  revoked?(digest: string): Promise<boolean>;
}
export interface GrantBroker extends GrantSource {
  mint(r: MintRequest): Promise<TaskGrant>;
  renew(r: RenewalRequest): Promise<RenewalVerdict>;
  revoke(taskId: string, reason: string): Promise<void>;
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
  spent: Record<string, number>;
  justifications: TaintedValue<string>[];
  revoked?: string;
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
 * Reservations: the sum of ALL children's HIGH-WATER ceilings (max ever granted; revoked or not; renewing down releases nothing) for a lease never exceeds the parent's
 * ceiling. The broker NEVER releases a reservation; returning unused amounts is the parent fold's job (T8).
 * Bad input surfaces as `GrantBrokerError` (broker rules) or `TaskGrantShapeError` (grant shape), never a TypeError.
 */
export class InMemoryGrantLedger {
  protected readonly tasks = new Map<string, Rec>();
  protected readonly revokedDigests = new Set<string>();
  protected readonly secret: string;
  protected readonly now: () => number;

  constructor(o: { secret: string; now?: (() => number) | undefined }) {
    this.secret = o.secret;
    this.now = o.now ?? Date.now;
  }

  async current(taskId: string): Promise<TaskGrant | undefined> {
    const r = this.tasks.get(taskId);
    return r && !r.revoked ? cloneRequest(r.grant) : undefined;
  }
  async revoked(digest: string): Promise<boolean> {
    return this.revokedDigests.has(digest);
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
    const unsigned: UnsignedTaskGrant = {
      taskId,
      rootId: taskId,
      issuedTo: req.issuedTo,
      effects: req.effects,
      leases: req.leases,
      exp: now + ttlMs,
      epoch: 0,
    };
    let parent: Rec | undefined;
    if (req.parent !== undefined) {
      const pid: unknown = req.parent?.taskId;
      parent = typeof pid === "string" ? this.tasks.get(pid) : undefined;
      if (!parent || parent.revoked) throw new GrantBrokerError("parent is unknown or revoked");
      if (parent.grant.exp <= now) throw new GrantBrokerError("parent has expired");
      unsigned.rootId = parent.grant.rootId;
      unsigned.parentId = parent.grant.taskId;
      unsigned.exp = Math.min(unsigned.exp, parent.grant.exp);
    }
    validateGrantShape(unsigned); // before any comparison: a NaN or null spec never reaches `>`
    if (parent) {
      const pg = parent.grant;
      if (!unsigned.effects.every((e) => pg.effects.includes(e)))
        throw new GrantBrokerError("child effects exceed the parent's");
      for (const [name, spec] of Object.entries(unsigned.leases)) {
        if (!Object.hasOwn(pg.leases, name))
          throw new GrantBrokerError(`parent has no lease ${name}`);
        if (spec.ceiling > this.headroom(parent, name))
          throw new GrantBrokerError(`lease ${name} ceiling exceeds the parent's headroom`);
      }
    }
    const grant = signTaskGrant(this.secret, unsigned);
    this.tasks.set(taskId, {
      grant,
      ttlMs,
      digests: [taskGrantDigest(grant)],
      parent: parent?.grant.taskId,
      children: new Set(),
      high: Object.fromEntries(Object.entries(grant.leases).map(([n, l]) => [n, l.ceiling])),
      spent: {},
      justifications: [],
    });
    parent?.children.add(taskId);
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
