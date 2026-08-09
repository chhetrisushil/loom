import type { EventEnvelope } from "@loom/core";
import { bucketOf } from "./SubscriberRegistry";
import { type EventStore, type ExecutionPage, appendBatchOf } from "./types";

export interface ShardedEventStoreOptions {
  /**
   * Which shard owns an execution. Must be STABLE across processes and restarts — two
   * nodes disagreeing routes the same execution to two logs. Default: FNV-1a over the id.
   */
  shardOf?: (executionId: string, shards: number) => number;
}

/**
 * Routes each execution to one of N inner stores by `hash(executionId)` (ADR 0074 D3).
 *
 * This is the item that needs **zero backend cooperation**: it takes `EventStore[]` and
 * never asks what it is wrapping, so a bring-your-own backend gets the horizontal-scale
 * story free, and the shards may be heterogeneous (a Postgres primary beside a SQLite file
 * beside something third-party).
 *
 * What sharding is worth: the log is the measured ceiling, and worker scale-out cannot
 * raise it because every worker writes the same log. Splitting the log is the only thing
 * that does.
 *
 * Invariants it relies on:
 * - **An execution never moves.** All of its events, its fence, and its snapshot live on
 *   one shard, so per-execution ordering and the single-writer invariant are untouched.
 *   There is deliberately no rebalancing story; changing the shard count re-routes existing
 *   executions and is a migration, not a config change.
 * - **Fencing shards cleanly** — it is per-execution, so no cross-shard coordination.
 *
 * What it costs:
 * - `copyPrefix` (fork) only has a server-side path when parent and child land on the same
 *   shard. Cross-shard forks fall back to the SPI's documented per-event copy, so they stay
 *   correct and get slower.
 * - Enumeration becomes scatter-gather with a k-way merge, preserving the SPI's
 *   lexicographic contract.
 */
export class ShardedEventStore implements EventStore {
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;

  private readonly shards: readonly EventStore[];
  private readonly shardOf: (executionId: string, shards: number) => number;

  constructor(shards: readonly EventStore[], options: ShardedEventStoreOptions = {}) {
    if (shards.length === 0) throw new Error("ShardedEventStore requires at least one shard");
    this.shards = shards;
    this.shardOf = options.shardOf ?? bucketOf;

    // Optional capabilities are exposed only when EVERY shard has them: a partial
    // capability would work for some executions and not others depending on where they
    // hashed, which is worse than not advertising it at all.
    if (shards.every((s) => s.readRange !== undefined)) {
      this.readRange = (id, from, to) => this.pick(id).readRange!(id, from, to);
    }
    if (shards.every((s) => s.acquireFence !== undefined)) {
      this.acquireFence = (id) => this.pick(id).acquireFence!(id);
    }
    if (shards.every((s) => s.deleteExecution !== undefined)) {
      this.deleteExecution = (id) => this.pick(id).deleteExecution!(id);
    }
    if (shards.every((s) => s.truncatePrefix !== undefined)) {
      this.truncatePrefix = (id, through) => this.pick(id).truncatePrefix!(id, through);
    }
    if (shards.every((s) => s.listExecutions !== undefined)) {
      this.listExecutions = async () => {
        const perShard = await Promise.all(this.shards.map((s) => s.listExecutions!()));
        return perShard.flat();
      };
    }
    // Paged enumeration needs EVERY shard to be pageable; falling back to listExecutions on
    // some would defeat the bounded-memory guarantee the page API exists to provide.
    if (shards.every((s) => s.listExecutionsPage !== undefined)) {
      this.listExecutionsPage = (opts) => this.pagedScatterGather(opts);
    }
  }

  /** The shard owning `executionId`. */
  private pick(executionId: string): EventStore {
    return this.shards[this.shardOf(executionId, this.shards.length)] as EventStore;
  }

  append(envelope: EventEnvelope): Promise<void> {
    return this.pick(envelope.executionId).append(envelope);
  }

  /**
   * Split a batch by shard and append each part. Shards are independent logs, so the parts
   * run concurrently.
   *
   * Atomicity is per shard, which is exactly what the SPI requires: the contract is atomic
   * PER EXECUTION, and an execution never spans shards. Whole-batch atomicity across
   * shards would need a distributed transaction, costs far more than batching saves, and
   * nothing needs it — a batch only groups INDEPENDENT executions, so nothing in it
   * depends on anything else in it. `Promise.all` rejects if any shard does, so a caller
   * still never reads a partial write as success.
   */
  async appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;
    const bySlot = new Map<number, EventEnvelope[]>();
    for (const envelope of envelopes) {
      const slot = this.shardOf(envelope.executionId, this.shards.length);
      const list = bySlot.get(slot);
      if (list === undefined) bySlot.set(slot, [envelope]);
      else list.push(envelope);
    }
    await Promise.all(
      [...bySlot].map(([slot, part]) => appendBatchOf(this.shards[slot] as EventStore, part))
    );
  }

  read(executionId: string): Promise<EventEnvelope[]> {
    return this.pick(executionId).read(executionId);
  }

  readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return this.pick(executionId).readFrom(executionId, fromSequence);
  }

  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void> {
    return this.pick(executionId).subscribe(executionId, handler);
  }

  /**
   * Fork. Fast when parent and child hash to the same shard; otherwise the prefix has to
   * cross a process boundary, so we use the SPI's documented per-event fallback.
   */
  async copyPrefix(
    fromExecutionId: string,
    toExecutionId: string,
    throughSequence: number,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const source = this.pick(fromExecutionId);
    const target = this.pick(toExecutionId);
    if (source === target && source.copyPrefix !== undefined) {
      return source.copyPrefix(fromExecutionId, toExecutionId, throughSequence, metadata);
    }
    const events = await source.read(fromExecutionId);
    const copied = events
      .filter((e) => e.sequence <= throughSequence)
      .map((e) => ({
        ...e,
        id: `${toExecutionId}-${e.sequence}`,
        executionId: toExecutionId,
        metadata: { ...e.metadata, ...metadata },
      }));
    await appendBatchOf(target, copied);
  }

  /**
   * Keyset pagination across shards. Each shard is asked for its next page beyond the
   * cursor; the results are k-way merged and truncated to `limit`, so the caller sees one
   * globally lexicographic stream and the cursor stays a single opaque id.
   *
   * Bounded memory is preserved: at most `limit + 1` ids per shard are held at a time.
   */
  private async pagedScatterGather(opts?: {
    cursor?: string;
    limit?: number;
  }): Promise<ExecutionPage> {
    const limit = opts?.limit ?? 1000;
    const pages = await Promise.all(
      this.shards.map((s) =>
        s.listExecutionsPage!({ ...(opts?.cursor !== undefined && { cursor: opts.cursor }), limit })
      )
    );
    // Merge: every shard's page is already sorted, so a sort of the union is equivalent to
    // a k-way merge here and is simpler; the union is bounded by shards × limit.
    const merged = pages
      .flatMap((p) => p.executionIds)
      .sort()
      .slice(0, limit);
    const last = merged[merged.length - 1];
    // More remains if any shard reported a further page, or if the merge itself truncated.
    const truncated =
      pages.some((p) => p.nextCursor !== undefined) ||
      pages.reduce((n, p) => n + p.executionIds.length, 0) > merged.length;
    return {
      executionIds: merged,
      ...(truncated && last !== undefined && { nextCursor: last }),
    };
  }

  async close(): Promise<void> {
    await Promise.all(this.shards.map((s) => s.close()));
  }
}
