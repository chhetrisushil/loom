import type { EventEnvelope } from "@loom/core";
import {
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  installOptional,
  readRangeOf,
} from "@loom/event-runtime";
import type { ContentStore } from "./ContentStore";
import {
  type ContentRef,
  collectContentRefs,
  encodeValue,
  hasContentRef,
  mapPathsAsync,
  substituteContentRefs,
} from "./content";
import { ContentMissingError } from "./errors";
import { type TouchErrorHook, touchAround } from "./touchAround";

export interface ContentResolvingEventStoreOptions {
  /**
   * Payload dot-paths to externalize per event type, e.g. `{ STEP_COMPLETED: ["output.doc"] }`.
   * On append those fields are moved to the content store and replaced by a {@link ContentRef};
   * on read they are resolved back. Unmarked events are stored verbatim (zero overhead, G2).
   */
  externalize: Record<string, readonly string[]>;
  /**
   * Observer for the SPI 1.4.0 `touch` this store makes around ref-carrying writes (ADR 0055 D6
   * amendment 2): called when the touch AFTER a durable write threw (swallowed otherwise, since the
   * write already landed), and when either touch reports a cited bare ref MISSING (the write cites
   * a blob that is already gone). A failure of the touch BEFORE the write still rejects the write.
   * Wire it to your logger or metrics. See {@link TouchErrorHook}.
   */
  onTouchError?: TouchErrorHook;
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
 * **Composing with `@loom/plugin-audit-chain`:** wrap this store INSIDE the hash chain —
 * `hashChainedEventStore(new ContentResolvingEventStore(...))`. Chained the other way round
 * the chain hashes only the ref string, so a rewritten blob verifies clean. See
 * `hashChainedEventStore`'s note and `contentOrdering.test.ts`.
 *
 * **Claim-check envelopes are left alone.** An ADR 0054 envelope (`__loomClaimCheck`) is read
 * back verbatim — its `ref` is resolved only by the claim-check plugin, it may be reclaimed on a
 * TTL (ADR 0055 D4), and its bytes need not be JSON. A bare ref beside it still resolves.
 *
 * **Reclamation:** `deleteExecution`/`truncatePrefix` remove the log's events but do NOT
 * delete the referenced blobs — forks share content, so a blob outlives any one log. Blobs are
 * reclaimed by the separate mark-and-sweep `sweepUnpinnedContent` (ADR 0055, which closed the
 * ADR 0046 "refcounted blob GC" follow-up); erase one explicitly via `contentStore.delete(ref)`.
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

export class ContentResolvingEventStore implements EventStore {
  private readonly externalize: Record<string, readonly string[]>;
  private readonly onTouchError: TouchErrorHook | undefined;
  readonly appendBatch?: NonNullable<EventStore["appendBatch"]>;
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
  readonly storeNow?: NonNullable<EventStore["storeNow"]>;
  readonly sealingCapability?: NonNullable<EventStore["sealingCapability"]>;
  readonly readAtRest?: NonNullable<EventStore["readAtRest"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly deleteThrough?: NonNullable<EventStore["deleteThrough"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;

  constructor(
    private readonly inner: EventStore,
    private readonly content: ContentStore,
    options: ContentResolvingEventStoreOptions
  ) {
    this.externalize = options.externalize;
    this.onTouchError = options.onTouchError;
    // Every optional method decided over the whole union (ADR 0074 Amendment), each
    // installed only when the inner store has it.
    const plan = {
      // Externalize every envelope concurrently, then ONE round-trip. Puts are
      // content-addressed and idempotent, so a blob orphaned by a failed batch is exactly
      // what a failed `append` orphans today (and the sweep reclaims it). `Promise.all`
      // keeps array order, the SPI's per-execution order.
      appendBatch: async (envelopes) =>
        this.touching(
          envelopes.map((e) => e.payload),
          { operation: "appendBatch", executionId: envelopes[0]?.executionId },
          async () =>
            inner.appendBatch!(await Promise.all(envelopes.map((e) => this.externalizeEnvelope(e))))
        ),
      // A tip is a sequence number — no payload to resolve, so it forwards unchanged.
      head: "forward",
      readRange: (executionId, from, to) =>
        inner.readRange!(executionId, from, to).then((evs) => this.resolveAll(executionId, evs)),
      acquireFence: "forward",
      acquireFenceIf: "forward",
      // The blob is written BEFORE the store can say no, and a content-addressed blob may be
      // shared with other events (so deleting it on a refusal could break them). So the
      // externalisation happens only after a lock-free observation says the condition still
      // holds: a late write that already lost (the common case) stores no blob at all. What is
      // left is the window between the observation and the write, whose orphan is reclaimed by
      // `sweepUnpinnedContent` exactly like a plain `append` that failed after its `put`.
      appendIfUnchanged: async (executionId, event, expect) => {
        if (event === null) return inner.appendIfUnchanged!(executionId, null, expect);
        const paths = pathsFor(this.externalize, event.eventType);
        if (paths !== undefined && paths.length > 0 && expect !== undefined) {
          const now = await inner.appendIfUnchanged!(executionId, null);
          if (
            !now.appended &&
            (now.reason === "gone" ||
              now.head !== expect.head ||
              now.fence !== expect.fence ||
              now.anchor !== expect.anchor ||
              event.sequence !== expect.head + 1)
          ) {
            return now.reason === "gone"
              ? now
              : {
                  appended: false,
                  reason: "moved",
                  head: now.head,
                  fence: now.fence,
                  anchor: now.anchor,
                };
          }
        }
        return this.touching(
          [event.payload],
          { operation: "appendIfUnchanged", executionId },
          async () =>
            inner.appendIfUnchanged!(executionId, await this.externalizeEnvelope(event), expect)
        );
      },
      storeNow: "forward", // a clock reading: no envelope to externalise
      sealingCapability: "forward", // externalising refs seals nothing
      readAtRest: "forward",
      // Refs are content-addressed: copying them verbatim makes the fork share the parent's
      // blobs (dedup for free) — no decrypt/re-wrap step (contrast the crypto plugin's keys).
      // But a verbatim copy is a citation with NO `put`, invisible to the orphan sweep's
      // conditional delete, so over a store with SPI 1.4.0 `touch` the copied range's refs are
      // touched around the copy (ADR 0055 D6 amendment 2). The range is read raw (unresolved).
      copyPrefix:
        content.touch === undefined
          ? "forward"
          : async (fromExecutionId, toExecutionId, throughSequence, metadata) => {
              const copied = await readRangeOf(inner, fromExecutionId, 0, throughSequence);
              return this.touching(
                copied.map((e) => e.payload),
                { operation: "copyPrefix", executionId: toExecutionId },
                () => inner.copyPrefix!(fromExecutionId, toExecutionId, throughSequence, metadata)
              );
            },
      // Forwarded so a content-wrapped store keeps its retention/compaction capabilities.
      // These reclaim EVENTS only; blob reclamation is separate (see the class note).
      deleteExecution: "forward",
      deleteThrough: "forward",
      truncatePrefix: "forward",
      truncatePrefixKeeping: "forward",
      // Enumeration is over executionIds only — no payload, so no resolution needed.
      listExecutions: "forward",
      listExecutionsPage: "forward",
    } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
    installOptional<EventStore, OptionalEventStoreMethod>(this, inner, plan);
  }

  private async externalizeEnvelope(envelope: EventEnvelope): Promise<EventEnvelope> {
    const paths = pathsFor(this.externalize, envelope.eventType);
    if (paths === undefined || paths.length === 0) return envelope; // unmarked → verbatim (G2)
    const payload = await mapPathsAsync(envelope.payload, paths, (v) => this.externalizeValue(v));
    return { ...envelope, payload };
  }

  async append(envelope: EventEnvelope): Promise<void> {
    return this.touching(
      [envelope.payload],
      { operation: "append", executionId: envelope.executionId },
      async () => this.inner.append(await this.externalizeEnvelope(envelope))
    );
  }

  /**
   * SPI 1.4.0 (ADR 0055 D6 amendment 2) — a ref that reaches a log WITHOUT a `put` (one an
   * incoming payload already carries: a recalled memory value, a `scriptRef`, a ref handed
   * between steps) is a citation the orphan sweep's conditional delete cannot see. So, when the
   * content store can `touch`, the payloads' cited addresses are touched BEFORE the write (a
   * failure aborts it, nothing landed) and again AFTER it (best-effort and reported through
   * `onTouchError`: the write is durable, so its outcome must not be turned into a failure).
   * The guarantee is D5's: the BEFORE touch protects a write whose touch-to-commit window is
   * shorter than the sweep's margin (`touchClock() - cutoff`, which an erasing orphan pass
   * requires to be at least 60 s); the AFTER touch only extends that for a slower write. See
   * {@link touchAround}. Refs externalized by THIS write are not in the INPUT payloads (their
   * `put` is the touch). Cost: with no `touch` on the store, nothing (the closure is the
   * write); otherwise one iterative cycle-safe walk of the input payload (no recursion; the same
   * walker the sweep's mark phase uses), and a round trip only when a ref was found.
   */
  private touching<T>(
    payloads: readonly unknown[],
    ctx: Parameters<typeof touchAround>[2],
    write: () => Promise<T>
  ): Promise<T> {
    return touchAround(this.content, payloads, ctx, this.onTouchError, write);
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

  // ADR 0062 — batch-scoped two-phase resolution. Phase 1 collects DISTINCT refs
  // across the WHOLE read batch (one walk, dedupe by content address); the fetch
  // is ONE `getMany` round-trip when the store supports it (coalesced parallel
  // `get`s otherwise — still strictly better than the old per-ref sequential
  // awaits); phase 2 is a pure synchronous substitute pass. O(payload nodes) +
  // one round-trip replaces O(refs) serialized round-trips. Fast path: no event
  // carries a ref → verbatim, no allocation.
  private async resolveAll(executionId: string, events: EventEnvelope[]): Promise<EventEnvelope[]> {
    const distinct = new Map<string, ContentRef>();
    const refBearing = events.map((e) => collectContentRefs(e.payload, distinct));
    if (distinct.size === 0) return events;
    const bytesByAddress = await this.fetchBytes(distinct, executionId);
    return events.map((e, i) =>
      refBearing[i] ? { ...e, payload: substituteContentRefs(e.payload, bytesByAddress) } : e
    );
  }

  /** Fetch all distinct refs; loudness contract unchanged (missing ⇒ ContentMissingError, G1). */
  private async fetchBytes(
    distinct: ReadonlyMap<string, ContentRef>,
    executionId: string
  ): Promise<Map<string, Uint8Array>> {
    // Single pass over the map (audit nit): addresses and refs stay index-aligned.
    const addresses = new Array<string>(distinct.size);
    const refs = new Array<ContentRef>(distinct.size);
    let n = 0;
    for (const [address, ref] of distinct) {
      addresses[n] = address;
      refs[n] = ref;
      n++;
    }
    const fetched =
      this.content.getMany !== undefined
        ? await this.content.getMany(refs)
        : await Promise.all(refs.map((r) => this.content.get(r)));
    const out = new Map<string, Uint8Array>();
    for (let i = 0; i < addresses.length; i++) {
      const bytes = fetched[i];
      if (bytes === null || bytes === undefined) {
        throw new ContentMissingError(addresses[i] as string, executionId);
      }
      out.set(addresses[i] as string, bytes);
    }
    return out;
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    // Live subscribers get resolved events too (best-effort: if resolution fails — e.g. a race
    // with erasure — the raw ref-bearing event is delivered rather than dropping it).
    // Audit PERF-A1 — the ref-free common case (heartbeats, STEP_STARTED, decisions)
    // pays the zero-allocation `hasContentRef` walk only; the Map is allocated
    // exclusively for ref-bearing events.
    return this.inner.subscribe(executionId, (event: EventEnvelope) => {
      if (!hasContentRef(event.payload)) {
        handler(event);
        return;
      }
      const distinct = new Map<string, ContentRef>();
      collectContentRefs(event.payload, distinct);
      void this.fetchBytes(distinct, executionId)
        .then((bytes) =>
          handler({ ...event, payload: substituteContentRefs(event.payload, bytes) })
        )
        .catch(() => handler(event));
    });
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
