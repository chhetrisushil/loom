import { type DecoratorPlan, installOptional } from "@loom/event-runtime";
import { BoundedTopN } from "./BoundedTopN";
import { encodeState } from "./snapshotCodec";
import type { OptionalSnapshotStoreMethod, Snapshot, SnapshotStore } from "./types";

/** Bucket `i` counts sizes in `(2^(i-1), 2^i]` (bucket 0 is `0..1`); the last is open-ended. */
export const SIZE_HISTOGRAM_BUCKETS = 41;
const OVERFLOW_BUCKET = SIZE_HISTOGRAM_BUCKETS - 1;

export interface SnapshotSizeBucket {
  /** Inclusive upper bound in bytes (`Infinity` for the last, open-ended bucket). */
  readonly maxBytes: number;
  readonly count: number;
}

export interface LargestSnapshot {
  readonly executionId: string;
  /** Size of that execution's LATEST measured snapshot. */
  readonly bytes: number;
  readonly sequence: number;
}

export interface SnapshotSizeProfile {
  /** Every `save` that reached the wrapped store successfully (sampled or not). */
  saves: number;
  /** Saves that were actually measured (equals `saves` unless `sampleRate` < 1). */
  measured: number;
  /** Measurements that failed (never a failed save). */
  measurementErrors: number;
  /** Summed / largest UTF-8 bytes of the state, over the MEASURED saves. */
  totalBytes: number;
  maxBytes: number;
  /** Power-of-two histogram over the measured saves; always {@link SIZE_HISTOGRAM_BUCKETS} long. */
  histogram: SnapshotSizeBucket[];
  /** Up to `topN` executions by latest snapshot size, largest first. */
  largest: LargestSnapshot[];
}

export interface ProfilingSnapshotStoreOptions {
  /** How many largest executions to keep (default 10; 0 keeps none). Memory is O(topN). */
  topN?: number;
  /**
   * `onLargeSnapshot` fires when an execution's snapshot first reaches this many bytes.
   * Required when `onLargeSnapshot` is given (the hook would otherwise never fire).
   */
  largeThresholdBytes?: number;
  /**
   * Fires ONCE per execution when it first crosses `largeThresholdBytes`. A throw or a
   * rejection is swallowed (it never fails the save). A SYNC hook runs on the save path (it
   * delays the save's resolution); only an async hook's work is off it. Needs
   * `largeThresholdBytes`. A save that `sampleRate` skipped fires nothing.
   */
  onLargeSnapshot?: (executionId: string, bytes: number) => void | Promise<void>;
  /**
   * Executions remembered as already reported (default 1024). An LRU: when full, the least
   * recently SAVED one is forgotten, and may fire again if it is saved over the threshold
   * later. That repeat is accepted so memory stays O(capacity). With 0 nothing is remembered,
   * so the hook fires on EVERY over-threshold save.
   */
  dedupeCapacity?: number;
  /**
   * Fraction of saves to measure, `0..1` (default 1: all). Sampling can MISS a rare huge
   * snapshot: a sampled-out save updates neither `largest` nor the hook.
   */
  sampleRate?: number;
  /** Source of `[0,1)` numbers for sampling; inject a fake in tests (default `Math.random`). */
  sampler?: () => number;
  /**
   * What a "size" is. `"json"` (default when the wrapped store writes no codec): the UTF-8 text of
   * `JSON.stringify(state)`. `"stored"`: the bytes a codec frame occupies, i.e. what the backend keeps
   * (ADR 0140: with `codec: "zstd"` that is the compressed size); it needs the wrapped store to report
   * `snapshotCodec`, else it is the same as `"json"` plus the one format byte. Default `"stored"` when
   * the wrapped store reports `snapshotCodec: "zstd"`, so a zstd deployment's histogram shows real bytes.
   * `"stored"` compresses once per measured save (synchronously, like the stringify): use `sampleRate`.
   */
  measure?: "json" | "stored";
  /** Told about a measurement or hook that threw. Itself guarded: a throw here is swallowed too. */
  onMeasurementError?: (executionId: string, error: unknown) => void;
}

/** UTF-8 byte length of `s` without allocating (a lone surrogate counts as U+FFFD: 3 bytes). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Bucket for `bytes`: the smallest `i` with `bytes <= 2^i`, capped at the overflow bucket. */
export function sizeBucket(bytes: number): number {
  if (bytes <= 1) return 0;
  if (bytes <= 2 ** 31) return 32 - Math.clz32(bytes - 1);
  let i = 31;
  while (i < OVERFLOW_BUCKET && bytes > 2 ** i) i++;
  return i;
}

