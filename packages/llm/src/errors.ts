export type LlmHttpProvider = "anthropic" | "openai" | "gemini";

const LABEL: Record<LlmHttpProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
};

/**
 * Release the body of a non-2xx response without reading it: an unconsumed body keeps the
 * connection (undici) busy. Never reads the text, and a failing cancel must not mask the status.
 */
export async function drainBody(resp: Response): Promise<void> {
  await resp.body?.cancel().catch(() => undefined);
}

/**
 * A provider's HTTP API answered with a non-2xx status. `status` is what a caller should branch
 * on. The response body is deliberately NOT kept: it can echo the prompt, so it is never put in
 * the message or on the error.
 */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly provider: LlmHttpProvider;
  constructor(provider: LlmHttpProvider, status: number) {
    super(`${LABEL[provider]} API error ${status}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.provider = provider;
  }
}

/**
 * A provider reported an error INSIDE a 200 stream (Anthropic `event: error`, an OpenAI-compatible
 * `{"error": ...}` chunk). Carries only the provider and the error type or code, and only when it is
 * a plain identifier: the message text can echo the prompt, so it is never kept.
 */
export class LlmStreamError extends Error {
  readonly provider: LlmHttpProvider;
  readonly code: string;
  constructor(provider: LlmHttpProvider, code: unknown) {
    const safe = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "unknown";
    super(`${LABEL[provider]} stream error: ${safe}`);
    this.name = "LlmStreamError";
    this.provider = provider;
    this.code = safe;
  }
}
