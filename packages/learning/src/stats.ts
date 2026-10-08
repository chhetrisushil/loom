// ── Deterministic statistics helpers (R18, ADR 0124) ─────────────────────────
//
// Evaluation must be reproducible: the same trajectories and the same options give the same
// report, byte for byte, so a promotion decision can be re-derived and audited. That rules out
// `Math.random`; the bootstrap draws from a seeded generator instead.

/** A small, fast, well-distributed 32-bit PRNG (mulberry32). Same seed, same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of an ASCENDING array. `q` in [0,1]. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}
