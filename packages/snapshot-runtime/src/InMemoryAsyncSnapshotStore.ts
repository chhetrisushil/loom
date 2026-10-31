import {
  type SnapshotCodecName,
  assertSnapshotCodecAvailable,
  decodeState,
  encodeState,
  parseSnapshotCodec,
} from "./snapshotCodec";
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
  /**
   * ADR 0140 - `"zstd"` stores each state as a codec frame (zstd-compressed JSON) and decodes it on
   * every read, so a caller gets a fresh, independent copy and the store exercises the same format the
   * durable stores write. Default `"none"`: the very object saved is held and returned (today's behaviour).
   * Throws at construction on a Node without zstd (>= 22.15).
   */
  codec?: SnapshotCodecName;
}

/**
 * Reference **async** SnapshotStore — a genuine Promise-returning backend, the
 * snapshot counterpart to {@link InMemoryAsyncEventStore}. A starting point for a
 * real network backend, and used in tests to exercise the async resume/fork paths.
 */
export class InMemoryAsyncSnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly latencyMs: number;
  /** ADR 0140 - the codec this store WRITES (`"none"` holds the saved object itself). Structural, read by `defineConfig`. */
  readonly snapshotCodec: SnapshotCodecName;
  // Codec frames, keyed by the held snapshot (whose own `state` is then a placeholder). Empty when `"none"`.
  private readonly frames = new WeakMap<Snapshot, Buffer>();

  constructor(options: InMemoryAsyncSnapshotStoreOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.snapshotCodec = parseSnapshotCodec(options.codec);
    assertSnapshotCodecAvailable(this.snapshotCodec);
  }

  // A read hands back the decoded state of a framed snapshot, the held object otherwise.
  private out(s: Snapshot | null | undefined): Snapshot | null {
    if (s === undefined || s === null) return null;
    const frame = this.frames.get(s);
    return frame === undefined ? s : { ...s, state: decodeState(frame) };
  }

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
  }

  async save(saved: Snapshot): Promise<void> {
    await this.tick();
    let snapshot = saved;
    if (this.snapshotCodec !== "none") {
      const frame = encodeState(saved.state, this.snapshotCodec);
      snapshot = { ...saved, state: undefined as never };
      this.frames.set(snapshot, frame);
    }
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
    return this.out(list[list.length - 1]); // greatest sequence, last-inserted on ties
  }

  /** Nothing here is sealed: at rest IS what `loadLatest` returns (SPI 1.1.0). */
  async loadLatestSealed(executionId: string): Promise<Snapshot | null> {
    return this.loadLatest(executionId);
  }

  async loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.tick();
    const list = this.snapshots.get(executionId);
    if (!list) return null;
    // First element with this exact sequence (matches the old `find` semantics).
    const idx = lowerBound(list, sequence);
    const hit = list[idx];
    return hit !== undefined && hit.sequence === sequence ? this.out(hit) : null;
  }

  async loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    await this.tick();
    const list = this.snapshots.get(executionId);
    if (!list || list.length === 0) return null;
    // Rightmost snapshot with sequence <= target: (first index > target) - 1.
    const idx = upperBound(list, sequence) - 1;
    return idx >= 0 ? this.out(list[idx]) : null;
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.tick();
    this.snapshots.delete(executionId);
  }

  async pruneSnapshots(
    executionId: string,
    range: { readonly after: number; readonly before: number },
    keep: readonly number[] = []
  ): Promise<number> {
    await this.tick();
    const list = this.snapshots.get(executionId);
    if (!list) return 0;
    // The list is sorted by sequence: the candidates are the contiguous slice (after, before).
    const lo = upperBound(list, range.after);
    const hi = lowerBound(list, range.before);
    if (hi <= lo) return 0;
    const spared = new Set(keep);
    const doomed = list.slice(lo, hi).filter((s) => !spared.has(s.sequence));
    if (doomed.length === 0) return 0;
    const kept = [
      ...list.slice(0, lo),
      ...list.slice(lo, hi).filter((s) => spared.has(s.sequence)),
      ...list.slice(hi),
    ];
    this.snapshots.set(executionId, kept);
    return doomed.length;
  }

  async close(): Promise<void> {
    this.snapshots.clear();
  }
}
