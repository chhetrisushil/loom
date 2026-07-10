import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
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
}

/**
 * K10.2 — wraps any {@link EventStore}, encrypting marked payload fields under a
 * per-subject key on append and decrypting them on read. Erasure is by key
 * destruction (see {@link shredSubject}); a read of an execution whose key was
 * destroyed throws {@link PayloadShreddedError} — replay fails loudly, never
 * silently diverges (the forbidden third behavior).
 *
 * Optional store capabilities (fencing, readRange, copyPrefix) are forwarded so
 * the wrapper composes with K9.4 and fork(); `copyPrefix` copies CIPHERTEXT
 * verbatim, which is why a fork must share the parent's subject to stay readable.
 */
export class EncryptingEventStore implements EventStore {
  private readonly sensitive: Record<string, readonly string[]>;
  private readonly subjectOf: (e: Pick<EventEnvelope, "executionId" | "workflowId">) => string;
  // K9.4/fork/perf capabilities are forwarded only when the inner store has them,
  // so a capability probe (`if (store.copyPrefix)`) behaves identically.
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly keys: KeyStore,
    options: EncryptingEventStoreOptions
  ) {
    this.sensitive = options.sensitive;
    this.subjectOf = options.subjectOf ?? ((e) => e.executionId);
    if (inner.readRange !== undefined) {
      this.readRange = (executionId, from, to) =>
        inner.readRange!(executionId, from, to).then((evs) => this.decryptAll(executionId, evs));
    }
    if (inner.acquireFence !== undefined) {
      this.acquireFence = (executionId) => inner.acquireFence!(executionId);
    }
    // copyPrefix copies CIPHERTEXT verbatim in the inner store — a fork must
    // resolve to the parent's subject (A2) for the copied prefix to stay readable.
    if (inner.copyPrefix !== undefined) {
      this.copyPrefix = (from, to, through, metadata) =>
        inner.copyPrefix!(from, to, through, metadata);
    }
  }

  async append(envelope: EventEnvelope): Promise<void> {
    const paths = this.sensitive[envelope.eventType];
    if (paths === undefined || paths.length === 0) {
      return this.inner.append(envelope); // unmarked → verbatim (A4)
    }
    const key = await this.keys.getOrCreate(this.subjectOf(envelope));
    const payload = mapPaths(envelope.payload, paths, (v) => encryptValue(key, v));
    return this.inner.append({ ...envelope, payload });
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
      // The key is gone — either never created (impossible if envelopes exist)
      // or DESTROYED. Fail loudly (K10.2): the tombstone is already in the log.
      throw new PayloadShreddedError(subjectId, executionId);
    }
    return events.map((e, i) => {
      const paths = this.sensitive[e.eventType];
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
      const paths = this.sensitive[event.eventType];
      if (paths === undefined || !hasEnvelope(event.payload)) {
        handler(event);
        return;
      }
      void this.keys.get(this.subjectOf(event)).then((key) => {
        handler(
          key === null
            ? event
            : { ...event, payload: mapPaths(event.payload, paths, (v) => decryptValue(key, v)) }
        );
      });
    });
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
