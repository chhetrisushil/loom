import type { ModelRoute, ReasoningRequest, Router } from "./types";

// Default routing policy: the lowest-tier route whose tags include the request's
// strategy, else the lowest-tier route overall. This implements "use the cheap
// model first; elevate only when confidence is low" (the P3 elevation ladder).
export const tagRouter: Router = {
  select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute {
    const sorted = [...routes].sort((a, b) => a.tier - b.tier);
    if (req.strategy !== undefined) {
      const tagged = sorted.find((r) => r.tags?.includes(req.strategy as string));
      if (tagged !== undefined) return tagged;
    }
    const first = sorted[0];
    if (first === undefined) {
      throw new Error("ReasoningRuntime: no routes configured");
    }
    return first;
  },
};

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