/**
 * Measures how big snapshots actually are, so "do huge states occur?" (#706, #708) has data
 * before anything bigger is built for snapshot growth. Mirrors `ProfilingEventStore`: a
 * decorator, so zero cost when unwired; it never changes what is saved and never fails a save.
 *
 * **Placement answers different questions.** Wrapped OUTSIDE `EncryptingSnapshotStore` it
 * measures the PLAINTEXT state (how big is the state?). Wrapped around the raw backend it
 * measures what the backend is handed, i.e. the ciphertext envelopes (how big is what we
 * store?). Inside `TenantScopedSnapshotStore` it sees tenant-prefixed ids.
 *
 * **Cost.** One `JSON.stringify` of the state per measured save (the backend serializes again),
 * done synchronously before the save is forwarded, plus an allocation-free UTF-8 length. Saves
 * are fire-and-forget off the resume path, but if the stringify shows up, set `sampleRate`.
 * It measures the UTF-8 text size of `JSON.stringify(state)`. SQLite stores exactly that text;
 * Postgres casts to JSONB (whitespace, key order and duplicates are normalised, and TOAST
 * compression changes the on-disk size), so read the on-disk size there with `pg_column_size`.
 * A state that cannot be serialized counts as a `measurementErrors` entry.
 *
 * **Reading it.** `profile()` gives totals, a power-of-two `histogram` (bucket `maxBytes` is an
 * inclusive upper bound) and `largest`, the top N executions by their latest snapshot size. A
 * flat histogram below your concern threshold is the answer "no, huge states do not occur".
 *
 * **Memory is O(1) in executions**: fixed histogram, a top-N min-heap (O(topN)) and an LRU
 * dedupe set (O(dedupeCapacity)); see {@link BoundedTopN}.
 */
export class ProfilingSnapshotStore implements SnapshotStore {
  readonly deleteExecution?: NonNullable<SnapshotStore["deleteExecution"]>;
  readonly loadLatestSealed?: NonNullable<SnapshotStore["loadLatestSealed"]>;
  readonly pruneSnapshots?: NonNullable<SnapshotStore["pruneSnapshots"]>;

  private saves = 0;
  private measured = 0;
  private measurementErrors = 0;
  private totalBytes = 0;
  private maxBytes = 0;
  private readonly counts = new Array<number>(SIZE_HISTOGRAM_BUCKETS).fill(0);
  private readonly top: BoundedTopN;
  /**
   * Insertion-ordered Map used as an LRU: first key = least recently saved. The value is the
   * highest sequence seen, so a late (lower-sequence) completion cannot refresh the recency.
   */
  private readonly flagged = new Map<string, number>();
  private readonly dedupeCapacity: number;
  private readonly codec: "none" | "zstd";
  private readonly stored: boolean;
  private readonly sampleRate: number;
  private readonly sampler: () => number;

  constructor(
    private readonly inner: SnapshotStore,
    private readonly options: ProfilingSnapshotStoreOptions = {}
  ) {
    const topN = options.topN ?? 10;
    const dedupe = options.dedupeCapacity ?? 1024;
    const rate = options.sampleRate ?? 1;
    if (!Number.isInteger(topN) || topN < 0) {
      throw new RangeError(`ProfilingSnapshotStore: topN must be an integer >= 0 (got ${topN})`);
    }
    if (!Number.isInteger(dedupe) || dedupe < 0) {
      throw new RangeError(
        `ProfilingSnapshotStore: dedupeCapacity must be an integer >= 0 (got ${dedupe})`
      );
    }
    if (!(rate >= 0 && rate <= 1)) {
      throw new RangeError(`ProfilingSnapshotStore: sampleRate must be in 0..1 (got ${rate})`);
    }
    if (options.onLargeSnapshot !== undefined && options.largeThresholdBytes === undefined) {
      throw new RangeError(
        "ProfilingSnapshotStore: onLargeSnapshot requires largeThresholdBytes (it would never fire)"
      );
    }
    const innerCodec = (inner as { snapshotCodec?: unknown }).snapshotCodec;
    this.codec = innerCodec === "zstd" ? "zstd" : "none";
    this.stored = (options.measure ?? (this.codec === "zstd" ? "stored" : "json")) === "stored";
    this.dedupeCapacity = dedupe;
    this.sampleRate = rate;
    this.sampler = options.sampler ?? Math.random;
    this.top = new BoundedTopN(topN);
    const plan = {
      // Removing the execution from the structures is the point of these two: its snapshots
      // are gone, so a remembered size or "already reported" flag would be stale.
      deleteExecution: async (id) => {
        await inner.deleteExecution!(id);
        this.forget(id);
      },
      pruneSnapshots: async (id, range, keep) => {
        const deleted = await inner.pruneSnapshots!(id, range, keep);
        // Forget only what the prune could have removed: the held LATEST snapshot inside the
        // range and not kept. Otherwise it survives, and so does its size and its flag.
        if (deleted > 0) {
          const gone = (sequence: number | undefined): boolean =>
            sequence !== undefined &&
            range.after < sequence &&
            sequence < range.before &&
            !(keep?.includes(sequence) ?? false);
          if (gone(this.top.sequenceOf(id))) this.top.remove(id);
          if (gone(this.flagged.get(id))) this.flagged.delete(id);
        }
        return deleted;
      },
      // A sealed read hands back stored bytes; nothing to measure or track.
      loadLatestSealed: "forward",
    } satisfies DecoratorPlan<SnapshotStore, OptionalSnapshotStoreMethod>;
    installOptional<SnapshotStore, OptionalSnapshotStoreMethod>(this, inner, plan);
  }

