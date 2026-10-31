import type {
  ContentResolveContext,
  ContentResolver,
  LlmContent,
  LlmMessageInput,
  LlmProvider,
  LlmResponse,
  LlmToolCall,
  LlmToolSpecInput,
} from "@loom/llm";

// A decision sink shaped exactly like `ExecutionContext.decide` (minus opts). When a
// flow passes `ctx.decide`, each route/elevation becomes a durable DECISION_RECORDED
// event that replay serves back (P9); standalone callers get an identity decide.
export type DecideFn = <T = unknown>(
  decisionId: string,
  decider: () => T | Promise<T>
) => Promise<T>;

// A named model endpoint in the routing registry. `tier` orders the elevation
// ladder (lower = cheaper/weaker, e.g. Gemma=0 → Flash=1 → Pro=2 → Opus=3).
export interface ModelRoute {
  id: string;
  provider: LlmProvider;
  tier: number;
  /** Strategy hints (e.g. "planning", "coding", "review") for tag-based routing. */
  tags?: string[];
}

export interface ReasoningRequest {
  // The INPUT side of the prompt boundary: content may still carry taint, because
  // `ReasoningRuntime.call` runs `guardRequest` before any provider sees it (R2).
  // Typing these as plain strings was a claim the runtime never checked — and a
  // tainted MCP tool description arrives through exactly such a field.
  messages: LlmMessageInput[];
  system?: LlmContent;
  /** Picks a route by tag and namespaces the logged decisions. */
  strategy?: string;
  tools?: LlmToolSpecInput[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Budget cap — never elevate above this tier. Default: the highest tier available. */
  maxTier?: number;
}

export interface ReasoningTraceEntry {
  modelId: string;
  tier: number;
  confidence: number;
  elevated: boolean;
}

// Superset of LlmResponse (so it is a drop-in for provider.complete callers) plus the
// route trace: which model answered, how confident, and the full elevation history.
export interface ReasoningResult {
  content: string;
  toolCalls?: LlmToolCall[];
  stopReason: LlmResponse["stopReason"];
  usage?: LlmResponse["usage"];
  /**
   * ADR 0133 - the answering route's reasoning, as the call returned it. Through an effect-backed
   * `invoke` these are recorded `LlmReasoningPart`s; a caller keeps only those (`type: "reasoning"`).
   */
  reasoning?: LlmResponse["reasoning"];
  /** ADR 0133 D5 - the answering call's block order (positions only), so a transcript can reproduce the vendor sequence. */
  layout?: LlmResponse["layout"];
  modelId: string;
  confidence: number;
  elevated: boolean;
  trace: ReasoningTraceEntry[];
}

// Pluggable confidence — deliberately NOT a magic self-reported number. Swap in
// stop-reason, validator-pass, log-prob, or ensemble-agreement signals per stakes.
export interface ConfidenceSignal {
  score(req: ReasoningRequest, res: LlmResponse): number | Promise<number>;
}

// Pluggable routing policy. The default (tagRouter) is cheap-first.
export interface Router {
  select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute;
}

// Optional in-memory response cache (a latency-only stage; does not change the
// recorded outcome). Bring your own eviction.
export interface ReasoningCache {
  get(key: string): LlmResponse | undefined;
  set(key: string, value: LlmResponse): void;
}

/**
 * The request a {@link ModelInvoker} receives: the reasoning request minus the routing-only
 * fields and minus `signal` (a signal is not data — an effect-backed invoker gets its
 * cancellation from the effect context, not from here).
 */
export interface ModelCallRequest {
  messages: LlmMessageInput[];
  system?: LlmContent;
  tools?: LlmToolSpecInput[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * R9 — how a chosen route's model call is MADE. Without one, the runtime calls
 * `route.provider.complete` directly, which is outside the effect ring (no K2 authorization,
 * no metering, no kill switch). Supplying an invoker hands the call to the host so it can run
 * as an effect: `agentLoop$` passes one that resolves each call through `ctx.execute`, so the
 * call is authorized, metered, kill-switched and `guardRequest`-checked, and is JOURNALED —
 * a replay serves the recorded response instead of re-calling the model.
 *
 * The runtime's response cache is BYPASSED when an invoker is supplied: a cache hit would skip
 * the invoker, so whether a durable frame exists would depend on a process-local cache and a
 * replay could diverge from the run.
 */
export type ModelInvoker = (route: ModelRoute, request: ModelCallRequest) => Promise<LlmResponse>;

export interface ReasonOptionsBase {
  /** When provided, route/elevation choices are recorded through it (P9). */
  decide?: DecideFn;
  /** R9 — make each model call through the host instead of the route's provider. See {@link ModelInvoker}. */
  invoke?: ModelInvoker;
  /**
   * R10 — partition the response cache. The cache key is the request as written plus the route; two
   * callers with an identical prompt would otherwise share a cached response. The runtime already
   * adds the `resolveContext.principal` identity (tenant, actor, onBehalfOf) when it has one; a host
   * that cannot hand over a principal (a runner body cannot read its own) passes a stable scope
   * string here, e.g. the tenant id. Unset on a single-tenant host = one shared cache, as before.
   *
   * NOTE on metering: a cache hit makes no provider call, so on the direct path (no effect ring) it
   * is not metered. That is the cache's purpose; a host that must meter every request routes the
   * call through an effect (`invoke`), which bypasses this cache.
   */
  cacheScope?: string;
  /**
   * R10 — journal the live provider call. Unlike {@link invoke} (which REPLACES the call so the host
   * can run it as an effect), this wraps it: the runtime still guards the request, checks the route's
   * modalities and keys its response cache on the request as written, and hands the host only the
   * part that touches the network (cache lookup, content resolution, `provider.complete`, cache
   * fill) as `run`. The host records `run`'s result (`ctx.decide`) so a replay serves it and `run` is
   * never called. Ignored when `invoke` is set.
   */
  wrapCall?: (route: ModelRoute, run: () => Promise<LlmResponse>) => Promise<LlmResponse>;
  signal?: AbortSignal;
  /** Namespaces decision ids so multiple reason() calls in one execution don't collide. */
  decisionKey?: string;
}

/**
 * R5 — fetch the bytes behind a media `ref` for the DIRECT (non-`invoke`) path, after the chosen
 * route's capabilities have been checked and after the cache lookup (the cache is keyed on the
 * request as written, i.e. on addresses, never on resolved bytes). Without it a ref is refused.
 *
 * `resolveContent` and `resolveContext` come TOGETHER (the type makes one without the other an
 * error): the context is what lets a store authorize the read, and a resolver MUST deny a read whose
 * `executionId` / `principal` it cannot attribute.
 */
export type ReasonOptions = ReasonOptionsBase &
  (
    | { resolveContent?: undefined; resolveContext?: undefined }
    | {
        resolveContent: ContentResolver;
        resolveContext: Pick<
          ContentResolveContext,
          "executionId" | "workflowId" | "stepId" | "principal"
        >;
      }
  );

export interface ReasoningRuntimeConfig {
  routes: ModelRoute[];
  router?: Router;
  confidence?: ConfidenceSignal;
  /** Elevate while confidence < threshold and a higher tier is available. Default 0.5. */
  elevateThreshold?: number;
  cache?: ReasoningCache;
}
