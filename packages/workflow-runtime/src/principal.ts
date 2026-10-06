import type { EventEnvelope } from "@loom/core";
import { type PrincipalChain, delegationDigest } from "@loom/effect-runtime";

// ── R3k (ADR 0111) — the execution's principal is durable ─────────────────────
//
// The kernel RECORDS a bounded, non-bearer description of the principal on `EXECUTION_STARTED`
// and REHYDRATES it once per `execute()`; every decision stays 1P (the authorizers, the
// codec an app supplies). Nothing here interprets a tenant or an actor.

/** Maximum length of one identity string in a record (ADR 0111 D1). */
export const PRINCIPAL_FIELD_MAX = 256;

/**
 * What `EXECUTION_STARTED.payload.principal` (and a fork's `forkedBy` stamp) holds. A DESCRIPTION
 * of the principal, never a credential: the delegation token is never written, only a digest.
 */
export interface PrincipalRecord {
  v: 1;
  /** Opaque, app-chosen, non-secret (D3). When present the record carries nothing else. */
  ref?: string;
  /** The identity subset, written verbatim only outside strict/compliance (D1). */
  identity?: { tenant?: string; actor?: string; onBehalfOf?: string };
  /** A DIGEST of the token + its expiry; never the token (D1). */
  delegation?: { id: string; exp?: number };
}

/**
 * D3 — an app that must not put even an actor id in its log. `toRef` runs at the start (and for a
 * fork's `forkedBy`): return an opaque ref, or `undefined` when this codec does not handle the
 * chain (the next codec, or the default record, applies). `fromRef` runs once per `execute()` to
 * rebuild the effect principal from the ref alone — it can re-issue a narrowed delegation from the
 * app's own grant table. The kernel never interprets `ref`.
 */
export interface PrincipalCodec {
  toRef(chain: PrincipalChain): string | undefined;
  fromRef(
    ref: string,
    context: { executionId: string }
  ): PrincipalChain | undefined | Promise<PrincipalChain | undefined>;
}

/**
 * D2 — the app's own rehydration of a recorded principal (replaces the default for every record).
 * Returning `undefined` for a record that carries a `delegation` fails closed (D4); for any other
 * record it means "no principal".
 */
export interface PrincipalResolver {
  resolve(
    record: PrincipalRecord,
    context: { executionId: string }
  ): PrincipalChain | undefined | Promise<PrincipalChain | undefined>;
}

/**
 * How a record may carry the identity subset:
 *  - `"verbatim"` (default) — the subset is written as is (non-strict, no erasure obligation);
 *  - `"encrypted"` — the subset is written, and `defineConfig` registered `principal.identity.*`
 *    with the crypto plugin so it is encrypted at rest and shredded with the subject;
 *  - `"ref"` — identity is NEVER written: only `{ v: 1, ref }` via {@link PrincipalCodec}.
 */
export type PrincipalIdentityMode = "verbatim" | "encrypted" | "ref";

/**
 * A `start` whose principal carries a delegation, but nothing is wired that can restore it after
 * the process that minted it is gone (ADR 0111 D4): it would be denied after its first park, so
 * it is refused at the one call that can still say so. Nothing was appended. Also raised when a
 * record cannot be written without leaking identity the configuration forbids.
 */
export class PrincipalUnrestorableError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "PrincipalUnrestorableError";
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Where the record will be stored: the payload (crypto can encrypt it) or envelope metadata (it cannot). */
export type PrincipalRecordSite = "payload" | "metadata";

export interface PrincipalRecordDeps {
  readonly identity: PrincipalIdentityMode;
  readonly codec: PrincipalCodec | undefined;
  readonly hasResolver: boolean;
}

/**
 * D1 — build the record for a chain. Every 1.23.0 start writes one, an anonymous start included
 * (`{ v: 1 }`): "absent" then means a legacy log and nothing else.
 */
export function buildPrincipalRecord(
  chain: PrincipalChain | undefined,
  deps: PrincipalRecordDeps,
  site: PrincipalRecordSite = "payload"
): PrincipalRecord {
  if (chain === undefined) return { v: 1 };
  const ref = deps.codec?.toRef(chain);
  if (ref !== undefined) {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new PrincipalUnrestorableError("principalCodec.toRef must return a non-empty string");
    }
    return { v: 1, ref };
  }
  const identity: NonNullable<PrincipalRecord["identity"]> = {};
  for (const key of ["tenant", "actor", "onBehalfOf"] as const) {
    const value = chain[key];
    if (typeof value !== "string") continue;
    if (value.length > PRINCIPAL_FIELD_MAX) {
      throw new PrincipalUnrestorableError(
        `principal.${key} is longer than ${PRINCIPAL_FIELD_MAX} characters and cannot be recorded; supply a principalCodec (ref mode)`
      );
    }
    identity[key] = value;
  }
  const hasIdentity = Object.keys(identity).length > 0;
  if (hasIdentity && deps.identity === "ref") {
    throw new PrincipalUnrestorableError(
      "this runtime records principals by reference only (strict / compliance without crypto), but no principalCodec handled this principal; supply a principalCodec whose toRef covers it"
    );
  }
  if (hasIdentity && deps.identity === "encrypted" && site === "metadata") {
    throw new PrincipalUnrestorableError(
      "a fork stamps the forker into envelope metadata, which the crypto plugin does not encrypt; supply a principalCodec so the fork records a ref instead of the identity"
    );
  }
  const record: PrincipalRecord = { v: 1 };
  if (hasIdentity) record.identity = identity;
  const token = chain.delegation;
  if (token !== undefined && token !== null) {
    // Refuse BEFORE anything is appended: with nothing able to restore the token, the child
    // would be denied after its first park (D4 rule 2).
    if (!deps.hasResolver) {
      throw new PrincipalUnrestorableError(
        "the principal carries a delegation but no principalCodec/principalResolver can restore it after a park or a crash; wire one (superviseChildren({ delegation }) does for supervised children)"
      );
    }
    record.delegation = {
      id: delegationDigest(token),
      ...(typeof token.exp === "number" && { exp: token.exp }),
    };
  }
  return record;
}

