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

/** Default cap on a complete response body (bytes), and on the total bytes of a stream. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Default cap on one line of a stream (bytes/characters). */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

export type LlmResponseLimitReason = "body" | "stream" | "line";

/**
 * A provider's response exceeded the configured size cap (`maxResponseBytes` / `maxLineBytes`).
 * Carries only the provider and which limit was hit: never any of the body.
 */
export class LlmResponseLimitError extends Error {
  readonly provider: LlmHttpProvider;
  readonly reason: LlmResponseLimitReason;
  constructor(provider: LlmHttpProvider, reason: LlmResponseLimitReason) {
    super(`${LABEL[provider]} response too large (${reason})`);
    this.name = "LlmResponseLimitError";
    this.provider = provider;
    this.reason = reason;
  }
}

/** Reject a non-positive or non-integer cap at construction. */
export function resolveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/**
 * Read a complete JSON body with a byte cap. Over the cap the body is cancelled and an
 * {@link LlmResponseLimitError} is thrown (no body text). Streams the bytes, so a hostile endpoint
 * cannot make the process buffer more than the cap (plus one chunk).
 */
export async function readBoundedJson(
  resp: Response,
  provider: LlmHttpProvider,
  maxBytes: number
): Promise<unknown> {
  const declared = Number(resp.headers?.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drainBody(resp);
    throw new LlmResponseLimitError(provider, "body");
  }
  // No stream to read (an empty body, or a non-network `Response` stand-in): nothing to bound.
  if (!resp.body) return resp.json();
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LlmResponseLimitError(provider, "body");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

/** Byte and line accounting for an SSE stream; each check throws {@link LlmResponseLimitError}. */
export class StreamLimiter {
  private total = 0;
  constructor(
    private readonly provider: LlmHttpProvider,
    private readonly maxBytes: number,
    private readonly maxLine: number
  ) {}
  chunk(value: Uint8Array): void {
    this.total += value.byteLength;
    if (this.total > this.maxBytes) throw new LlmResponseLimitError(this.provider, "stream");
  }
  /** `lines` are the complete lines of this chunk, `rest` the unfinished tail. */
  lines(lines: readonly string[], rest: string): void {
    if (rest.length > this.maxLine) throw new LlmResponseLimitError(this.provider, "line");
    for (const l of lines)
      if (l.length > this.maxLine) throw new LlmResponseLimitError(this.provider, "line");
  }
}
