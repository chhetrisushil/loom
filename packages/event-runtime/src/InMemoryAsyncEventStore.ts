import type { EventEnvelope } from "@loom/core";
import { SubscriberRegistry } from "./SubscriberRegistry";
import { StaleFenceError, fenceOf } from "./fencing";
import { lowerBoundBySequence, sliceBySequence } from "./sequenceRange";
import type { EventStore } from "./types";

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
    for (const envelope of envelopes) this.assertAppendable(envelope);
    for (const envelope of envelopes) this.commit(envelope);
    // Fan out only once the whole batch has landed — a subscriber must never observe a
    // partially applied batch.
    for (const envelope of envelopes) this.subscribers.emit(envelope);
  }

  /** Throws if this envelope may not land (K9.4 fencing, or an injected failure). */
  private assertAppendable(envelope: EventEnvelope): void {
    // K9.4 — fencing: once a token has been acquired for this execution, an
    // append missing the current token is a zombie write and is rejected.
    const currentFence = this.fences.get(envelope.executionId);
    if (currentFence !== undefined) {
      const fence = fenceOf(envelope);
      if (fence === undefined || fence < currentFence) {
        throw new StaleFenceError(envelope.executionId, fence, currentFence);
      }
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
    this.log.set(envelope.executionId, list);
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
    for (const e of src) {
      if (e.sequence > throughSequence) continue;
      // Re-stamp only; no payload (de)serialization.
      dst.push({
        ...e,
        executionId: toExecutionId,
        id: `${toExecutionId}-${e.sequence}`,
        metadata: { ...e.metadata, ...metadata },
      });
    }
    this.log.set(toExecutionId, dst);
  }

  async acquireFence(executionId: string): Promise<number> {
    await this.tick();
    const next = (this.fences.get(executionId) ?? 0) + 1;
    this.fences.set(executionId, next);
    return next;
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.tick();
    this.log.delete(executionId);
    this.fences.delete(executionId);
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
    const sorted = [...this.log.keys()].sort();
    let start = 0;
    if (cursor !== undefined) {
      const idx = sorted.findIndex((id) => id > cursor);
      start = idx === -1 ? sorted.length : idx;
    }
    const executionIds = sorted.slice(start, start + limit);
    const last = executionIds[executionIds.length - 1];
    return {
      executionIds,
      ...(last !== undefined && start + limit < sorted.length && { nextCursor: last }),
    };
  }

  async truncatePrefix(executionId: string, throughSequence: number): Promise<void> {
    await this.tick();
    const list = this.log.get(executionId);
    if (list === undefined) return;
    // Preserve sequence 0 (bootstrap anchor); drop (0..throughSequence].
    this.log.set(
      executionId,
      list.filter((e) => e.sequence === 0 || e.sequence > throughSequence)
    );
  }

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    await this.tick();
    return this.subscribers.add(executionId, handler);
  }

  async close(): Promise<void> {
    this.log.clear();
    this.subscribers.clear();
  }
}