/** The record to rehydrate from a sequence-0 envelope: `forkedBy` (a fork's stamp) wins over the payload's. */
export type StoredPrincipal =
  | { kind: "legacy" }
  | { kind: "shredded" }
  | { kind: "malformed"; why: string }
  | { kind: "record"; record: PrincipalRecord };

const hasShreddedMarker = (v: unknown, depth = 0): boolean => {
  if (!isPlain(v) || depth > 3) return false;
  if (v.$shredded === true) return true;
  return Object.values(v).some((x) => hasShreddedMarker(x, depth + 1));
};

/** Read the recorded principal of an execution out of its sequence-0 envelope (ADR 0111 D2). */
export function storedPrincipalOf(first: EventEnvelope | undefined): StoredPrincipal {
  if (first === undefined) return { kind: "legacy" };
  const forkedBy = first.metadata?.forkedBy;
  const raw = isPlain(forkedBy)
    ? forkedBy
    : (first.payload as { principal?: unknown } | null | undefined)?.principal;
  if (raw === undefined) return { kind: "legacy" };
  if (!isPlain(raw)) return { kind: "malformed", why: "the recorded principal is not an object" };
  if (hasShreddedMarker(raw)) return { kind: "shredded" };
  if (raw.v !== 1) {
    return { kind: "malformed", why: `unknown principal record version ${String(raw.v)}` };
  }
  const record: PrincipalRecord = { v: 1 };
  if (typeof raw.ref === "string" && raw.ref.length > 0) record.ref = raw.ref;
  if (isPlain(raw.identity)) {
    const identity: NonNullable<PrincipalRecord["identity"]> = {};
    for (const key of ["tenant", "actor", "onBehalfOf"] as const) {
      const value = raw.identity[key];
      if (typeof value === "string") identity[key] = value;
    }
    record.identity = identity;
  }
  if (isPlain(raw.delegation) && typeof raw.delegation.id === "string") {
    record.delegation = {
      id: raw.delegation.id,
      ...(typeof raw.delegation.exp === "number" && { exp: raw.delegation.exp }),
    };
  }
  return { kind: "record", record };
}

export interface PrincipalRehydrateDeps {
  readonly codec: PrincipalCodec | undefined;
  readonly resolver: PrincipalResolver | undefined;
}

/** What `execute()` runs the flow's effects as, or the reason the run must be denied. */
export async function rehydratePrincipal(
  record: PrincipalRecord,
  executionId: string,
  deps: PrincipalRehydrateDeps
): Promise<PrincipalChain | undefined> {
  if (deps.resolver !== undefined) {
    const chain = await deps.resolver.resolve(record, { executionId });
    if (chain === undefined && record.delegation !== undefined) {
      return { delegationUnresolved: record.delegation.id };
    }
    return chain;
  }
  if (record.ref !== undefined) {
    const chain = await deps.codec?.fromRef(record.ref, { executionId });
    return (
      chain ?? {
        principalUnresolved: `ref "${record.ref}" could not be restored (no principalCodec handles it)`,
      }
    );
  }
  const identity = record.identity;
  const chain: PrincipalChain | undefined =
    identity !== undefined && Object.keys(identity).length > 0 ? { ...identity } : undefined;
  if (record.delegation !== undefined) {
    // The default resolver cannot restore a token (it was never written): mark the chain so the
    // kernel denies its effects, rather than letting it fall through to a broader authorizer rule.
    return { ...chain, delegationUnresolved: record.delegation.id };
  }
  return chain;
}

/** The identity subset an `ExecutionAuthzRequest.owner` carries (ADR 0111 D5). */
export function ownerOfChain(
  chain: PrincipalChain | undefined
): { tenant?: string; actor?: string; onBehalfOf?: string } | undefined {
  // A shredded or unrestorable record names NO owner: the policy's `unknownOwner` rule applies.
  if (
    chain === undefined ||
    chain.principalShredded === true ||
    chain.principalUnresolved !== undefined
  ) {
    return undefined;
  }
  const out: { tenant?: string; actor?: string; onBehalfOf?: string } = {};
  if (typeof chain.tenant === "string") out.tenant = chain.tenant;
  if (typeof chain.actor === "string") out.actor = chain.actor;
  if (typeof chain.onBehalfOf === "string") out.onBehalfOf = chain.onBehalfOf;
  return Object.keys(out).length > 0 ? out : undefined;
}
