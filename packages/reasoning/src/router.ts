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

// M10 self-optimization — a "learned" router. Given a ranking (e.g. from
// @loom/analytics `rankModels`, mined from historical logs), prefer the
// highest-ranked route that exists, falling back to cheap-first (`tagRouter`) for
// unranked requests. Used inside ReasoningRuntime with `ctx.decide`, its choice is
// recorded as a durable decision (P9) — auditable and override-able, never silently
// autonomous (P10).
export function rankedRouter(rankings: Record<string, number>): Router {
  // Index the ranking once at construction; each select is then a single O(R)
  // max-scan instead of an O(R log R) filter+sort per call (routing decisions
  // are on the reasoning hot path). Ties keep the tier-ascending order the
  // caller passes — the first route holding the max rank wins, which is exactly
  // what a stable sort's `[0]` yielded.
  const rank = new Map(Object.entries(rankings));
  return {
    select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute {
      let best: ModelRoute | undefined;
      let bestRank = Number.NEGATIVE_INFINITY;
      for (const r of routes) {
        const value = rank.get(r.id);
        if (value !== undefined && value > bestRank) {
          bestRank = value;
          best = r;
        }
      }
      return best ?? tagRouter.select(req, routes);
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
