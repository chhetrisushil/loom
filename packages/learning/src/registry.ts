import { type PolicyManifest, type PromotionVerdict, policyManifest } from "./promote";
import type { EvalReport } from "./types";

// ── The policy registry: versions, promotion, rollout, rollback (R18, ADR 0124) ──
//
// ADR 0080 made promotion a VERDICT: `promotionGate` says a version passed an evaluation and
// nothing remembers it. "Which version is live", "who is on the canary", "go back to what was
// running yesterday" were redeploys. This is the state machine behind those words, kept in a
// compare-and-set key-value store (`DurableStateStore` satisfies it) so two processes share one
// answer and a restart loses nothing.
//
// What it is NOT: it never runs a policy and never writes the event log. The acting decision is
// still a logged `ctx.decide` (see `decideWithRollout`), which records WHICH version acted, so a
// replay serves the recorded choice whatever the registry says today (P9). Promotion is the only
// way a candidate becomes live, and it needs an `ok` verdict for exactly that version.

export type RolloutMode = "full" | "canary" | "shadow";

/** A compare-and-set keyed store. `DurableStateStore` (`@loom/plugin-durable-state`) satisfies it. */
export interface PolicyKvStore {
  load(key: string): Promise<{ revision: number; payload: unknown } | null>;
  save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<{ revision: number }>;
}

/** One immutable policy version. A version string never changes meaning once registered. */
export interface RegisteredVersion {
  version: string;
  /** `sha256:` of what this version IS (weights, parameters, code identity). Caller-supplied. */
  contentHash: string;
  registeredAt: number;
  /** The manifest that justified its last promotion, if it has been promoted. */
  evidence?: PolicyManifest;
}

/** Who is live for one policy id, and who is being tried. */
export interface RolloutState {
  id: string;
  mode: RolloutMode;
  /** The version that acts for everyone outside the candidate's slice. Absent before bootstrap. */
  incumbent?: string;
  /** The version being tried (`canary`/`shadow`). */
  candidate?: string;
  /** Fraction of units routed to the candidate in `canary`, in (0,1). */
  canaryFraction?: number;
  /** Stable bucketing salt: ramping the fraction up keeps earlier units on the candidate. */
  salt: string;
  /** Changes on every mutation; lets a caller cache a resolution cheaply. */
  revision: number;
}

export interface RolloutHistoryEntry {
  seq: number;
  at: number;
  action: "register" | "bootstrap" | "promote" | "ramp" | "rollback";
  version?: string;
  from?: string;
  to?: string;
  mode?: RolloutMode;
  note?: string;
}

interface PolicyDoc {
  scope: string;
  id: string;
  seq: number;
  versions: Record<string, RegisteredVersion>;
  rollout: RolloutState | null;
  history: RolloutHistoryEntry[];
}

export class PolicyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRegistryError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
/** The stored document belongs to another scope (tenant/principal): refused, never read through. */
export class PolicyAccessDeniedError extends PolicyRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "PolicyAccessDeniedError";
  }
}
/** A version was re-registered with different content: versions are immutable evidence. */
export class PolicyVersionConflictError extends PolicyRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "PolicyVersionConflictError";
  }
}
/** `promote` was called without a passing verdict for exactly that version. */
export class PromotionRefusedError extends PolicyRegistryError {
  constructor(
    message: string,
    readonly reasons: readonly string[] = []
  ) {
    super(message);
    this.name = "PromotionRefusedError";
  }
}
export class PolicyNotFoundError extends PolicyRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "PolicyNotFoundError";
  }
}
export class PolicyConflictError extends PolicyRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConflictError";
  }
}

const CONTRACT = 1;
const MAX_CAS_ATTEMPTS = 8;
/** History is a bounded ring: the registry is state, not an audit log (the log is). */
export const MAX_REGISTRY_HISTORY = 200;
/** Versions kept per policy id. Registering past it is refused rather than evicting evidence. */
export const MAX_REGISTRY_VERSIONS = 1000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

function checkName(kind: string, v: string): string {
  if (typeof v !== "string" || !NAME.test(v)) {
    throw new PolicyRegistryError(`${kind} must match ${NAME} (got ${JSON.stringify(v)})`);
  }
  return v;
}
function clone<T>(v: T): T {
  return structuredClone(v);
}

