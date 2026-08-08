/**
 * Measurement primitives for the throughput harness.
 *
 * These benches answer a different question from the `*.bench.ts` files elsewhere in
 * the repo. Those use `vitest bench` to measure the *latency* of one operation in
 * isolation (hz of a serial loop). Throughput against a network store is a different
 * shape: the interesting number is sustained ops/sec with N operations IN FLIGHT, and
 * the interesting failure mode is the latency tail as concurrency rises. `vitest bench`
 * cannot express that — hence a standalone driver.
 */

/** One measured scenario. Latencies are per-operation, in milliseconds. */
export interface Measurement {
  label: string;
  /** Operations completed in the measured phase. */
  ops: number;
  /** Unmeasured warmup operations, across all workers. Not counted in {@link opsPerSec}. */
  warmupOps: number;
  /** Logical units per operation — e.g. events per batched append. `ops * unitsPerOp` = units. */
  unitsPerOp: number;
  concurrency: number;
  wallMs: number;
  /** Operations per second (NOT units — see {@link unitsPerSec}). */
  opsPerSec: number;
  /** Units per second: `opsPerSec * unitsPerOp`. Equals opsPerSec when unitsPerOp is 1. */
  unitsPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Identifies one operation to the workload function. */
export interface OpContext {
  /** Which concurrent worker is running this op — stable for the worker's lifetime. */
  worker: number;
  /** 0-based index of this op WITHIN this worker's stream. */
  n: number;
  /** 0-based index across all workers and both phases (warmup included). Globally unique. */
  global: number;
}

export interface DriveOptions {
  label: string;
  /** Concurrent in-flight workers. Each worker runs its ops serially. */
  concurrency: number;
  /** Measured operations per worker. Total measured ops = `concurrency * opsPerWorker`. */
  opsPerWorker: number;
  /** Unmeasured operations per worker, run first (JIT, pool fill, page cache). */
  warmupPerWorker?: number;
  /** See {@link Measurement.unitsPerOp}. Default 1. */
  unitsPerOp?: number;
  op: (ctx: OpContext) => Promise<void>;
}

/**
 * Run `op` under a fixed-size worker pool and measure the steady state.
 *
 * Worker-per-stream, not a shared queue: each worker owns a monotonic `n`, so a
 * workload can map worker → executionId and get exactly the real write shape — many
 * concurrent executions, each with ONE serial writer (the ExecutionJournal's FIFO
 * invariant). A shared work queue would instead fan several concurrent appends at the
 * same execution, which the kernel never does, and would measure a contention profile
 * that cannot occur in production.
 */
export async function drive(opts: DriveOptions): Promise<Measurement> {
  const { label, concurrency, opsPerWorker, op } = opts;
  const warmupPerWorker = opts.warmupPerWorker ?? 0;
  const unitsPerOp = opts.unitsPerOp ?? 1;
  const totalOps = concurrency * opsPerWorker;

  // Preallocated sample buffer — one slot per measured op, written by index (no
  // push/growth, no per-op allocation on the hot path).
  const samples = new Float64Array(totalOps);
  let globalCounter = 0;

  // `n` continues across the warmup→measured boundary rather than restarting, so a
  // workload that maps (worker, n) → (executionId, sequence) never re-issues an id the
  // warmup already wrote — and the sequence stays monotonic per execution, which is the
  // only shape a real ExecutionJournal produces.
  const runPhase = async (count: number, offset: number, measured: boolean): Promise<number> => {
    if (count === 0) return 0;
    const started = performance.now();
    const workers: Promise<void>[] = new Array(concurrency);
    for (let w = 0; w < concurrency; w++) {
      workers[w] = (async () => {
        for (let k = 0; k < count; k++) {
          const global = globalCounter++;
          const ctx: OpContext = { worker: w, n: offset + k, global };
          if (measured) {
            const t0 = performance.now();
            await op(ctx);
            // Row-major by worker: worker w owns [w*count, (w+1)*count).
            samples[w * count + k] = performance.now() - t0;
          } else {
            await op(ctx);
          }
        }
      })();
    }
    await Promise.all(workers);
    return performance.now() - started;
  };

  await runPhase(warmupPerWorker, 0, false);
  const wallMs = await runPhase(opsPerWorker, warmupPerWorker, true);

  // TypedArray sort is numeric ascending by default — no comparator allocation,
  // and it beats Array#sort on both time and memory for a buffer this size.
  samples.sort();
  const opsPerSec = (totalOps / wallMs) * 1000;
  return {
    label,
    ops: totalOps,
    warmupOps: warmupPerWorker * concurrency,
    unitsPerOp,
    concurrency,
    wallMs,
    opsPerSec,
    unitsPerSec: opsPerSec * unitsPerOp,
    p50: quantile(samples, 0.5),
    p95: quantile(samples, 0.95),
    p99: quantile(samples, 0.99),
    max: samples.length === 0 ? 0 : (samples[samples.length - 1] as number),
  };
}

/** Nearest-rank quantile over an ASCENDING-sorted buffer. O(1). */
export function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length) - 1;
  const idx = rank < 0 ? 0 : rank >= sorted.length ? sorted.length - 1 : rank;
  return sorted[idx] as number;
}
