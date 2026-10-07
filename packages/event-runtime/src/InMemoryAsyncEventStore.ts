import type { EventEnvelope } from "@loom/core";
import { SubscriberRegistry } from "./SubscriberRegistry";
import { creationMarker } from "./creationMarker";
import { isAnsweringKind } from "./eventKindClass";
import { compareExecutionIds } from "./executionIdOrder";
import { StaleFenceError, fenceOf } from "./fencing";
import { lowerBoundBySequence, sliceBySequence } from "./sequenceRange";
import type {
  AcquireFenceIfResult,
  AppendIfUnchangedResult,
  EventStore,
  TipObservation,
} from "./types";
import { DuplicateEnvelopeIdError, DuplicateSequenceError } from "./writeConflicts";

export interface InMemoryAsyncEventStoreOptions {
  /** Artificial per-operation delay (ms) to model network latency. Default 0. */
  latencyMs?: number;
  /**
   * If provided and it returns true for an envelope, `append` rejects with the
   * given/derived error instead of storing it — for exercising the durable-write
   * failure path. Default: never fails.
   */
  failAppendWhen?: (envelope: EventEnvelope) => boolean | string | Error;
}

/**
 * Reference **async** EventStore: a genuine Promise-returning backend (unlike the
 * synchronous SQLite/in-memory stores, which merely satisfy the async interface).
 * Use it as a starting point for a real network backend, or in tests to exercise
 * the runtime's async write pipeline, ordering, and failure handling.
 */
export class InMemoryAsyncEventStore implements EventStore {
  private readonly log = new Map<string, EventEnvelope[]>();
  /**
   * The executionIds in SPI order (code point), built lazily by `listExecutionsPage` and
   * dropped only when the SET of executions changes (a new one, or a delete). A full paged
   * walk is then one O(n log n) sort plus O(log n) per page, not a re-sort per page.
   */
  private sortedIds: string[] | undefined;
  /**
   * #309 — every envelope id in the store, the index behind the `id` PRIMARY KEY both SQL
   * backends have. GLOBAL, not per-execution, because that is what the SQL constraint is:
   * two executions may not share an envelope id either.
   *
   * It has to be maintained everywhere the log changes, not just on append — a stale entry
   * after a delete would refuse a legitimate re-append forever, and an un-removed one is a
   * leak in a store whose whole job is to be re-created cheaply in tests. The removal side
   * is only correct BECAUSE the invariant holds: an id belongs to exactly one envelope, so
   * dropping the ids of the events being dropped cannot orphan someone else's claim.
   *
   * Costs one hash-table slot per event; the id strings themselves are already retained by
   * the envelopes in `log`, so this is not a second copy of the data.
   */
  private readonly ids = new Set<string>();
  private readonly subscribers = new SubscriberRegistry();
  private readonly fences = new Map<string, number>();
  private readonly latencyMs: number;
  private readonly failAppendWhen:
    | ((envelope: EventEnvelope) => boolean | string | Error)
    | undefined;

