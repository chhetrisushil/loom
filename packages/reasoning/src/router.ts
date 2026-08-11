import type { ModelRoute, ReasoningRequest, Router } from "./types";

// Default routing policy: the lowest-tier route whose tags include the request's
// strategy, else the lowest-tier route overall. This implements "use the cheap
// model first; elevate only when confidence is low" (the P3 elevation ladder).
//
// Contract: `routes` are expected tier-ascending. ReasoningRuntime owns the sort
// (once, at construction) and always passes its sorted `routes`, so this router
// takes the first tag/overall match without re-sorting on every call.
export const tagRouter: Router = {
  select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute {
    if (req.strategy !== undefined) {
      const tagged = routes.find((r) => r.tags?.includes(req.strategy as string));
      if (tagged !== undefined) return tagged;
    }
    const first = routes[0];
    if (first === undefined) {
      throw new Error("ReasoningRuntime: no routes configured");
    }
    return first;
  },
};

// ── Evidence ─────────────────────────────────────────────────────────────────
//
// Per-arm evidence: the mean reward AND how many samples produced it. This is
// structurally what `outcomeAnalytics` (@loom/analytics) returns, so its output
// feeds these routers with no conversion. The count is the half that a bare
// `Record<string, number>` ranking throws away — and without it a router cannot
// tell `1.0 from one sample` from `0.99 from ten thousand`.
export interface ArmStats {
  key: string;
  /** Mean reward. Higher = better. */
  rank: number;
  /** How many outcomes produced `rank`. */
  count: number;
}

/** Rankings with counts (preferred) or the legacy count-free record. */
export type Rankings = Record<string, number> | readonly ArmStats[];

interface Arm {
  rank: number;
  /** undefined when the caller supplied a count-free `Record<string, number>`. */
  count?: number;
}

function indexRankings(rankings: Rankings): Map<string, Arm> {
  if (Array.isArray(rankings)) {
    const m = new Map<string, Arm>();
    for (const s of rankings as readonly ArmStats[]) m.set(s.key, { rank: s.rank, count: s.count });
    return m;
  }
  const m = new Map<string, Arm>();
  for (const [key, rank] of Object.entries(rankings as Record<string, number>))
    m.set(key, { rank });
  return m;
}

export interface RankedRouterOptions {
  /**
   * Sample floor. Arms with fewer than this many outcomes are treated as UNRANKED
   * rather than as evidence — the fix for "one lucky success at n=1 outranks a
   * proven arm at n=10000 forever". Requires `ArmStats[]`; a count-free record
   * throws at construction rather than silently no-opping the floor.
   */
  minSamples?: number;
  /** Router for unranked/under-sampled requests. Default: cheap-first `tagRouter`. */
  fallback?: Router;
}

// M10 self-optimization — a "learned" router. Given a ranking (e.g. from
// @loom/analytics `rankModels`/`outcomeAnalytics`, mined from historical logs),
// prefer the highest-ranked route that exists, falling back to cheap-first
// (`tagRouter`) for unranked requests. Used inside ReasoningRuntime with
// `ctx.decide`, its choice is recorded as a durable decision (P9) — auditable and
// override-able, never silently autonomous (P10).
//
// PURE EXPLOIT. This router never tries an arm to learn about it: an arm absent
// from `rankings` can never be selected while any other arm is ranked, so a
// ranking mined from a log that this router itself produced will narrow over time
// (the arms it stops choosing stop generating outcomes). `minSamples` bounds the
// damage from thin evidence, but if you want the loop to keep learning, wrap it —
// `epsilonGreedy(rankedRouter(stats), { epsilon: 0.1 })` — or use `ucb1`, which
// allocates exploration by uncertainty instead of by coin flip.
export function rankedRouter(rankings: Rankings, opts: RankedRouterOptions = {}): Router {
  // Index the ranking once at construction; each select is then a single O(R)
  // max-scan instead of an O(R log R) filter+sort per call (routing decisions
  // are on the reasoning hot path). Ties keep the tier-ascending order the
  // caller passes — the first route holding the max rank wins, which is exactly
  // what a stable sort's `[0]` yielded.
  const rank = indexRankings(rankings);
  const minSamples = opts.minSamples ?? 0;
  const fallback = opts.fallback ?? tagRouter;

  if (minSamples > 0) {
    for (const arm of rank.values()) {
      if (arm.count === undefined) {
        throw new Error(
          "rankedRouter: minSamples needs sample counts — pass ArmStats[] " +
            "(e.g. outcomeAnalytics(events)), not a count-free rankings record"
        );
      }
    }
  }

  return {
    select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute {
      let best: ModelRoute | undefined;
      let bestRank = Number.NEGATIVE_INFINITY;
      for (const r of routes) {
        const arm = rank.get(r.id);
        if (arm === undefined) continue;
        if (arm.count !== undefined && arm.count < minSamples) continue;
        if (arm.rank > bestRank) {
          bestRank = arm.rank;
          best = r;
        }
      }
      return best ?? fallback.select(req, routes);
    },
  };
}

