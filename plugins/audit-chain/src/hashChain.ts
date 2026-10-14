import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import {
  type AppendIfUnchangedResult,
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  type TipObservation,
  installOptional,
} from "@loom/event-runtime";

// ── Tamper-evident hash-chained event store ───────────────────────────────────
//
// Wrap any EventStore so each appended event carries, in its metadata:
//   chain.prevHash — the hash of the previous event in this execution (genesis = "")
//   chain.hash     — H(prevHash ‖ canonical(event-without-chain)) over SHA-256
//   chain.sig      — OPTIONAL HMAC-SHA256(secret, hash), if a secret is configured
// Any later edit/insert/reorder/drop breaks the chain: a recomputation no longer
// matches the stored hash (and, with a secret, an attacker who re-chains still can't
// forge the HMAC). `verifyChain` recomputes the whole chain out-of-band.
//
// Crucially the chain lives ENTIRELY in `metadata`, which the ReplayVM fold ignores —
// so replay is byte-identical whether or not chaining is wired (G1/G2). The wrapper
// composes below tenant-scoping and above the base store:
//   hashChainedEventStore(tenantScopedEventStore(fencingStore(base)))

/** Namespaced chain fields stamped into each event's metadata. */
export interface ChainMetadata {
  prevHash: string;
  hash: string;
  sig?: string;
  /**
   * Which key produced `sig`, when signing asymmetrically. Present so rotation does not
   * invalidate history: an entry signed last year still verifies against the key that signed
   * it, which is the whole point of an audit trail and the reason revocation — the hard part
   * of key lifecycle for a live capability — does not apply here.
   */
  keyId?: string;
}

/**
 * Produces a signature over a chain hash (#382).
 *
 * The HMAC path makes the log tamper-evident against a third party who does not hold the
 * secret. It cannot make it third-party VERIFIABLE, because verification needs the same
 * secret: anyone you enable to check the log can also rewrite it — re-chain the hashes,
 * re-compute the HMACs, and the result verifies cleanly. The verifier and the forger are the
 * same role, which is exactly what an auditor must not be.
 *
 * An asymmetric signer splits them. Loom makes no trust-root decision: it signs with the key
 * you give it, exactly as it HMACs with the secret you give it.
 */
export interface ChainSigner {
  /** Names the key in each entry, so a verifier can select one. */
  readonly keyId: string;
  sign(hash: string): string;
}

/**
 * Checks a signature — and CANNOT produce one. That asymmetry is the feature: hand this to
 * an auditor and they can check every entry without being able to author a single one.
 */
export interface ChainVerifier {
  verify(hash: string, sig: string, keyId: string | undefined): boolean;
}

export interface ChainVerification {
  ok: boolean;
  /** Number of events checked. */
  length: number;
  /**
   * Whether SIGNATURES were checked, not just hashes. A chain verified without a secret or a
   * verifier is still a real result — the hashes chain — but it says nothing about authorship,
   * and `ok: true` must not be read as if it did.
   */
  signaturesChecked: boolean;
  /** The sequence at which the chain first broke (absent when ok). */
  brokenAt?: number;
  /** Why it broke — a short, specific reason (absent when ok). */
  reason?: string;
}

export interface HashChainOptions {
  /**
   * If set, each event is also HMAC-signed, so a re-chaining tamper is still detectable —
   * by anyone holding the same secret. Tamper-EVIDENT, not third-party verifiable (#382).
   */
  hmacSecret?: string;
  /**
   * Sign each entry asymmetrically instead (#382). Mutually exclusive with `hmacSecret`:
   * the two make different promises, and a reader cannot be left to guess which one a given
   * entry carries.
   */
  signer?: ChainSigner;
  /**
   * Check signatures during `verifyChain`. An auditor configures THIS and nothing else — no
   * signer, no secret — and can then verify every entry without being able to author one.
   */
  verifier?: ChainVerifier;
}

export interface HashChainedEventStore extends EventStore {
  /** Recompute the chain for an execution and report the first break, if any. */
  verifyChain(executionId: string): Promise<ChainVerification>;
}

