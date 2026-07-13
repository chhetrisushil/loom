import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { ContentStore } from "./ContentStore";
import {
  type ContentRef,
  decodeValue,
  encodeValue,
  hasContentRef,
  isContentRef,
  mapPathsAsync,
} from "./content";
import { ContentMissingError } from "./errors";

export interface ContentResolvingEventStoreOptions {
  /**
   * Payload dot-paths to externalize per event type, e.g. `{ STEP_COMPLETED: ["output.doc"] }`.
   * On append those fields are moved to the content store and replaced by a {@link ContentRef};
   * on read they are resolved back. Unmarked events are stored verbatim (zero overhead, G2).
   */
  externalize: Record<string, readonly string[]>;
}

/**
 * ADR 0046 — wraps any {@link EventStore} so marked payload fields are stored in a
 * {@link ContentStore} (as content-addressed refs) instead of inline in the log. Reads resolve
 * refs back transparently, so the fold, resume, and every consumer above the store layer see
 * plain values — the authoritative log holds only references + structure.
 *
 * Mirrors `EncryptingEventStore`: a store decorator, optional capabilities forwarded so it
 * composes with fork/fencing. `copyPrefix` copies refs verbatim — because refs are
 * content-addressed, a fork *shares* the parent's blobs for free (natural dedup), with no
 * re-wrap needed. A read of an execution whose externalized bytes were erased throws
 * {@link ContentMissingError} — replay fails loudly, never silently diverges (G1).
 *
 * **Reclamation caveat (v1):** `deleteExecution`/`truncatePrefix` remove the log's events but
 * do NOT delete the referenced blobs — refcounted blob GC (forks share content) is a separate
 * step, deferred per ADR 0046's risks. Erase content explicitly via `contentStore.delete(ref)`.
 */
export class ContentResolvingEventStore implements EventStore {
  private readonly externalize: Record<string, readonly string[]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly content: ContentStore,
    options: ContentResolvingEventStoreOptions
  ) {
    this.externalize = options.externalize;
    if (inner.readRange !== undefined) {
      this.readRange = (executionId, from, to) =>
        inner.readRange!(executionId, from, to).then((evs) => this.resolveAll(executionId, evs));
    }
    if (inner.acquireFence !== undefined) {
      this.acquireFence = (executionId) => inner.acquireFence!(executionId);
    }
    // Refs are content-addressed: copying them verbatim makes the fork share the parent's
    // blobs (dedup for free) — no decrypt/re-wrap step (contrast the crypto plugin's keys).
    if (inner.copyPrefix !== undefined) {
      this.copyPrefix = (from, to, through, metadata) =>
        inner.copyPrefix!(from, to, through, metadata);
    }
    // Forwarded so a content-wrapped store keeps its retention/compaction capabilities. These
    // reclaim EVENTS only; blob reclamation is separate (see the class note).
    if (inner.deleteExecution !== undefined) {
      this.deleteExecution = (executionId) => inner.deleteExecution!(executionId);
    }
    if (inner.truncatePrefix !== undefined) {
      this.truncatePrefix = (executionId, through) => inner.truncatePrefix!(executionId, through);
    }
    // Enumeration is over executionIds only — no payload, so no resolution needed.
    if (inner.listExecutions !== undefined) {
      this.listExecutions = () => inner.listExecutions!();
    }
  }

  async append(envelope: EventEnvelope): Promise<void> {
    const paths = this.externalize[envelope.eventType];
    if (paths === undefined || paths.length === 0) {
      return this.inner.append(envelope); // unmarked → verbatim (G2)
    }
    const payload = await mapPathsAsync(envelope.payload, paths, (v) => this.externalizeValue(v));
    return this.inner.append({ ...envelope, payload });
  }

  private async externalizeValue(value: unknown): Promise<ContentRef> {
    const ref = await this.content.put(encodeValue(value));
    return { ...ref, codec: "json" };
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    return this.resolveAll(executionId, await this.inner.read(executionId));
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return this.resolveAll(executionId, await this.inner.readFrom(executionId, fromSequence));
  }

  private async resolveAll(executionId: string, events: EventEnvelope[]): Promise<EventEnvelope[]> {
    // Single walk: compute the per-event ref flag ONCE (`hasContentRef` is a full deep walk of
    // the payload; it was run twice — the `.some()` fast-path plus a second call inside the
    // `.map()`). Fast path: no event carries a ref → verbatim, no allocation.
    const refBearing = events.map((e) => hasContentRef(e.payload));
    if (!refBearing.some(Boolean)) return events;
    return Promise.all(
      events.map(async (e, i) =>
        refBearing[i] ? { ...e, payload: await this.resolveRefs(e.payload, executionId) } : e
      )
    );
  }

  private async resolveRefs(value: unknown, executionId: string): Promise<unknown> {
    if (isContentRef(value)) {
      const bytes = await this.content.get(value);
      if (bytes === null) throw new ContentMissingError(value.__loomContent, executionId);
      return decodeValue(bytes);
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => this.resolveRefs(v, executionId)));
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await this.resolveRefs(v, executionId);
      }
      return out;
    }
    return value;
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    // Live subscribers get resolved events too (best-effort: if resolution fails — e.g. a race
    // with erasure — the raw ref-bearing event is delivered rather than dropping it).
    return this.inner.subscribe(executionId, (event: EventEnvelope) => {
      if (!hasContentRef(event.payload)) {
        handler(event);
        return;
      }
      void this.resolveRefs(event.payload, executionId)
        .then((payload) => handler({ ...event, payload }))
        .catch(() => handler(event));
    });
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
