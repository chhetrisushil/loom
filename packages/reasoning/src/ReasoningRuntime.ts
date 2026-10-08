import type { LlmResponse } from "@loom/llm";
import { assertRequestSupported, guardRequest, resolveRequestContent } from "@loom/llm";
import { stopReasonConfidence } from "./confidence";
import { tagRouter } from "./router";
import type {
  ConfidenceSignal,
  DecideFn,
  ModelInvoker,
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
  // id → position in the tier-sorted `routes`, so `byId` is O(1) not a linear scan.
  private readonly indexById: Map<string, number>;
  // For each route index, the index of the next route with a strictly higher tier
  // (or -1). Precomputed once so elevation is an O(1) hop instead of an O(n) scan.
  private readonly nextHigherIndex: number[];

  constructor(config: ReasoningRuntimeConfig) {
    if (config.routes.length === 0) {
      throw new Error("ReasoningRuntime requires at least one route");
    }
    // Sorted by tier once so elevation is a simple forward hop.
    this.routes = [...config.routes].sort((a, b) => a.tier - b.tier);
    this.router = config.router ?? tagRouter;
    this.confidence = config.confidence ?? stopReasonConfidence;
    this.threshold = config.elevateThreshold ?? 0.5;
    this.cache = config.cache;

    const n = this.routes.length;
    this.indexById = new Map(this.routes.map((r, i) => [r.id, i]));
    // Right-to-left pass (O(n)): the next strictly-higher tier for i is either its
    // neighbour i+1 (if that neighbour's tier is greater) or, when i+1 shares i's
    // tier, whatever the next-higher of i+1 already resolved to.
    this.nextHigherIndex = new Array(n).fill(-1);
    for (let i = n - 2; i >= 0; i--) {
      this.nextHigherIndex[i] =
        (this.routes[i + 1] as ModelRoute).tier > (this.routes[i] as ModelRoute).tier
          ? i + 1
          : (this.nextHigherIndex[i + 1] as number);
    }
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
    let currentIdx = this.indexOf(initialId);
    let current = this.routes[currentIdx] as ModelRoute;
    const trace: ReasoningTraceEntry[] = [];

    let res = await this.call(current, req, signal, opts);
    let confidence = await this.confidence.score(req, res);
    trace.push({ modelId: current.id, tier: current.tier, confidence, elevated: false });

    // Stage 2 — elevate while low-confidence and a higher tier is within budget.
    let step = 0;
    while (confidence < this.threshold) {
      const nextIdx = this.nextHigherIndex[currentIdx] as number;
      if (nextIdx === -1) break;
      const next = this.routes[nextIdx] as ModelRoute;
      if (next.tier > maxTier) break;
      step += 1;
      const chosenId = await decide(`reason:${key}:elevate:${step}`, () => next.id);
      currentIdx = this.indexOf(chosenId);
      current = this.routes[currentIdx] as ModelRoute;
      res = await this.call(current, req, signal, opts);
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

  private indexOf(id: string): number {
    const idx = this.indexById.get(id);
    if (idx === undefined) {
      throw new Error(`ReasoningRuntime: unknown route "${id}"`);
    }
    return idx;
  }

  private async call(
    route: ModelRoute,
    req: ReasoningRequest,
    signal: AbortSignal | undefined,
    opts: ReasonOptions
  ): Promise<LlmResponse> {
    const invoke = opts.invoke;
    if (invoke !== undefined) {
      // R9 — the host makes the call (as an effect, inside the ring). No cache: see ModelInvoker.
      // `guardRequest` still runs here, so a custom invoker that is NOT an effect cannot
      // receive tainted content either; the effect it resolves to guards again, harmlessly
      // (a guarded request is untainted, and guarding it is the identity).
      const guarded = guardRequest({
        messages: req.messages,
        ...(req.system !== undefined && { system: req.system }),
        ...(req.tools !== undefined && { tools: req.tools }),
        ...(req.maxTokens !== undefined && { maxTokens: req.maxTokens }),
        ...(req.temperature !== undefined && { temperature: req.temperature }),
      });
      return invoke(route, {
        messages: guarded.messages,
        ...(guarded.system !== undefined && { system: guarded.system }),
        ...(guarded.tools !== undefined && { tools: guarded.tools }),
        ...(guarded.maxTokens !== undefined && { maxTokens: guarded.maxTokens }),
        ...(guarded.temperature !== undefined && { temperature: guarded.temperature }),
      });
    }
    // R2 — the prompt boundary, on the reasoning path. This is the single site where
    // this runtime hands a request to a provider, so it is the one place the check
    // belongs. `ReasoningRequest` types its content as `string`, but a `string`
    // annotation is a claim, not a check: a tainted MCP tool description reaches
    // here through exactly such a field. `guardRequest` refuses taint in every
    // instruction position and returns an untainted request unchanged.
    const guarded = guardRequest({
      messages: req.messages,
      ...(req.system !== undefined && { system: req.system }),
      ...(req.tools !== undefined && { tools: req.tools }),
      ...(req.maxTokens !== undefined && { maxTokens: req.maxTokens }),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(signal !== undefined && { signal }),
    });
    // R5 — a third-party provider may not check its own modalities; this runtime does.
    assertRequestSupported(guarded, route.provider.capabilities);
    // The cache key is the request AS WRITTEN (addresses, not bytes); computed before the host's
    // wrapper so a journaled call and an unjournaled one share the same entries.
    const cacheKey = this.cache !== undefined ? this.keyFor(route.id, req) : undefined;
    const run = async (): Promise<LlmResponse> => {
      if (cacheKey !== undefined) {
        const hit = this.cache?.get(cacheKey);
        if (hit !== undefined) return hit;
      }
      // R5 — refs become bytes only now: after the capability check (a refusal must precede any
      // fetch) and after the cache lookup, whose key is the request as written.
      const res = await route.provider.complete(
        await resolveRequestContent(guarded, opts.resolveContent, {
          ...(signal !== undefined && { signal }),
          // Absent only when there is no resolver; a ref then fails before any fetch.
          context: opts.resolveContext ?? { executionId: "" },
        })
      );
      if (cacheKey !== undefined) this.cache?.set(cacheKey, res);
      return res;
    };
    return opts.wrapCall !== undefined ? opts.wrapCall(route, run) : run();
  }

  private keyFor(modelId: string, req: ReasoningRequest): string {
    return JSON.stringify({ m: modelId, s: req.system, msgs: req.messages });
  }
}
