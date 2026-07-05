import type { Snapshot, SnapshotStore } from "./types";

export interface InMemoryAsyncSnapshotStoreOptions {
  /** Artificial per-operation delay (ms) to model network latency. Default 0. */
  latencyMs?: number;
}

/**
 * Reference **async** SnapshotStore — a genuine Promise-returning backend, the
 * snapshot counterpart to {@link InMemoryAsyncEventStore}. A starting point for a
 * real network backend, and used in tests to exercise the async resume/fork paths.
 */
export class InMemoryAsyncSnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly latencyMs: number;

  constructor(options: InMemoryAsyncSnapshotStoreOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
  }

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
  }

  async save(snapshot: Snapshot): Promise<void> {
    await this.tick();
    const list = this.snapshots.get(snapshot.executionId) ?? [];
    list.push(snapshot);
    this.snapshots.set(snapshot.executionId, list);
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    await this.tick();
    const list = this.snapshots.get(executionId);
    if (!list || list.length === 0) return null;
    return list.reduce((a, b) => (b.sequence >= a.sequence ? b : a));
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.tick();
    return this.snapshots.get(executionId)?.find((s) => s.sequence === sequence) ?? null;
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.tick();
    const candidates = (this.snapshots.get(executionId) ?? []).filter(
      (s) => s.sequence <= sequence
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.sequence >= a.sequence ? b : a));
  }

  async close(): Promise<void> {
    this.snapshots.clear();
  }
}