const GENESIS = "";

/**
 * Deterministic serialization: object keys sorted recursively, `undefined` omitted.
 * Two structurally-equal events always serialize identically regardless of key
 * insertion order — closing the canonicalization ambiguity that would otherwise let
 * a tamper reorder keys to preserve a hash.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** The bytes covered by the chain hash: the event minus its own chain metadata. */
function chainablePayload(e: EventEnvelope): string {
  const { auditChain: _omit, ...restMeta } = (e.metadata ?? {}) as Record<string, unknown> & {
    auditChain?: unknown;
  };
  return canonicalize({
    id: e.id,
    workflowId: e.workflowId,
    executionId: e.executionId,
    eventType: e.eventType,
    sequence: e.sequence,
    timestamp: e.timestamp,
    payload: e.payload,
    metadata: restMeta,
  });
}

// SHA-256 hex digests are exactly 64 lowercase hex chars.
const SHA256_HEX = /^[0-9a-f]{64}$/;

function hashEvent(prevHash: string, e: EventEnvelope): string {
  const payload = chainablePayload(e);
  // Length-prefix each field so the (prevHash, payload) boundary is UNAMBIGUOUS —
  // no crafted payload can shift where prevHash ends and the canonical form begins,
  // even though prevHash is already fixed-format hex. Belt and suspenders.
  return createHash("sha256")
    .update(`${prevHash.length}:${prevHash}|${payload.length}:${payload}`)
    .digest("hex");
}

function signHash(secret: string, hash: string): string {
  return createHmac("sha256", secret).update(hash).digest("hex");
}

