import type {
  LlmContent,
  LlmMessage,
  LlmMessageInput,
  LlmProvider,
  LlmResponse,
  LlmToolCall,
  LlmToolSpec,
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

export interface ReasonOptions {
  /** When provided, route/elevation choices are recorded through it (P9). */
  decide?: DecideFn;
  signal?: AbortSignal;
  /** Namespaces decision ids so multiple reason() calls in one execution don't collide. */
  decisionKey?: string;
}

export interface ReasoningRuntimeConfig {
  routes: ModelRoute[];
  router?: Router;
  confidence?: ConfidenceSignal;
  /** Elevate while confidence < threshold and a higher tier is available. Default 0.5. */
  elevateThreshold?: number;
  cache?: ReasoningCache;
}