export interface PolicyRegistryOptions {
  kv: PolicyKvStore;
  /**
   * The scope this registry instance serves - a tenant or principal id taken from the
   * AUTHENTICATED caller, never from request text. It is fixed at construction so no call
   * carries a scope that could be spoofed, and it is part of every key; a stored document that
   * names a different scope is refused.
   */
  scope: string;
}

export interface PromoteInput {
  id: string;
  version: string;
  /** The evaluation that justified it. Its `policy` must name exactly `{id, version}`. */
  report: EvalReport;
  /** `promotionGate(report, ...)`. Must be `ok`. */
  verdict: PromotionVerdict;
  mode: RolloutMode;
  /** Required for `canary`, in (0,1). */
  canaryFraction?: number;
  /** Supplied by the caller (never read from a clock here): keeps a manifest reproducible. */
  now: number;
}

export class PolicyRegistry {
  private readonly kv: PolicyKvStore;
  private readonly scope: string;

  constructor(opts: PolicyRegistryOptions) {
    this.kv = opts.kv;
    this.scope = checkName("scope", opts.scope);
  }

  private key(id: string): string {
    return `loom.policies/${encodeURIComponent(this.scope)}/${encodeURIComponent(checkName("policy id", id))}`;
  }

  private async load(id: string): Promise<{ doc: PolicyDoc; revision: number }> {
    const rec = await this.kv.load(this.key(id));
    if (rec === null) {
      return {
        doc: { scope: this.scope, id, seq: 0, versions: {}, rollout: null, history: [] },
        revision: 0,
      };
    }
    const p = rec.payload as PolicyDoc;
    if (
      typeof p !== "object" ||
      p === null ||
      typeof p.versions !== "object" ||
      p.versions === null
    ) {
      throw new PolicyRegistryError("stored policy document is malformed");
    }
    // The key is the scope's namespace; a document that names another scope or id is corrupt
    // or swapped in: refuse it rather than serve (or extend) someone else's rollout.
    if (p.scope !== this.scope) {
      throw new PolicyAccessDeniedError("stored policy document belongs to another scope");
    }
    if (p.id !== id) throw new PolicyRegistryError("stored policy document names another policy");
    return { doc: p, revision: rec.revision };
  }

