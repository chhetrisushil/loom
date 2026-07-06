import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

/** A serializable record of LLM request→response pairs. Persist it as JSON. */
export interface LlmCassette {
  entries: Array<{ key: string; response: LlmResponse }>;
}

export function emptyCassette(): LlmCassette {
  return { entries: [] };
}

/**
 * A stable, deterministic key for an LLM request — excludes the non-serializable
 * `signal`. No `Math.random`/time, so the same request always maps to the same
 * cassette entry (replay-stable).
 */
export function hashRequest(request: LlmRequest): string {
  const normalized = {
    system: request.system ?? null,
    messages: request.messages,
    tools: request.tools ?? null,
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
  };
  return fnv1a(JSON.stringify(normalized));
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Wrap a real provider so calls are recorded into `cassette` (VCR-style): a cache
 * miss calls the real provider once and stores the response; a hit replays it.
 * Record a test once against a live model, persist the cassette, then switch to
 * {@link replayingProvider} for deterministic, offline reruns.
 */
export function recordingProvider(real: LlmProvider, cassette: LlmCassette): LlmProvider {
  // Index by key once (O(n)) so each lookup is O(1) — recording N calls is O(n),
  // not O(n²). The entries array stays the serialized source of truth.
  const index = new Map(cassette.entries.map((e) => [e.key, e.response]));
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const key = hashRequest(request);
      const hit = index.get(key);
      if (hit !== undefined) return hit;
      const response = await real.complete(request);
      cassette.entries.push({ key, response });
      index.set(key, response);
      return response;
    },
  };
}

/** Replay LLM responses from a cassette; a request with no recorded entry throws. */
export function replayingProvider(cassette: LlmCassette): LlmProvider {
  const index = new Map(cassette.entries.map((e) => [e.key, e.response]));
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const key = hashRequest(request);
      const hit = index.get(key);
      if (hit === undefined) {
        throw new Error(`replayingProvider: no cassette entry for request (key ${key})`);
      }
      return hit;
    },
  };
}
