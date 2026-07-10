import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";

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
}

export interface ChainVerification {
  ok: boolean;
  /** Number of events checked. */
  length: number;
  /** The sequence at which the chain first broke (absent when ok). */
  brokenAt?: number;
  /** Why it broke — a short, specific reason (absent when ok). */
  reason?: string;
}

export interface HashChainOptions {
  /** If set, each event is also HMAC-signed, so a re-chaining tamper is still detectable. */
  hmacSecret?: string;
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

function hashEvent(prevHash: string, e: EventEnvelope): string {
  return createHash("sha256")
    .update(`${prevHash}\n${chainablePayload(e)}`)
    .digest("hex");
}

function signHash(secret: string, hash: string): string {
  return createHmac("sha256", secret).update(hash).digest("hex");
}

function hmacMatches(secret: string, hash: string, sig: string): boolean {
  const expected = Buffer.from(signHash(secret, hash), "hex");
  const actual = Buffer.from(sig, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const chainOf = (e: EventEnvelope): ChainMetadata | undefined =>
  (e.metadata as { auditChain?: ChainMetadata } | undefined)?.auditChain;

/** Wrap a store so every append is hash-chained (and optionally HMAC-signed). */
export function hashChainedEventStore(
  inner: EventStore,
  options: HashChainOptions = {}
): HashChainedEventStore {
  const secret = options.hmacSecret;
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
      const prevHash = await priorHashFor(envelope.executionId);
      const hash = hashEvent(prevHash, envelope);
      const chain: ChainMetadata = secret
        ? { prevHash, hash, sig: signHash(secret, hash) }
        : { prevHash, hash };
      const stamped: EventEnvelope = {
        ...envelope,
        metadata: { ...envelope.metadata, auditChain: chain },
      };
      await inner.append(stamped);
      // Only advance the chain head after a durable append succeeds — a rejected
      // append (e.g. stale fence) must not poison the next event's prevHash.
      lastHash.set(envelope.executionId, hash);
    },
    read: (executionId) => inner.read(executionId),
    readFrom: (executionId, fromSequence) => inner.readFrom(executionId, fromSequence),
    subscribe: (executionId, handler) => inner.subscribe(executionId, handler),
    close: () => inner.close(),
    async verifyChain(executionId: string): Promise<ChainVerification> {
      const events = await inner.read(executionId);
      let prev = GENESIS;
      for (const e of events) {
        const chain = chainOf(e);
        if (chain === undefined) {
          return {
            ok: false,
            length: events.length,
            brokenAt: e.sequence,
            reason: "missing chain metadata",
          };
        }
        if (chain.prevHash !== prev) {
          return {
            ok: false,
            length: events.length,
            brokenAt: e.sequence,
            reason: "prevHash mismatch (event dropped or reordered)",
          };
        }
        const expected = hashEvent(prev, e);
        if (expected !== chain.hash) {
          return {
            ok: false,
            length: events.length,
            brokenAt: e.sequence,
            reason: "hash mismatch (event tampered)",
          };
        }
        if (secret !== undefined) {
          if (chain.sig === undefined || !hmacMatches(secret, chain.hash, chain.sig)) {
            return {
              ok: false,
              length: events.length,
              brokenAt: e.sequence,
              reason: "signature invalid (forged or unsigned)",
            };
          }
        }
        prev = chain.hash;
      }
      return { ok: true, length: events.length };
    },
    ...(inner.readRange !== undefined && { readRange: inner.readRange.bind(inner) }),
    ...(inner.acquireFence !== undefined && { acquireFence: inner.acquireFence.bind(inner) }),
    ...(inner.copyPrefix !== undefined && { copyPrefix: inner.copyPrefix.bind(inner) }),
    ...(inner.deleteExecution !== undefined && {
      deleteExecution: inner.deleteExecution.bind(inner),
    }),
    ...(inner.truncatePrefix !== undefined && { truncatePrefix: inner.truncatePrefix.bind(inner) }),
  };

  return store;
}
