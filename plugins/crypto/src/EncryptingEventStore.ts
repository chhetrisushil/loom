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
 * Optional store capabilities (fencing, readRange, copyPrefix) are forwarded so
 * the wrapper composes with K9.4 and fork(); `copyPrefix` copies CIPHERTEXT
 * verbatim, which is why a fork must share the parent's subject to stay readable.
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
  // K9.4/fork/perf capabilities are forwarded only when the inner store has them,
  // so a capability probe (`if (store.copyPrefix)`) behaves identically.
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly keys: KeyStore,
    options: EncryptingEventStoreOptions
  ) {
    this.sensitive = options.sensitive;
    this.subjectOf = options.subjectOf ?? ((e) => e.executionId);
    this.onShredded = options.onShredded ?? "throw";
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
    // Enumeration is over executionIds only — no payload, so no decryption needed.
    if (inner.listExecutions !== undefined) {
      this.listExecutions = () => inner.listExecutions!();
    }
  }

  async append(envelope: EventEnvelope): Promise<void> {
    const paths = pathsFor(this.sensitive, envelope.eventType);
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
