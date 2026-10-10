import type { EventEnvelope } from "@loom/core";
import {
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  inboxChainOf,
  installOptional,
} from "@loom/event-runtime";
import { decryptValue, encryptValue, hasEnvelope, mapPaths } from "./crypto";
import { PayloadShreddedError, PayloadUndecryptableError } from "./errors";
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
   * and their forks — together (A2 fork lineage; see README). A chain's inbox stream
   * (`__loom_inbox__:<chainId>`, ADR 0110) is resolved by calling this with the CHAIN id, i.e. the
   * subject of the chain's generation-0 execution, so an in-flight payload is erased with its owner.
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

const OWNER_WORKFLOW_CACHE = 1024;

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
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
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
    // Copied, never aliased: `registerSensitive` adds paths and must not mutate the caller's map.
    this.sensitive = { ...options.sensitive };
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
            const subject = await this.subjectFor(envelope);
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
      acquireFenceIf: "forward",
      // The event is encrypted exactly as `append` would; an observation (null) has no payload.
      appendIfUnchanged: async (executionId, event, expect) => {
        if (event === null) return inner.appendIfUnchanged!(executionId, null, expect);
        const paths = pathsFor(this.sensitive, event.eventType);
        const sealed =
          paths === undefined || paths.length === 0
            ? event
            : this.encrypt(event, paths, await this.keys.getOrCreate(await this.subjectFor(event)));
        return inner.appendIfUnchanged!(executionId, sealed, expect);
      },
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

  /**
   * R3k (ADR 0111 D1) — add sensitive dot-paths for an event type AFTER construction (union with
   * any already declared). `defineConfig` calls this to register `principal.identity.*` on
   * `EXECUTION_STARTED` when crypto is composed, so the identity subset is encrypted at rest and
   * shredded with the subject. Must run before the first matching append: a path registered later
   * leaves earlier events as they were written.
   */
  registerSensitive(eventType: string, paths: readonly string[]): void {
    const existing = pathsFor(this.sensitive, eventType) ?? [];
    this.sensitive[eventType] = [...new Set([...existing, ...paths])];
  }

  /** Chain id -> its owner's workflow id (bounded; only hits are cached). */
  private readonly ownerWorkflow = new Map<string, string>();

  /**
   * The workflow id of a chain's OWNER (its generation-0 execution), read from the owner's first
   * event (the envelope's `workflowId` is plaintext). `""` when it cannot be resolved (no ranged
   * read on the inner store, or the owner has no log yet): a `subjectOf` that keys on the workflow
   * must then fall back on the execution id, which is the chain id.
   */
  private async ownerWorkflowId(chainId: string): Promise<string> {
    const cached = this.ownerWorkflow.get(chainId);
    if (cached !== undefined) return cached;
    if (this.inner.readRange === undefined) return "";
    try {
      const first = (await this.inner.readRange(chainId, 0, 0))[0];
      const wf = first?.workflowId;
      if (typeof wf !== "string" || wf.length === 0) return "";
      if (this.ownerWorkflow.size >= OWNER_WORKFLOW_CACHE) {
        // Oldest entry out (Map preserves insertion order): O(1), bounded.
        const oldest = this.ownerWorkflow.keys().next().value;
        if (oldest !== undefined) this.ownerWorkflow.delete(oldest);
      }
      this.ownerWorkflow.set(chainId, wf);
      return wf;
    } catch {
      return "";
    }
  }

  /**
   * The erasure subject an envelope's sensitive fields are sealed under. A chain's inbox stream
   * (`__loom_inbox__:<chainId>`, ADR 0110) is not an execution anyone's `subjectOf` knows, so it
   * resolves to the subject of its OWNER: `subjectOf` is asked about the chain's id, which is its
   * generation-0 execution (or a fork's fresh one), with the OWNER's workflow id (never the
   * stream's reserved `__loom_inbox__`; `""` if it cannot be resolved). In-flight payloads are then
   * sealed under, and shredded with, the same key as the owner's own log. Any other stream is
   * unchanged.
   */
  private async subjectFor(e: Pick<EventEnvelope, "executionId" | "workflowId">): Promise<string> {
    const chain = inboxChainOf(e.executionId);
    if (chain === undefined) return this.subjectOf(e);
    return this.subjectOf({ executionId: chain, workflowId: await this.ownerWorkflowId(chain) });
  }

  private encrypt(envelope: EventEnvelope, paths: readonly string[], key: Buffer): EventEnvelope {
    return { ...envelope, payload: mapPaths(envelope.payload, paths, (v) => encryptValue(key, v)) };
  }

  async append(envelope: EventEnvelope): Promise<void> {
    const paths = pathsFor(this.sensitive, envelope.eventType);
    if (paths === undefined || paths.length === 0) {
      return this.inner.append(envelope); // unmarked → verbatim (A4)
    }
    const key = await this.keys.getOrCreate(await this.subjectFor(envelope));
    return this.inner.append(this.encrypt(envelope, paths, key));
  }

  private async decryptAll(executionId: string, events: EventEnvelope[]): Promise<EventEnvelope[]> {
    // Single walk: compute the per-event envelope flag ONCE (was walked twice —
    // an all-events `.some()` fast-path check plus a second `hasEnvelope` inside
    // the map). Fast path: no marked event carries ciphertext → verbatim.
    const encrypted = events.map((e) => hasEnvelope(e.payload));
    if (!encrypted.some(Boolean)) return events;
    const subjectId = await this.subjectFor({
      executionId,
      workflowId: events[0]?.workflowId ?? "",
    });
    const key = await this.keys.get(subjectId);
    // ADR 0110 — a chain's inbox stream is NEVER read loudly. Its readers are senders (backlog
    // scan), the trim and the consumer, none of which is an authoritative fold: a destroyed key
    // must not break `send` for the whole chain, and a payload nobody can open must reach a
    // consumer as the {@link SHREDDED} marker, never as ciphertext and never as the raw value.
    const inbox = inboxChainOf(executionId) !== undefined;
    if (key === null) {
      // The key is gone — either never created (impossible if envelopes exist) or DESTROYED.
      // Default: fail loudly (K10.2) — the tombstone is already in the log. Tolerant mode
      // (K10-R4): hand OFF-log consumers a { $shredded } placeholder instead of throwing.
      if (this.onShredded === "throw" && !inbox)
        throw new PayloadShreddedError(subjectId, executionId);
      return events.map((e, i) => {
        const paths = pathsFor(this.sensitive, e.eventType);
        if (paths === undefined || !encrypted[i]) return e;
        return { ...e, payload: mapPaths(e.payload, paths, () => SHREDDED) };
      });
    }
    return events.map((e, i) => {
      const paths = pathsFor(this.sensitive, e.eventType);
      if (paths === undefined || !encrypted[i]) return e;
      return {
        ...e,
        payload: mapPaths(e.payload, paths, (v) => {
          if (!inbox) return decryptValue(key, v);
          // Only a DESTROYED key (above) reads as erased. A key that exists but cannot open the
          // ciphertext is corruption, a tampered row or a `subjectOf` that drifted: that must
          // not look like an erasure, so it is a typed error (a KeyStore must never re-mint a
          // destroyed subject's key, see `KeyStore.destroy`).
          try {
            return decryptValue(key, v);
          } catch (cause) {
            throw new PayloadUndecryptableError(subjectId, executionId, cause);
          }
        }),
      };
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
      //
      // A chain's inbox stream is redacted to the {@link SHREDDED} marker once its key is gone,
      // as a read of it is: a subscriber is not an authoritative fold, and ciphertext handed to it
      // is neither the value nor a signal of erasure.
      const inbox = inboxChainOf(event.executionId) !== undefined;
      void this.subjectFor(event)
        .then((subject) => this.keys.get(subject))
        .then((key) => {
          if (key === null) {
            handler(
              inbox ? { ...event, payload: mapPaths(event.payload, paths, () => SHREDDED) } : event
            );
            return;
          }
          handler({
            ...event,
            payload: mapPaths(event.payload, paths, (v) => decryptValue(key, v)),
          });
        })
        .catch(() => handler(event));
    });
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
