import type { LlmResponse } from "@loom/llm";
import { stopReasonConfidence } from "./confidence";
import { tagRouter } from "./router";
import type {
  ConfidenceSignal,
  DecideFn,
  ModelRoute,
  ReasonOptions,
  ReasoningCache,
  ReasoningRequest,
  ReasoningResult,
  ReasoningRuntimeConfig,
  ReasoningTraceEntry,
  Router,
} from "./types";

// No decision sink → run the decider inline (used by standalone callers outside a
// durable flow). When a flow passes ctx.decide, the choice is recorded instead.
const identityDecide: DecideFn = (_id, decider) => Promise.resolve(decider());

// The Reasoning Runtime (P3), built as composable stages: route → call → score →
// elevate. Each route/elevation is a logged decision (P9), so replay is deterministic
// while routing can improve run-to-run. The kernel stays untouched — this is an
// optional advisory module (P10).
export class ReasoningRuntime {
  private readonly routes: ModelRoute[];
  private readonly router: Router;
  private readonly confidence: ConfidenceSignal;
  private readonly threshold: number;
  private readonly cache: ReasoningCache | undefined;

  constructor(config: ReasoningRuntimeConfig) {
    if (config.routes.length === 0) {
      throw new Error("ReasoningRuntime requires at least one route");
    }
    // Sorted by tier once so elevation is a simple forward scan.
    this.routes = [...config.routes].sort((a, b) => a.tier - b.tier);
    this.router = config.router ?? tagRouter;
    this.confidence = config.confidence ?? stopReasonConfidence;
    this.threshold = config.elevateThreshold ?? 0.5;
    this.cache = config.cache;
  }

  get availableRoutes(): ReadonlyArray<ModelRoute> {
    return this.routes;
  }

  async reason(req: ReasoningRequest, opts: ReasonOptions = {}): Promise<ReasoningResult> {
    const decide = opts.decide ?? identityDecide;
    const key = opts.decisionKey ?? req.strategy ?? "default";
    const signal = opts.signal ?? req.signal;
    const maxTier = req.maxTier ?? (this.routes[this.routes.length - 1] as ModelRoute).tier;

    // Stage 1 — route (a logged decision).
    const initialId = await decide(
      `reason:${key}:route`,
      () => this.router.select(req, this.routes).id
    );
    let current = this.byId(initialId);
    const trace: ReasoningTraceEntry[] = [];

    let res = await this.call(current, req, signal);
    let confidence = await this.confidence.score(req, res);
    trace.push({ modelId: current.id, tier: current.tier, confidence, elevated: false });

    // Stage 2 — elevate while low-confidence and a higher tier is within budget.
    let step = 0;
    while (confidence < this.threshold) {
      const next = this.routes.find((r) => r.tier > current.tier && r.tier <= maxTier);
      if (next === undefined) break;
      step += 1;
      const chosenId = await decide(`reason:${key}:elevate:${step}`, () => next.id);
      current = this.byId(chosenId);
      res = await this.call(current, req, signal);
      confidence = await this.confidence.score(req, res);
      trace.push({ modelId: current.id, tier: current.tier, confidence, elevated: true });
    }

    return {
      content: res.content,
      ...(res.toolCalls !== undefined && { toolCalls: res.toolCalls }),
      stopReason: res.stopReason,
      ...(res.usage !== undefined && { usage: res.usage }),
      modelId: current.id,
      confidence,
      elevated: trace.length > 1,
      trace,
    };
  }

  private byId(id: string): ModelRoute {
    const route = this.routes.find((r) => r.id === id);
    if (route === undefined) {
      throw new Error(`ReasoningRuntime: unknown route "${id}"`);
    }
    return route;
  }

  private async call(
    route: ModelRoute,
    req: ReasoningRequest,
    signal: AbortSignal | undefined
  ): Promise<LlmResponse> {
    const cacheKey = this.cache !== undefined ? this.keyFor(route.id, req) : undefined;
    if (cacheKey !== undefined) {
      const hit = this.cache?.get(cacheKey);
      if (hit !== undefined) return hit;
    }
    const res = await route.provider.complete({
      messages: req.messages,
      ...(req.system !== undefined && { system: req.system }),
      ...(req.tools !== undefined && { tools: req.tools }),
      ...(req.maxTokens !== undefined && { maxTokens: req.maxTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(signal !== undefined && { signal }),
    });
    if (cacheKey !== undefined) this.cache?.set(cacheKey, res);
    return res;
  }

  private keyFor(modelId: string, req: ReasoningRequest): string {
    return JSON.stringify({ m: modelId, s: req.system, msgs: req.messages });
  }
}