  constructor(options: InMemoryAsyncEventStoreOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.failAppendWhen = options.failAppendWhen;
  }

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
  }

  async append(envelope: EventEnvelope): Promise<void> {
    await this.tick();
    this.assertAppendable(envelope);
    this.commit(envelope);
    this.subscribers.emit(envelope);
  }

  /**
   * ADR 0074 D1 — the reference implementation of the `appendBatch` contract, and what a
   * bring-your-own backend can read to see what it has to honour.
   *
   * One `tick()` for the whole batch, because the point of the method is one round-trip.
   * Atomicity is why validation is a separate pass: EVERY envelope is checked before ANY
   * is committed, so a fenced-out or rejected envelope leaves the log exactly as it was
   * rather than half-applied. Fencing is checked per envelope, since a batch may span
   * executions.
   */
  async appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;
    await this.tick();
    // A batch must be checked against ITSELF as well as the log: two envelopes claiming
    // the same slot — or the same id — are both appendable against the durable state, and
    // only the pairwise check catches them. Tracked lazily, so the common single-execution
    // monotonic batch allocates nothing.
    let claimedSlots: Map<string, Set<number>> | undefined;
    let claimedIds: Set<string> | undefined;
    for (const envelope of envelopes) {
      this.assertAppendable(envelope);
      const seen = claimedSlots?.get(envelope.executionId);
      if (seen?.has(envelope.sequence) === true) {
        throw new DuplicateSequenceError(envelope.executionId, envelope.sequence);
      }
      if (claimedIds?.has(envelope.id) === true) {
        throw new DuplicateEnvelopeIdError(envelope.id, envelope.executionId);
      }
      claimedSlots ??= new Map();
      const set = seen ?? new Set<number>();
      set.add(envelope.sequence);
      claimedSlots.set(envelope.executionId, set);
      claimedIds ??= new Set();
      claimedIds.add(envelope.id);
    }
    for (const envelope of envelopes) this.commit(envelope);
    // Fan out only once the whole batch has landed — a subscriber must never observe a
    // partially applied batch.
    for (const envelope of envelopes) this.subscribers.emit(envelope);
  }

  /**
   * Throws if this envelope may not land: a duplicate `(executionId, sequence)`, a
   * duplicate envelope `id`, K9.4 fencing, or an injected failure.
   */
  private assertAppendable(envelope: EventEnvelope, checkFence = true): void {
    // K9.4 — fencing: once a token has been acquired for this execution, an
    // append missing the current token is a zombie write and is rejected.
    const currentFence = checkFence ? this.fences.get(envelope.executionId) : undefined;
    if (currentFence !== undefined) {
      const fence = fenceOf(envelope);
      if (fence === undefined || fence < currentFence) {
        throw new StaleFenceError(envelope.executionId, fence, currentFence);
      }
    }
    // #306 — the same `UNIQUE (execution_id, sequence)` both SQL backends enforce. Not a
    // redundant belt beside fencing: fencing engages only once a token has been ACQUIRED,
    // and sequences are allocated per-process from folded state, so two unfenced writers
    // recovering the same execution allocate the same next sequence with neither a zombie.
    // O(log n) against the sorted log — `commit` maintains that order for exactly this.
    const list = this.log.get(envelope.executionId);
    if (list !== undefined) {
      const at = lowerBoundBySequence(list, envelope.sequence);
      if (at < list.length && (list[at] as EventEnvelope).sequence === envelope.sequence) {
        throw new DuplicateSequenceError(envelope.executionId, envelope.sequence);
      }
    }
    // #309 — the events table's OTHER key. Checked after the slot, so a writer that lost a
    // sequence race is told that (the actionable failure) rather than being told about the
    // id its own naming convention derived from the sequence it lost.
    if (this.ids.has(envelope.id)) {
      throw new DuplicateEnvelopeIdError(envelope.id, envelope.executionId);
    }
    const verdict = this.failAppendWhen?.(envelope);
    if (verdict) {
      throw verdict instanceof Error
        ? verdict
        : new Error(typeof verdict === "string" ? verdict : `append rejected: ${envelope.id}`);
    }
  }

  /** Insert into the execution's log, keeping it sorted by sequence. */
  private commit(envelope: EventEnvelope): void {
    this.ids.add(envelope.id);
    const list = this.log.get(envelope.executionId) ?? [];
    // Keep each execution's log sorted by sequence so reads can binary-search.
    // Appends are normally monotonic (a plain end-push); only an out-of-order
    // arrival triggers an insertion.
    if (
      list.length === 0 ||
      (list[list.length - 1] as EventEnvelope).sequence <= envelope.sequence
    ) {
      list.push(envelope);
    } else {
      list.splice(lowerBoundBySequence(list, envelope.sequence), 0, envelope);
    }
    this.setLog(envelope.executionId, list);
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    await this.tick();
    // Already sorted by the append invariant — return a defensive copy, no re-sort.
    return [...(this.log.get(executionId) ?? [])];
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    await this.tick();
    const list = this.log.get(executionId) ?? [];
    return list.slice(lowerBoundBySequence(list, fromSequence));
  }

  async head(executionId: string): Promise<number | null> {
    await this.tick();
    const list = this.log.get(executionId) ?? [];
    return list.length === 0 ? null : (list[list.length - 1]?.sequence ?? null);
  }

  async readRange(
    executionId: string,
    fromSequence: number,
    toSequence: number
  ): Promise<EventEnvelope[]> {
    await this.tick();
    return sliceBySequence(this.log.get(executionId) ?? [], fromSequence, toSequence);
  }

  async copyPrefix(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.tick();
    const src = this.log.get(fromExecutionId) ?? [];
    const dst = this.log.get(toExecutionId) ?? [];
    // Built fully before anything is published, so a rejected copy leaves the target
    // untouched — the same all-or-nothing shape the SQL backends get from their INSERT
    // … SELECT, which would abort on the primary key rather than half-populate a fork.
    const copied: EventEnvelope[] = [];
    for (const e of src) {
      if (e.sequence > throughSequence) continue;
      // Re-stamp only; no payload (de)serialization.
      const stamped = {
        ...e,
        executionId: toExecutionId,
        id: `${toExecutionId}-${e.sequence}`,
        metadata: { ...e.metadata, ...metadata },
      };
      // #309 — the re-stamped ids must be as unique as any other. A fork into a target
      // that already holds events is a broken fork, and this is where it surfaces; the
      // check also keeps the id index single-owner, which is what makes removal on
      // delete/truncate safe.
      if (this.ids.has(stamped.id)) {
        throw new DuplicateEnvelopeIdError(stamped.id, toExecutionId);
      }
      copied.push(stamped);
    }
    for (const e of copied) {
      this.ids.add(e.id);
      dst.push(e);
    }
    this.setLog(toExecutionId, dst);
  }

  async acquireFence(executionId: string): Promise<number> {
    await this.tick();
    const next = (this.fences.get(executionId) ?? 0) + 1;
    this.fences.set(executionId, next);
    return next;
  }

  /**
   * ADR 0118 D1 — one synchronous step after the tick, so it cannot interleave with an append's
   * own check-and-commit (which is also synchronous after ITS tick): the token compare-and-set
   * plus a scan of the tail past `parkSeq`, which is short (the events appended since the park).
   */
  async acquireFenceIf(
    executionId: string,
    expect: { fence: number; parkSeq: number }
  ): Promise<AcquireFenceIfResult> {
    await this.tick();
    const current = this.fences.get(executionId) ?? 0;
    if (current !== expect.fence) return { stale: true, fence: current };
    const list = this.log.get(executionId) ?? [];
    for (let i = lowerBoundBySequence(list, expect.parkSeq + 1); i < list.length; i++) {
      if (isAnsweringKind(list[i] as EventEnvelope)) return { stale: true, fence: current };
    }
    this.fences.set(executionId, current + 1);
    return { fence: current + 1 };
  }

  /**
   * SPI 2.2.0 (ADR 0116 amendment) — one synchronous step after the tick, so the existence,
   * head and token checks and the commit cannot interleave with any other append, acquire or
   * delete. The token is compared, never presented: the fence rule is deliberately skipped.
   */
  async appendIfUnchanged(
    executionId: string,
    event: EventEnvelope | null,
    expect?: TipObservation
  ): Promise<AppendIfUnchangedResult> {
    await this.tick();
    if (event !== null && (expect === undefined || event.executionId !== executionId)) {
      throw new TypeError(
        "appendIfUnchanged: an event needs `expect` and the matching executionId"
      );
    }
    const list = this.log.get(executionId);
    const fence = this.fences.get(executionId) ?? 0;
    if (list === undefined || list.length === 0 || (list[0] as EventEnvelope).sequence !== 0) {
      return { appended: false, reason: "gone", head: null, fence, anchor: null };
    }
    const head = (list[list.length - 1] as EventEnvelope).sequence;
    const anchor = creationMarker(list[0] as EventEnvelope);
    if (event === null) return { appended: false, reason: "observed", head, fence, anchor };
    const want = expect as TipObservation;
    if (
      head !== want.head ||
      fence !== want.fence ||
      anchor !== want.anchor ||
      event.sequence !== head + 1
    ) {
      return { appended: false, reason: "moved", head, fence, anchor };
    }
    this.assertAppendable(event, false);
    this.commit(event);
    this.subscribers.emit(event);
    return { appended: true };
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.tick();
    // Release the ids too, or a re-created execution could never re-append the events it
    // just erased — and the index would grow forever across a retention sweep.
    for (const e of this.log.get(executionId) ?? []) this.ids.delete(e.id);
    if (this.log.delete(executionId)) this.sortedIds = undefined;
    this.fences.delete(executionId);
  }

  private setLog(executionId: string, list: EventEnvelope[]): void {
    if (!this.log.has(executionId)) this.sortedIds = undefined;
    this.log.set(executionId, list);
  }

  async listExecutions(): Promise<string[]> {
    await this.tick();
    return [...this.log.keys()];
  }

  async listExecutionsPage(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<{ executionIds: string[]; nextCursor?: string }> {
    await this.tick();
    const limit = opts?.limit ?? 1000;
    const cursor = opts?.cursor;
    // SPI 2.0.0 — code point order, and the cursor may be any string: binary-search the
    // first id strictly after it.
    this.sortedIds ??= [...this.log.keys()].sort(compareExecutionIds);
    const sorted = this.sortedIds;
    let start = 0;
    if (cursor !== undefined) {
      let hi = sorted.length;
      while (start < hi) {
        const mid = (start + hi) >>> 1;
        if (compareExecutionIds(sorted[mid] as string, cursor) > 0) hi = mid;
        else start = mid + 1;
      }
    }
    const executionIds = sorted.slice(start, start + limit);
    const last = executionIds[executionIds.length - 1];
    return {
      executionIds,
      ...(last !== undefined && start + limit < sorted.length && { nextCursor: last }),
    };
  }

  async truncatePrefix(executionId: string, throughSequence: number): Promise<void> {
    await this.truncatePrefixKeeping(executionId, throughSequence, []);
  }

  async truncatePrefixKeeping(
    executionId: string,
    throughSequence: number,
    keepEventTypes: readonly string[]
  ): Promise<void> {
    await this.tick();
    const list = this.log.get(executionId);
    if (list === undefined) return;
    const keepTypes = new Set(keepEventTypes);
    // Preserve sequence 0 (bootstrap anchor) and every kept-type event; drop the rest of
    // (0..throughSequence]. One synchronous pass, so no reader sees a half-truncated prefix.
    const kept: EventEnvelope[] = [];
    for (const e of list) {
      if (e.sequence === 0 || e.sequence > throughSequence || keepTypes.has(e.eventType)) {
        kept.push(e);
      } else {
        this.ids.delete(e.id); // compacted away — its id is free again
      }
    }
    this.setLog(executionId, kept);
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    await this.tick();
    return this.subscribers.add(executionId, handler);
  }

  async close(): Promise<void> {
    this.ids.clear();
    this.log.clear();
    this.sortedIds = undefined;
    this.subscribers.clear();
  }
}
