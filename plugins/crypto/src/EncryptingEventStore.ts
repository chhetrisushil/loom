import type { EventEnvelope } from "@loom/core";
import {
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  installOptional,
} from "@loom/event-runtime";
import { decryptValue, encryptValue, hasEnvelope, mapPaths } from "./crypto";
import { PayloadShreddedError } from "./errors";
import type { KeyStore } from "./keystore";

export interface EncryptingEventStoreOptions {
  /**
   * Sensitive field paths per event type (dot-paths into the event PAYLOAD),
   * e.g. `{ STEP_COMPLETED: ["output.ssn", "output.email"] }`. Only these are
   * encrypted; unmarked events are stored verbatim (A4 — opt-in, zero overhead).
   */
  sensitive: Record<string, readonly string[]>;
  /**
   * The erasure SUBJECT for an execution (the key id). Default: the executionId
   * (per-execution keys). Return a shared subject to erase several executions —
   * and their forks — together (A2 fork lineage; see README).
   */
  subjectOf?: (envelope: Pick<EventEnvelope, "executionId" | "workflowId">) => string;
  /**
   * K10-R4 — what a read does when the subject's key has been DESTROYED (crypto-shredded):
   *  - `"throw"` (**default**): {@link PayloadShreddedError}. The authoritative fold MUST
   *    fail loudly, never silently diverge (G1) — the right default for replay/resume.
   *  - `"tolerate"`: replace each sensitive field with a `{ $shredded: true }` placeholder
   *    ({@link SHREDDED}) so OFF-log consumers — deploy-sim, eval, subject export — can
   *    process an erased log without crashing. NEVER use for the authoritative fold: the
   *    placeholder is not the original value, so a resume off it would diverge.
   */
  onShredded?: "throw" | "tolerate";
}

/** K10-R4 — the placeholder a tolerant read substitutes for an erased sensitive field. */
export const SHREDDED: { readonly $shredded: true } = { $shredded: true };

/** True for the {@link SHREDDED} placeholder a tolerant read leaves behind. */
export function isShredded(value: unknown): value is { $shredded: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $shredded?: unknown }).$shredded === true
  );
}

/**
 * K10.2 — wraps any {@link EventStore}, encrypting marked payload fields under a
 * per-subject key on append and decrypting them on read. Erasure is by key
 * destruction (see {@link shredSubject}); a read of an execution whose key was
 * destroyed throws {@link PayloadShreddedError} — replay fails loudly, never
 * silently diverges (the forbidden third behavior).
 *
 * Every optional store capability is carried through (a `DecoratorPlan`, ADR 0074
 * Amendment) so the wrapper composes with K9.4, fork(), coalescing, retention and compaction;
 * `copyPrefix` copies CIPHERTEXT verbatim, which is why a fork must share the parent's subject
 * to stay readable. Retention archives and compaction snapshots are the two places plaintext
 * could leave the encryption boundary, and `LogLifecycle` refuses both unless the destination
 * shares this store's {@link KeyStore} (ADR 0022 Amendment).
 */
/**
 * Own-key lookup for a caller-controlled event type. Plain indexing would resolve
 * `"__proto__"`/`"constructor"` up the prototype chain to a truthy non-config value, which then
 * flows into code expecting an array (or a function). An unrecognised event type must be a
 * no-op whatever it is named.
 */
function pathsFor(
  map: Record<string, readonly string[]>,
  eventType: string
): readonly string[] | undefined {
  return Object.hasOwn(map, eventType) ? map[eventType] : undefined;
}

export class EncryptingEventStore implements EventStore {
  private readonly sensitive: Record<string, readonly string[]>;
  private readonly subjectOf: (e: Pick<EventEnvelope, "executionId" | "workflowId">) => string;
  private readonly onShredded: "throw" | "tolerate";
  // Every optional capability is decided in the plan below (ADR 0074 Amendment), and each is
  // installed only when the inner store has it, so a capability probe (`if (store.copyPrefix)`)
  // behaves identically.
  readonly appendBatch?: NonNullable<EventStore["appendBatch"]>;
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;

