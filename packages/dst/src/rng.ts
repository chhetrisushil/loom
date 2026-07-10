// ── Seeded, portable PRNG (splitmix64) ───────────────────────────────────────
//
// DST's determinism rests on a single rule: EVERY source of entropy and time in a
// simulated run comes from a seeded stream. `splitmix64` is the generator — small,
// well-distributed, and reproducible across machines (pure BigInt integer math, no
// Math.random, no crypto). The same seed yields the same sequence forever, so a
// failing run is replayable bit-for-bit from its seed alone.
//
// `fork(label)` derives an independent named sub-stream from the current state, so
// one component (e.g. the fault store) can draw without perturbing another (e.g. a
// scenario's own choices) — the streams stay stable as unrelated code changes.

const MASK64 = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

function mix64(z: bigint): bigint {
  let x = z & MASK64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (x ^ (x >> 31n)) & MASK64;
}

/** Derive a 64-bit seed from an arbitrary string label (FNV-1a, then mixed). */
export function seedFromLabel(label: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < label.length; i++) {
    h = ((h ^ BigInt(label.charCodeAt(i))) * 0x100000001b3n) & MASK64;
  }
  return mix64(h);
}

/** A seeded pseudo-random stream. All draws are deterministic in the seed. */
export interface Rng {
  /** Uniform float in [0, 1) from the top 53 bits. */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Returns 0 when maxExclusive <= 0. */
  int(maxExclusive: number): number;
  /** Uniform choice from a non-empty array. Throws on an empty array. */
  pick<T>(xs: readonly T[]): T;
  /** True with probability p (default 0.5). p<=0 ⇒ never, p>=1 ⇒ always. */
  bool(p?: number): boolean;
  /** An independent named sub-stream, stable under unrelated code changes. */
  fork(label: string): Rng;
}

/** Construct a {@link Rng} from a 64-bit seed. */
export function splitmix64(seed: bigint): Rng {
  let state = seed & MASK64;

  const nextU64 = (): bigint => {
    state = (state + GOLDEN_GAMMA) & MASK64;
    return mix64(state);
  };

  const rng: Rng = {
    next(): number {
      // Top 53 bits → a double in [0,1), matching Math.random's resolution.
      return Number(nextU64() >> 11n) / 2 ** 53;
    },
    int(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return Number(nextU64() % BigInt(Math.floor(maxExclusive)));
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error("rng.pick: empty array");
      return xs[rng.int(xs.length)] as T;
    },
    bool(p = 0.5): boolean {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return rng.next() < p;
    },
    fork(label: string): Rng {
      // Mix the label into the CURRENT state so sub-streams are position-dependent
      // yet independent of each other.
      return splitmix64(mix64(state ^ seedFromLabel(label)));
    },
  };
  return rng;
}
