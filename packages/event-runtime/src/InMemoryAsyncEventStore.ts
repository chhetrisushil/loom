import type { EventEnvelope } from "@loom/core";
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
  private readonly subscribers = new Map<string, Set<(e: EventEnvelope) => void>>();
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
    const verdict = this.failAppendWhen?.(envelope);
    if (verdict) {
      throw verdict instanceof Error
        ? verdict
        : new Error(typeof verdict === "string" ? verdict : `append rejected: ${envelope.id}`);
    }
    const list = this.log.get(envelope.executionId) ?? [];
    list.push(envelope);
    this.log.set(envelope.executionId, list);
    const handlers = this.subscribers.get(envelope.executionId);
    if (handlers) for (const h of handlers) h(envelope);
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    await this.tick();
    return [...(this.log.get(executionId) ?? [])].sort((a, b) => a.sequence - b.sequence);
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    const all = await this.read(executionId);
    return all.filter((e) => e.sequence >= fromSequence);
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

  async subscribe(
    executionId: string,
    handler: (event: EventEnvelope) => void
  ): Promise<() => void> {
    await this.tick();
    const set = this.subscribers.get(executionId) ?? new Set();
    set.add(handler);
    this.subscribers.set(executionId, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.subscribers.delete(executionId);
    };
  }

  async close(): Promise<void> {
    this.log.clear();
    this.subscribers.clear();
  }
}