export interface Ucb1Options {
  /** Exploration weight. 1 = textbook UCB1; lower is greedier, 0 is pure exploit. */
  exploration?: number;
  /** Router for the cold start (no samples at all). Default: cheap-first `tagRouter`. */
  fallback?: Router;
}

// UCB1 — the principled fix for the ranked router's collapse, and the recommended
// default for a live learning loop. Scores each arm `mean + c·sqrt(2·ln N / n)`:
// the bonus is large while an arm is under-sampled and shrinks as evidence
// accumulates, so a lucky n=1 arm cannot pin the router (its rivals keep their own
// large bonus until they are tried too) and an arm with NO samples scores +Inf and
// is guaranteed a trial. Deterministic — no RNG — which is what you want in a
// replay-first runtime: the same evidence always yields the same route.
//
// Assumes rewards on a comparable scale (the [0,1] of `success`/normalized `score`
// that `outcomeAnalytics` produces); `exploration` is the knob if yours differ.
export function ucb1(stats: readonly ArmStats[], opts: Ucb1Options = {}): Router {
  const c = opts.exploration ?? 1;
  const fallback = opts.fallback ?? tagRouter;

  // Fold the evidence once at construction — per-select work is then one O(R)
  // scan with no logarithm (`lnTotal` is loop-invariant across every select).
  const arms = new Map<string, ArmStats>();
  let total = 0;
  for (const s of stats) {
    arms.set(s.key, s);
    total += s.count;
  }
  const lnTotal = Math.log(total);

  return {
    select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute {
      if (total === 0) return fallback.select(req, routes);

      let best: ModelRoute | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const r of routes) {
        const arm = arms.get(r.id);
        // Never sampled → must-try. Ties resolve to the first route, so a cold
        // start walks the tier-ascending ladder one trial at a time.
        const score =
          arm === undefined || arm.count <= 0
            ? Number.POSITIVE_INFINITY
            : arm.rank + c * Math.sqrt((2 * lnTotal) / arm.count);
        if (score > bestScore) {
          bestScore = score;
          best = r;
        }
      }
      return best ?? fallback.select(req, routes);
    },
  };
}

export interface EpsilonGreedyOptions {
  /** Probability in [0,1] of sampling a uniformly random route instead of exploiting. */
  epsilon: number;
  /** Injected RNG (default `Math.random`). Pass a seeded PRNG for tests and DST runs. */
  rng?: () => number;
}

// ε-greedy — the simplest way to stop any exploit-only router from starving its
// own evidence: with probability ε ignore `inner` and sample a route uniformly.
//
// The randomness is replay-safe WHERE IT MATTERS: ReasoningRuntime resolves the
// route inside `ctx.decide`, so the sampled id is committed as DECISION_RECORDED
// and replay serves that recording back — `select` is never called again and the
// RNG is never re-rolled. Standalone callers (no `decide` sink) get no such
// guarantee; inject `rng` if you need them reproducible.
export function epsilonGreedy(inner: Router, opts: EpsilonGreedyOptions): Router {
  const { epsilon } = opts;
  if (!(epsilon >= 0 && epsilon <= 1)) {
    throw new Error(`epsilonGreedy: epsilon must be in [0,1], got ${epsilon}`);
  }
  const rng = opts.rng ?? Math.random;

  return {
    select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute {
      if (routes.length > 0 && rng() < epsilon) {
        const picked = routes[Math.min(routes.length - 1, Math.floor(rng() * routes.length))];
        if (picked !== undefined) return picked;
      }
      return inner.select(req, routes);
    },
  };
}

// A fixed router that always selects a specific model id — handy for tests and for
// pinning a strategy to one model.
export function fixedRouter(modelId: string): Router {
  return {
    select(_req, routes) {
      const route = routes.find((r) => r.id === modelId);
      if (route === undefined) {
        throw new Error(`ReasoningRuntime: fixedRouter target "${modelId}" not in routes`);
      }
      return route;
    },
  };
}