  private forget(executionId: string): void {
    this.top.remove(executionId);
    this.flagged.delete(executionId);
  }

  private measure(snapshot: Snapshot): number | undefined {
    if (this.sampleRate < 1 && !(this.sampler() < this.sampleRate)) return undefined;
    try {
      if (this.stored) {
        return JSON.stringify(snapshot.state) === undefined
          ? 0
          : encodeState(snapshot.state, this.codec).length;
      }
      const json = JSON.stringify(snapshot.state);
      return json === undefined ? 0 : utf8ByteLength(json);
    } catch (error) {
      this.measurementErrors++;
      this.report(snapshot.executionId, error);
      return undefined;
    }
  }

  private report(executionId: string, error: unknown): void {
    try {
      this.options.onMeasurementError?.(executionId, error);
    } catch {
      // a reporting hook must not disturb the save
    }
  }

  private record(snapshot: Snapshot, bytes: number): void {
    this.measured++;
    this.totalBytes += bytes;
    if (bytes > this.maxBytes) this.maxBytes = bytes;
    this.counts[sizeBucket(bytes)]!++;
    const id = snapshot.executionId;
    this.top.offer(id, bytes, snapshot.sequence);
    const threshold = this.options.largeThresholdBytes;
    if (threshold === undefined) return;
    const seen = this.flagged.get(id);
    if (seen !== undefined) {
      // refresh recency: an execution still being saved should outlive idle ones. A late,
      // lower-sequence completion is not a newer save and must not.
      if (snapshot.sequence >= seen) {
        this.flagged.delete(id);
        this.flagged.set(id, snapshot.sequence);
      }
      return;
    }
    if (bytes < threshold) return;
    if (this.dedupeCapacity > 0) {
      this.flagged.set(id, snapshot.sequence);
      if (this.flagged.size > this.dedupeCapacity) {
        this.flagged.delete(this.flagged.keys().next().value as string);
      }
    }
    this.fire(id, bytes);
  }

  private fire(executionId: string, bytes: number): void {
    const hook = this.options.onLargeSnapshot;
    if (hook === undefined) return;
    try {
      const out = hook(executionId, bytes);
      if (out !== undefined && typeof (out as Promise<void>).catch === "function") {
        (out as Promise<void>).catch((error: unknown) => this.report(executionId, error));
      }
    } catch (error) {
      this.report(executionId, error);
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    // Measure what the wrapped store is about to receive, but only COUNT it once the save
    // landed: a refused save (stale fence, conflict) stored nothing.
    const bytes = this.measure(snapshot);
    await this.inner.save(snapshot);
    this.saves++;
    if (bytes !== undefined) this.record(snapshot, bytes);
  }

  loadLatest(executionId: string): Promise<Snapshot | null> {
    return this.inner.loadLatest(executionId);
  }

  loadAt(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.inner.loadAt(executionId, sequence);
  }

  loadLatestBefore(executionId: string, sequence: number): Promise<Snapshot | null> {
    return this.inner.loadLatestBefore(executionId, sequence);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /** The profile so far. Safe to call any time; O(topN log topN). */
  profile(): SnapshotSizeProfile {
    return {
      saves: this.saves,
      measured: this.measured,
      measurementErrors: this.measurementErrors,
      totalBytes: this.totalBytes,
      maxBytes: this.maxBytes,
      histogram: this.counts.map((count, i) => ({
        maxBytes: i === OVERFLOW_BUCKET ? Number.POSITIVE_INFINITY : 2 ** i,
        count,
      })),
      largest: this.top
        .entries()
        .map((e) => ({ executionId: e.key, bytes: e.value, sequence: e.sequence })),
    };
  }

  /** How many executions each bounded structure holds now (diagnostic; never above its cap). */
  trackedCounts(): { largest: number; reported: number } {
    return { largest: this.top.size, reported: this.flagged.size };
  }

  /** Discard measurements (e.g. after a warmup), including the dedupe memory. */
  resetProfile(): void {
    this.saves = 0;
    this.measured = 0;
    this.measurementErrors = 0;
    this.totalBytes = 0;
    this.maxBytes = 0;
    this.counts.fill(0);
    this.top.clear();
    this.flagged.clear();
  }
}