  constructor(
    private readonly inner: EventStore,
    /**
     * PUBLIC so a pre-flight check can ask whether these keys outlive the process — see
     * `KeyStore.durable`. `loom doctor` looks for this property structurally, which is how it
     * checks an encrypting store without depending on @loom/plugin-crypto.
     */
    readonly keys: KeyStore,
    options: EncryptingEventStoreOptions
  ) {
    this.sensitive = options.sensitive;
    this.subjectOf = options.subjectOf ?? ((e) => e.executionId);
    this.onShredded = options.onShredded ?? "throw";
    const plan = {
      // One key lookup per DISTINCT subject in the batch, not one per envelope: a coalesced
      // batch is many executions, and `keys.getOrCreate` is a real lookup (a KMS or table).
      // `Promise.all` keeps array order, which is the SPI's per-execution order.
      appendBatch: async (envelopes) => {
        const keyFor = new Map<string, Promise<Buffer>>();
        const encrypted = await Promise.all(
          envelopes.map(async (envelope) => {
            const paths = pathsFor(this.sensitive, envelope.eventType);
            if (paths === undefined || paths.length === 0) return envelope; // unmarked (A4)
            const subject = this.subjectOf(envelope);
            let key = keyFor.get(subject);
            if (key === undefined) {
              key = this.keys.getOrCreate(subject);
              keyFor.set(subject, key);
            }
            return this.encrypt(envelope, paths, await key);
          })
        );
        return inner.appendBatch!(encrypted);
      },
      // A tip is a sequence number, never a payload — nothing to decrypt, and it stays
      // answerable after a shred (the rows are still there; only their contents are gone).
      head: "forward",
      readRange: (executionId, from, to) =>
        inner.readRange!(executionId, from, to).then((evs) => this.decryptAll(executionId, evs)),
      acquireFence: "forward",
      // copyPrefix copies CIPHERTEXT verbatim in the inner store — a fork must
      // resolve to the parent's subject (A2) for the copied prefix to stay readable.
      copyPrefix: "forward",
      // Deleting ciphertext only reduces data. Retention's ARCHIVE step is the hazard — it
      // copies what it read through this store, i.e. plaintext — and `LogLifecycle` refuses
      // an archive that does not share these keys (ADR 0022 Amendment, "unsafe-archive").
      deleteExecution: "forward",
      // Truncating ciphertext only reduces data too. Compaction's SNAPSHOT is the hazard —
      // the decrypted fold — and `LogLifecycle.compact` throws `UnsafeCompactionError` unless
      // the snapshot store shares these keys.
      truncatePrefix: "forward",
      truncatePrefixKeeping: "forward",
      // Enumeration is over executionIds only — no payload, so no decryption needed.
      listExecutions: "forward",
      listExecutionsPage: "forward",
    } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
    installOptional<EventStore, OptionalEventStoreMethod>(this, inner, plan);
  }

  private encrypt(envelope: EventEnvelope, paths: readonly string[], key: Buffer): EventEnvelope {
    return { ...envelope, payload: mapPaths(envelope.payload, paths, (v) => encryptValue(key, v)) };
  }

  async append(envelope: EventEnvelope): Promise<void> {
    const paths = pathsFor(this.sensitive, envelope.eventType);
    if (paths === undefined || paths.length === 0) {
      return this.inner.append(envelope); // unmarked → verbatim (A4)
    }
    const key = await this.keys.getOrCreate(this.subjectOf(envelope));
    return this.inner.append(this.encrypt(envelope, paths, key));
  }

  private async decryptAll(executionId: string, events: EventEnvelope[]): Promise<EventEnvelope[]> {
    // Single walk: compute the per-event envelope flag ONCE (was walked twice —
    // an all-events `.some()` fast-path check plus a second `hasEnvelope` inside
    // the map). Fast path: no marked event carries ciphertext → verbatim.
    const encrypted = events.map((e) => hasEnvelope(e.payload));
    if (!encrypted.some(Boolean)) return events;
    const subjectId = this.subjectOf({ executionId, workflowId: events[0]?.workflowId ?? "" });
    const key = await this.keys.get(subjectId);
    if (key === null) {
      // The key is gone — either never created (impossible if envelopes exist) or DESTROYED.
      // Default: fail loudly (K10.2) — the tombstone is already in the log. Tolerant mode
      // (K10-R4): hand OFF-log consumers a { $shredded } placeholder instead of throwing.
      if (this.onShredded === "throw") throw new PayloadShreddedError(subjectId, executionId);
      return events.map((e, i) => {
        const paths = pathsFor(this.sensitive, e.eventType);
        if (paths === undefined || !encrypted[i]) return e;
        return { ...e, payload: mapPaths(e.payload, paths, () => SHREDDED) };
      });
    }
    return events.map((e, i) => {
      const paths = pathsFor(this.sensitive, e.eventType);
      if (paths === undefined || !encrypted[i]) return e;
      return { ...e, payload: mapPaths(e.payload, paths, (v) => decryptValue(key, v)) };
    });
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    return this.decryptAll(executionId, await this.inner.read(executionId));
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return this.decryptAll(executionId, await this.inner.readFrom(executionId, fromSequence));
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    // Live subscribers get decrypted events too (best-effort: a subscription
    // delivering after a shred surfaces the raw envelope rather than throwing).
    return this.inner.subscribe(executionId, (event: EventEnvelope) => {
      const paths = pathsFor(this.sensitive, event.eventType);
      if (paths === undefined || !hasEnvelope(event.payload)) {
        handler(event);
        return;
      }
      // Nothing awaits this — it is driven by the inner store's subscribe callback — so an
      // escaping rejection is UNHANDLED and terminates the process by default. `keys.get`
      // is a real lookup (a KMS or table, not memory) and `decryptValue` throws on a
      // ciphertext it cannot open, so both are reachable on an ordinary bad day.
      //
      // Degrading to the RAW envelope is what the comment above already promises for a
      // shredded subject, and what the sibling `ContentResolvingEventStore` does for a
      // failed blob fetch: deliver the event with its sensitive fields still enveloped
      // rather than drop the subscriber — or the node.
      void this.keys
        .get(this.subjectOf(event))
        .then((key) => {
          handler(
            key === null
              ? event
              : { ...event, payload: mapPaths(event.payload, paths, (v) => decryptValue(key, v)) }
          );
        })
        .catch(() => handler(event));
    });
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
