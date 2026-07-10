import type { Snapshot, SnapshotStore } from "./types";

// Binary-search bounds over a snapshot list kept sorted ascending by `sequence`.
// `lowerBound` = first index with sequence >= seq; `upperBound` = first index with
// sequence > seq.
function lowerBound(list: readonly Snapshot[], seq: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Snapshot).sequence < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(list: readonly Snapshot[], seq: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as Snapshot).sequence <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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
    // Keep each execution's snapshots sorted by sequence with STABLE insertion
    // (a new snapshot goes after any existing ones sharing its sequence). This
    // preserves the old reduce/find tie-break — "last-inserted among equals wins" —
    // while making the reads O(1) / O(log n) instead of O(n).
    if (list.length === 0 || (list[list.length - 1] as Snapshot).sequence <= snapshot.sequence) {
      list.push(snapshot);
    } else {
      list.splice(upperBound(list, snapshot.sequence), 0, snapshot);
    }
    this.snapshots.set(snapshot.executionId, list);
  }

  async loadLatest(executionId: string): Promise<Snapshot | null> {
    await this.tick();
    const list = this.snapshots.get(executionId);
    if (!list || list.length === 0) return null;
    return list[list.length - 1] as Snapshot; // greatest sequence, last-inserted on ties
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.tick();
    const list = this.snapshots.get(executionId);
    if (!list) return null;
    // First element with this exact sequence (matches the old `find` semantics).
    const idx = lowerBound(list, sequence);
    const hit = list[idx];
    return hit !== undefined && hit.sequence === sequence ? hit : null;
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.tick();
    const list = this.snapshots.get(executionId);
    if (!list || list.length === 0) return null;
    // Rightmost snapshot with sequence <= target: (first index > target) - 1.
    const idx = upperBound(list, sequence) - 1;
    return idx >= 0 ? (list[idx] as Snapshot) : null;
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.tick();
    this.snapshots.delete(executionId);
  }

  async close(): Promise<void> {
    this.snapshots.clear();
  }
}
