export type LlmHttpProvider = "anthropic" | "openai" | "gemini";

const LABEL: Record<LlmHttpProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
};

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
