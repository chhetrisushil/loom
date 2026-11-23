import { type TaintedValue, isTainted, tainted } from "@loomwork/classify";
import {
  type LeaseSpec,
  type TaskGrant,
  type UnsignedTaskGrant,
  signTaskGrant,
  taskGrantDigest,
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
export interface RenewalVerdict {
  granted: boolean;
  epoch?: number;
  digest?: string;
  reason?: string;
}
export interface GrantSource {
  current(taskId: string): Promise<TaskGrant | undefined>;
  revoked?(digest: string): Promise<boolean>;
}
export interface GrantBroker extends GrantSource {
  mint(r: MintRequest): Promise<TaskGrant>;
  renew(r: RenewalRequest): Promise<RenewalVerdict>;
  revoke(taskId: string, reason: string): Promise<void>;
}
export type RenewalPolicy = (
  req: Readonly<RenewalRequest>,
  history: Readonly<{ renewals: number; spentSoFar: Record<string, number> }>
) => false | { leases?: Record<string, number> };

/** A mint was refused (parent missing, scope widened, ceiling over headroom, duplicate id, bad ttl). */
export class GrantBrokerError extends Error {
  override name = "GrantBrokerError";
}

export const MAX_JUSTIFICATION = 4096;

interface Rec {
  grant: TaskGrant;
  ttlMs: number;
  digests: string[];
  parent?: string | undefined;
  children: Set<string>;
  spent: Record<string, number>;
  justifications: TaintedValue<string>[];
  revoked?: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const defaultPolicy: RenewalPolicy = (_r, h) => (h.renewals < 8 ? {} : false);

/** Validate a renewal request (untrusted input); returns a reason when it is out of bounds. */
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
  const text = isTainted(j) ? j.value : j;
  if (j !== undefined && (typeof text !== "string" || text.length > MAX_JUSTIFICATION))
    return `justification must be a string of at most ${MAX_JUSTIFICATION} code units`;
  return undefined;
}

/** Reference in-process broker (ADR 0150 D13). Not an enforcement point: the authorizer verifies signatures. */
export class InMemoryGrantBroker implements GrantBroker {
  private readonly tasks = new Map<string, Rec>();
  private readonly revokedDigests = new Set<string>();
  private readonly secret: string;
  private readonly now: () => number;
  private readonly policy: RenewalPolicy;

  constructor(o: {
    secret: string;
    now?: (() => number) | undefined;
    policy?: RenewalPolicy | undefined;
  }) {
    this.secret = o.secret;
    this.now = o.now ?? Date.now;
    this.policy = o.policy ?? defaultPolicy;
  }

  async current(taskId: string): Promise<TaskGrant | undefined> {
    const r = this.tasks.get(taskId);
    return r && !r.revoked ? clone(r.grant) : undefined;
  }
  async revoked(digest: string): Promise<boolean> {
    return this.revokedDigests.has(digest);
  }

  /** Ceiling a lease of `parent` still has for a child other than `except`. */
  private headroom(parent: Rec, lease: string, except?: string): number {
    let free = parent.grant.leases[lease]?.ceiling ?? 0;
    for (const id of parent.children) {
      const c = this.tasks.get(id);
      if (id !== except && c && !c.revoked) free -= c.grant.leases[lease]?.ceiling ?? 0;
    }
    return free;
  }

  async mint(request: MintRequest): Promise<TaskGrant> {
    const req = clone(request);
    const { taskId, ttlMs } = req;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new GrantBrokerError("ttlMs must be a positive safe integer");
    if (this.tasks.has(taskId)) throw new GrantBrokerError(`duplicate taskId ${taskId}`);
    const unsigned: UnsignedTaskGrant = {
      taskId,
      rootId: taskId,
      issuedTo: req.issuedTo,
      effects: req.effects,
      leases: req.leases,
      exp: this.now() + ttlMs,
      epoch: 0,
    };
    let parent: Rec | undefined;
    if (req.parent !== undefined) {
      parent = this.tasks.get(req.parent.taskId);
      if (!parent || parent.revoked) throw new GrantBrokerError("parent is unknown or revoked");
      const pg = parent.grant;
      if (!req.effects.every((e) => pg.effects.includes(e)))
        throw new GrantBrokerError("child effects exceed the parent's");
      for (const [name, spec] of Object.entries(req.leases)) {
        if (!Object.hasOwn(pg.leases, name))
          throw new GrantBrokerError(`parent has no lease ${name}`);
        if (spec.ceiling > this.headroom(parent, name))
          throw new GrantBrokerError(`lease ${name} ceiling exceeds the parent's headroom`);
      }
      unsigned.rootId = pg.rootId;
      unsigned.parentId = pg.taskId;
    }
    const grant = signTaskGrant(this.secret, unsigned);
    this.tasks.set(taskId, {
      grant,
      ttlMs,
      digests: [taskGrantDigest(grant)],
      parent: parent?.grant.taskId,
      children: new Set(),
      spent: {},
      justifications: [],
    });
    parent?.children.add(taskId);
    return clone(grant);
  }

  async renew(request: RenewalRequest): Promise<RenewalVerdict> {
    const deny = (reason: string): RenewalVerdict => ({ granted: false, reason });
    const bad = badRenewal(request);
    if (bad) return deny(bad);
    const req = clone(request);
    const rec = this.tasks.get(req.taskId);
    if (!rec || rec.revoked) return deny("unknown or revoked task");
    if (req.epoch !== rec.grant.epoch) return deny("stale epoch");
    if (req.justification !== undefined)
      rec.justifications.push(tainted(req.justification as string, "task-authority:renewal"));
    rec.spent = req.spent;
    const verdict = this.policy(req, { renewals: rec.digests.length - 1, spentSoFar: rec.spent });
    if (verdict === false) return deny("policy denied the renewal");
    const cur = rec.grant;
    const leases: Record<string, LeaseSpec> = clone(cur.leases);
    const parent = rec.parent ? this.tasks.get(rec.parent) : undefined;
    for (const [name, ceiling] of Object.entries(verdict.leases ?? {})) {
      if (!Object.hasOwn(leases, name))
        return deny(`policy named a lease the grant lacks: ${name}`);
      if (parent && ceiling > this.headroom(parent, name, rec.grant.taskId))
        return deny(`lease ${name} ceiling exceeds the parent's headroom`);
      (leases[name] as LeaseSpec).ceiling = ceiling;
    }
    let next: TaskGrant;
    try {
      const { sig: _sig, ...body } = cur;
      next = signTaskGrant(this.secret, {
        ...body,
        leases,
        exp: this.now() + rec.ttlMs,
        epoch: cur.epoch + 1,
      });
    } catch (e) {
      return deny(e instanceof Error ? e.message : "invalid renewal");
    }
    const digest = taskGrantDigest(next);
    rec.grant = next;
    rec.digests.push(digest);
    return { granted: true, epoch: next.epoch, digest };
  }

  async revoke(taskId: string, reason: string): Promise<void> {
    const rec = this.tasks.get(taskId);
    if (!rec || rec.revoked) return;
    rec.revoked = reason;
    for (const d of rec.digests) this.revokedDigests.add(d);
    for (const c of rec.children) await this.revoke(c, reason);
  }
}