  private async mutate<T>(id: string, fn: (doc: PolicyDoc) => T): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const { doc, revision } = await this.load(id);
      const out = fn(doc);
      try {
        await this.kv.save(this.key(id), { contractVersion: CONTRACT, payload: doc }, revision);
        return clone(out);
      } catch (e) {
        if ((e as Error)?.name === "RevisionConflictError") continue;
        throw e;
      }
    }
    throw new PolicyConflictError("too many concurrent writers");
  }

  private static note(doc: PolicyDoc, e: Omit<RolloutHistoryEntry, "seq">): void {
    doc.seq += 1;
    doc.history.push({ seq: doc.seq, ...e });
    if (doc.history.length > MAX_REGISTRY_HISTORY) {
      doc.history.splice(0, doc.history.length - MAX_REGISTRY_HISTORY);
    }
    if (doc.rollout !== null) doc.rollout.revision = doc.seq;
  }

  /**
   * Register a version. Idempotent for identical content; a different `contentHash` under an
   * existing version string is refused (`PolicyVersionConflictError`) - a version that can change
   * meaning would invalidate every evaluation that named it.
   */
  async register(input: {
    id: string;
    version: string;
    contentHash: string;
    now: number;
  }): Promise<RegisteredVersion> {
    checkName("version", input.version);
    if (!/^sha256:[0-9a-f]{64}$/.test(input.contentHash)) {
      throw new PolicyRegistryError("contentHash must be `sha256:<64 hex>` (use contentHash())");
    }
    return this.mutate(input.id, (doc) => {
      const existing = doc.versions[input.version];
      if (existing !== undefined) {
        if (existing.contentHash !== input.contentHash) {
          throw new PolicyVersionConflictError(
            `version ${input.version} of ${input.id} is already registered with different content`
          );
        }
        return existing;
      }
      if (Object.keys(doc.versions).length >= MAX_REGISTRY_VERSIONS) {
        throw new PolicyRegistryError(`too many versions registered for ${input.id}`);
      }
      const rec: RegisteredVersion = {
        version: input.version,
        contentHash: input.contentHash,
        registeredAt: input.now,
      };
      doc.versions[input.version] = rec;
      PolicyRegistry.note(doc, { at: input.now, action: "register", version: input.version });
      return rec;
    });
  }

  /**
   * Install the FIRST incumbent: the baseline that needs no verdict because nothing is running
   * yet. Refused once an incumbent exists - changing a live policy takes `promote` or `rollback`.
   */
  async bootstrap(input: { id: string; version: string; now: number }): Promise<RolloutState> {
    return this.mutate(input.id, (doc) => {
      if (doc.versions[input.version] === undefined) {
        throw new PolicyNotFoundError(`version ${input.version} of ${input.id} is not registered`);
      }
      if (doc.rollout?.incumbent !== undefined) {
        throw new PolicyRegistryError(
          `${input.id} already has an incumbent (${doc.rollout.incumbent}); use promote or rollback`
        );
      }
      doc.rollout = {
        id: input.id,
        mode: "full",
        incumbent: input.version,
        salt: `${input.id}`,
        revision: 0,
      };
      PolicyRegistry.note(doc, {
        at: input.now,
        action: "bootstrap",
        version: input.version,
        to: input.version,
        mode: "full",
      });
      return doc.rollout;
    });
  }

  /**
   * Make a registered version live in `mode`. Needs an `ok` verdict whose report names exactly
   * this `{id, version}` - a verdict for a different version, or a failing one, is refused:
   * promotion is the single door a candidate walks through.
   *
   * - `full`: the version becomes THE incumbent (the previous one is kept for `rollback`).
   * - `canary`: a stable fraction of units is routed to it; everyone else keeps the incumbent.
   * - `shadow`: it is evaluated and logged beside the incumbent but NEVER acts.
   */
  async promote(input: PromoteInput): Promise<RolloutState> {
    if (!input.verdict.ok) {
      throw new PromotionRefusedError(
        `refusing to promote ${input.id}@${input.version}: the verdict did not pass`,
        input.verdict.reasons
      );
    }
    if (input.report.policy.id !== input.id || input.report.policy.version !== input.version) {
      throw new PromotionRefusedError(
        `refusing to promote ${input.id}@${input.version}: the evaluation is of ${input.report.policy.id}@${input.report.policy.version}`
      );
    }
    if (input.mode === "canary") {
      const f = input.canaryFraction;
      if (f === undefined || !(f > 0 && f < 1)) {
        throw new PolicyRegistryError("canary needs canaryFraction in (0,1)");
      }
    }
    return this.mutate(input.id, (doc) => {
      const v = doc.versions[input.version];
      if (v === undefined) {
        throw new PolicyNotFoundError(`version ${input.version} of ${input.id} is not registered`);
      }
      const cur = doc.rollout;
      if (cur?.incumbent === undefined && input.mode !== "full") {
        throw new PolicyRegistryError(
          `${input.id} has no incumbent to canary or shadow against; bootstrap one first`
        );
      }
      if (cur?.incumbent === input.version && input.mode !== "full") {
        throw new PolicyRegistryError(`${input.version} is already the incumbent of ${input.id}`);
      }
      v.evidence = policyManifest(input.report, input.verdict, {
        promotedAt: input.now,
        ...(input.mode === "canary" && { canary: input.canaryFraction as number }),
      });
      const from = cur?.incumbent;
      doc.rollout = {
        id: input.id,
        mode: input.mode,
        ...(input.mode === "full"
          ? { incumbent: input.version }
          : { incumbent: cur?.incumbent as string, candidate: input.version }),
        ...(input.mode === "canary" && { canaryFraction: input.canaryFraction as number }),
        salt: `${input.id}:${input.version}`,
        revision: 0,
      };
      PolicyRegistry.note(doc, {
        at: input.now,
        action: "promote",
        version: input.version,
        ...(from !== undefined && { from }),
        to: input.version,
        mode: input.mode,
      });
      return doc.rollout;
    });
  }

  /** Change the canary fraction of the running canary (e.g. 5% -> 25%); the slice only grows or shrinks, buckets stay stable. */
  async ramp(input: { id: string; canaryFraction: number; now: number }): Promise<RolloutState> {
    if (!(input.canaryFraction > 0 && input.canaryFraction < 1)) {
      throw new PolicyRegistryError("canaryFraction must be in (0,1)");
    }
    return this.mutate(input.id, (doc) => {
      if (doc.rollout?.mode !== "canary") {
        throw new PolicyRegistryError(`${input.id} has no canary to ramp`);
      }
      doc.rollout.canaryFraction = input.canaryFraction;
      PolicyRegistry.note(doc, {
        at: input.now,
        action: "ramp",
        ...(doc.rollout.candidate !== undefined && { version: doc.rollout.candidate }),
        mode: "canary",
      });
      return doc.rollout;
    });
  }

  /**
   * Instant rollback: a single CAS write that makes `to` (default: the version that was the
   * incumbent before the last promotion to `full`) the incumbent in `full` mode and drops any
   * candidate. No redeploy, no retraining - the next decision resolves to the old version.
   */
  async rollback(input: {
    id: string;
    to?: string;
    now: number;
    note?: string;
  }): Promise<RolloutState> {
    return this.mutate(input.id, (doc) => {
      const cur = doc.rollout;
      if (cur === null) throw new PolicyNotFoundError(`${input.id} has no rollout state`);
      let target = input.to;
      if (target === undefined) {
        // Walk back to the most recent DIFFERENT incumbent. A canary/shadow rollback restores
        // the incumbent already in place (candidate dropped).
        if (cur.candidate !== undefined) target = cur.incumbent;
        else {
          for (let i = doc.history.length - 1; i >= 0; i--) {
            const h = doc.history[i] as RolloutHistoryEntry;
            if (h.action === "promote" && h.mode === "full" && h.to === cur.incumbent) {
              target = h.from;
              break;
            }
          }
        }
      }
      if (target === undefined) {
        throw new PolicyNotFoundError(`${input.id} has no previous version to roll back to`);
      }
      if (doc.versions[target] === undefined) {
        throw new PolicyNotFoundError(`version ${target} of ${input.id} is not registered`);
      }
      const from = cur.incumbent;
      doc.rollout = { id: input.id, mode: "full", incumbent: target, salt: cur.salt, revision: 0 };
      PolicyRegistry.note(doc, {
        at: input.now,
        action: "rollback",
        ...(from !== undefined && { from }),
        to: target,
        mode: "full",
        ...(input.note !== undefined && { note: input.note }),
      });
      return doc.rollout;
    });
  }

  /** The live rollout state, or `undefined` for a policy with none (never leaks another scope's). */
  async resolve(id: string): Promise<RolloutState | undefined> {
    const { doc } = await this.load(id);
    return doc.rollout === null ? undefined : clone(doc.rollout);
  }

  async version(id: string, version: string): Promise<RegisteredVersion | undefined> {
    const { doc } = await this.load(id);
    const v = doc.versions[version];
    return v === undefined ? undefined : clone(v);
  }

  async versions(id: string): Promise<RegisteredVersion[]> {
    const { doc } = await this.load(id);
    return Object.values(clone(doc.versions));
  }

  async history(id: string): Promise<RolloutHistoryEntry[]> {
    const { doc } = await this.load(id);
    return clone(doc.history);
  }
}

/** A CAS store in memory with `DurableStateStore`'s semantics - for tests and single-process use. */
export class InMemoryPolicyKv implements PolicyKvStore {
  private readonly records = new Map<string, { revision: number; payload: unknown }>();
  async load(key: string): Promise<{ revision: number; payload: unknown } | null> {
    const r = this.records.get(key);
    return r === undefined ? null : structuredClone(r);
  }
  async save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<{ revision: number }> {
    const actual = this.records.get(key)?.revision ?? 0;
    if (expectedRevision !== actual) {
      const e = new Error(
        `revision conflict on ${key}: expected ${expectedRevision}, at ${actual}`
      );
      e.name = "RevisionConflictError";
      throw e;
    }
    const revision = actual + 1;
    this.records.set(key, { revision, payload: structuredClone(value.payload) });
    return { revision };
  }
}