function hmacMatches(secret: string, hash: string, sig: string): boolean {
  // Reject a malformed signature outright — otherwise `Buffer.from(sig, "hex")`
  // silently truncates at the first invalid nibble, which would compare a short
  // buffer against the full HMAC. A valid HMAC-SHA256 sig is 64 hex chars.
  if (!SHA256_HEX.test(sig)) return false;
  const expected = Buffer.from(signHash(secret, hash), "hex");
  const actual = Buffer.from(sig, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const chainOf = (e: EventEnvelope): ChainMetadata | undefined =>
  (e.metadata as { auditChain?: ChainMetadata } | undefined)?.auditChain;

// A terminal event ends an execution's write stream — its cached chain head can be
// dropped to bound the per-execution cache. A rare post-terminal append (a late audit
// fact) just cold-reads the tail again, which is correct, only slower.
const TERMINAL_EVENTS = new Set([
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "EXECUTION_CANCELLED",
  "EXECUTION_CONTINUED", // ADR 0109: the predecessor's write stream ends at the hand-off
]);

/**
 * Wrap a store so every append is hash-chained (and optionally HMAC-signed).
 *
 * **Ordering matters when composing with `ContentResolvingEventStore`: the chain must be
 * OUTSIDE content resolution.** The chain hashes the envelope it is handed at append, and
 * `verifyChain` recomputes over whatever `inner.read()` returns:
 *
 * ```ts
 * hashChainedEventStore(new ContentResolvingEventStore(raw, content, { externalize })) // ✅
 * new ContentResolvingEventStore(hashChainedEventStore(raw), content, { externalize })  // ❌
 * ```
 *
 * Outside, the chain covers the FULL payload and verification re-reads it resolved, so
 * rewriting an externalized blob breaks the hash. Inside, the chain only ever sees the ref
 * string — the bytes sit outside everything it hashed, and tampering with them is silent.
 * Both orderings type-check and both pass every other test, so the difference is pinned in
 * `contentOrdering.test.ts`. This is also why verify-on-read is not a `ContentStore` SPI
 * obligation: the correct ordering already buys blob integrity, once per write rather than on
 * every read.
 */
export function hashChainedEventStore(
  inner: EventStore,
  options: HashChainOptions = {}
): HashChainedEventStore {
  const secret = options.hmacSecret;
  const signer = options.signer;
  const verifier = options.verifier;
  if (secret !== undefined && signer !== undefined) {
    throw new Error(
      "hashChainedEventStore: `hmacSecret` and `signer` are mutually exclusive — one makes the " +
        "log tamper-evident to secret-holders, the other makes it verifiable by anyone holding " +
        "the public key. A reader cannot be left to guess which promise an entry carries."
    );
  }
  // Last hash per execution, so an append can chain onto it without re-reading. Bounded
  // by the number of live executions writing through this store instance.
  const lastHash = new Map<string, string>();

  const priorHashFor = async (executionId: string): Promise<string> => {
    const cached = lastHash.get(executionId);
    if (cached !== undefined) return cached;
    // Cold start / recovery: derive the tail hash from what's already durable.
    const existing = await inner.read(executionId);
    const tail =
      existing.length > 0 ? chainOf(existing[existing.length - 1] as EventEnvelope) : undefined;
    const prev = tail?.hash ?? GENESIS;
    lastHash.set(executionId, prev);
    return prev;
  };

  const store: HashChainedEventStore = {
    async append(envelope: EventEnvelope): Promise<void> {
      const stamped = stamp(envelope, await priorHashFor(envelope.executionId));
      await inner.append(stamped);
      // Only advance the chain head after a durable append succeeds — a rejected
      // append (e.g. stale fence) must not poison the next event's prevHash. Drop the
      // cache entry once the execution reaches a terminal event so the map stays
      // bounded to in-flight executions (a long-lived writer would otherwise grow it
      // by one entry per execution, forever).
      advance(stamped, (chainOf(stamped) as ChainMetadata).hash);
    },
    read: (executionId) => inner.read(executionId),
    readFrom: (executionId, fromSequence) => inner.readFrom(executionId, fromSequence),
    subscribe: (executionId, handler) => inner.subscribe(executionId, handler),
    close: () => inner.close(),
    async verifyChain(executionId: string): Promise<ChainVerification> {
      // Reported on every outcome so a hash-only pass can never read as an authorship check.
      const signaturesChecked = verifier !== undefined || secret !== undefined;
      const events = await inner.read(executionId);
      let prev = GENESIS;
      for (const e of events) {
        const chain = chainOf(e);
        if (chain === undefined) {
          return {
            ok: false,
            length: events.length,
            signaturesChecked,
            brokenAt: e.sequence,
            reason: "missing chain metadata",
          };
        }
        if (chain.prevHash !== prev) {
          return {
            ok: false,
            length: events.length,
            signaturesChecked,
            brokenAt: e.sequence,
            reason: "prevHash mismatch (event dropped or reordered)",
          };
        }
        const expected = hashEvent(prev, e);
        if (expected !== chain.hash) {
          return {
            ok: false,
            length: events.length,
            signaturesChecked,
            brokenAt: e.sequence,
            reason: "hash mismatch (event tampered)",
          };
        }
        if (verifier !== undefined) {
          if (chain.sig === undefined) {
            return {
              ok: false,
              length: events.length,
              signaturesChecked: true,
              brokenAt: e.sequence,
              reason: "signature missing (unsigned entry)",
            };
          }
          if (!verifier.verify(chain.hash, chain.sig, chain.keyId)) {
            return {
              ok: false,
              length: events.length,
              signaturesChecked: true,
              brokenAt: e.sequence,
              // An unknown keyId lands here too: a signature this verifier cannot check is
              // not a signature it may ignore.
              reason: "signature invalid (forged, or signed by an unknown key)",
            };
          }
        } else if (secret !== undefined) {
          if (chain.sig === undefined || !hmacMatches(secret, chain.hash, chain.sig)) {
            return {
              ok: false,
              length: events.length,
              signaturesChecked: true,
              brokenAt: e.sequence,
              reason: "signature invalid (forged or unsigned)",
            };
          }
        }
        prev = chain.hash;
      }
      return { ok: true, length: events.length, signaturesChecked };
    },
  };

  // Stamp one envelope onto `prevHash`. Shared by `append` and `appendBatch`.
  const stamp = (envelope: EventEnvelope, prevHash: string): EventEnvelope => {
    const hash = hashEvent(prevHash, envelope);
    const chain: ChainMetadata = signer
      ? { prevHash, hash, sig: signer.sign(hash), keyId: signer.keyId }
      : secret
        ? { prevHash, hash, sig: signHash(secret, hash) }
        : { prevHash, hash };
    return { ...envelope, metadata: { ...envelope.metadata, auditChain: chain } };
  };

  // Advance the cached head after a DURABLE append — never before (see `append`).
  const advance = (envelope: EventEnvelope, hash: string): void => {
    if (TERMINAL_EVENTS.has(envelope.eventType)) lastHash.delete(envelope.executionId);
    else lastHash.set(envelope.executionId, hash);
  };

  // Every optional method decided over the whole union (ADR 0074 Amendment).
  const plan = {
    // Group by execution in one pass (a Map keeps arrival order), resolve each execution's
    // prior hash ONCE, chain sequentially within each group, and emit in the ORIGINAL array
    // order — the SPI's per-execution order. The heads advance only after the batch is
    // durable, the same rule as `append`: a rejected batch must not poison the next prevHash.
    appendBatch: async (envelopes: readonly EventEnvelope[]): Promise<void> => {
      if (envelopes.length === 0) return;
      const distinct = new Map<string, string>();
      for (const e of envelopes) distinct.set(e.executionId, "");
      await Promise.all(
        [...distinct.keys()].map(async (id) => distinct.set(id, await priorHashFor(id)))
      );
      const stamped = envelopes.map((e) => {
        const next = stamp(e, distinct.get(e.executionId) as string);
        distinct.set(e.executionId, (chainOf(next) as ChainMetadata).hash);
        return next;
      });
      await (inner.appendBatch as (es: readonly EventEnvelope[]) => Promise<void>)(stamped);
      for (const e of stamped) advance(e, (chainOf(e) as ChainMetadata).hash);
    },
    head: "forward",
    readRange: "forward",
    acquireFence: "forward",
    acquireFenceIf: "forward",
    // Chained onto the tail like `append`. The store proves the head is still what the caller
    // saw, so the tail hash derived here is the right one; a refusal drops the cached head (it
    // may be stale) and a success advances it, the same rule as `append`.
    appendIfUnchanged: async (
      executionId: string,
      event: EventEnvelope | null,
      expect?: TipObservation
    ): Promise<AppendIfUnchangedResult> => {
      const conditional = inner.appendIfUnchanged as NonNullable<EventStore["appendIfUnchanged"]>;
      if (event === null) return conditional.call(inner, executionId, null, expect);
      lastHash.delete(executionId); // never trust a cached tail across a conditional write
      const stamped = stamp(event, await priorHashFor(executionId));
      const result = await conditional.call(inner, executionId, stamped, expect);
      if (result.appended) advance(stamped, (chainOf(stamped) as ChainMetadata).hash);
      else lastHash.delete(executionId);
      return result;
    },
    storeNow: "forward",
    sealingCapability: "forward",
    readAtRest: "forward",
    copyPrefix: "forward",
    deleteExecution: async (executionId: string): Promise<void> => {
      lastHash.delete(executionId); // drop the cache entry with the log
      await (inner.deleteExecution as (id: string) => Promise<void>)(executionId);
    },
    // Compaction keeps sequence 0 and drops (0..through], so the first surviving event's
    // prevHash names an event that no longer exists and `verifyChain` reports a break
    // (pinned in hashChain.test.ts). Offering it would let a routine compaction pass make
    // every later audit fail; refusing it makes the chained log visibly non-compactable.
    truncatePrefix: { refuse: "a truncated prefix breaks chain verification (ADR 0037)" },
    truncatePrefixKeeping: { refuse: "a truncated prefix breaks chain verification (ADR 0037)" },
    listExecutions: "forward",
    listExecutionsPage: "forward",
  } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
  installOptional<EventStore, OptionalEventStoreMethod>(store, inner, plan);

  return store;
}
