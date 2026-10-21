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
  /** Set to `false` for a 3xx (a redirect, never followed): retrying cannot help. */
  readonly retryable?: false;
  constructor(provider: LlmHttpProvider, status: number) {
    super(`${LABEL[provider]} API error ${status}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.provider = provider;
    // A redirect is never followed (it would re-send the body and credentials elsewhere), and
    // asking again changes nothing: the base URL is misconfigured or the path is intercepted.
    if (status >= 300 && status < 400) this.retryable = false;
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
/**
 * Default cap on the TOTAL bytes of a stream. Much larger than the complete-body cap: an SSE
 * chunk is ~250-300 B per token on the wire, so a long answer legitimately needs tens of MiB, and
 * memory is bounded by the per-line cap, not by this.
 */
export const DEFAULT_MAX_STREAM_BYTES = 128 * 1024 * 1024;
/** Default cap on one line of a stream, in UTF-8 bytes. */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

/** UTF-8 byte length of a string, without allocating. */
function utf8Length(str: string): number {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export type LlmResponseLimitReason = "body" | "stream" | "line";

/**
 * A provider's response exceeded the configured size cap (`maxResponseBytes` / `maxStreamBytes` / `maxLineBytes`).
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

/**
 * A 2xx response whose body is not valid JSON. Fixed message, no `cause`: the parser's own error
 * quotes the start of the body, which can hold anything the endpoint sent.
 */
export class LlmResponseInvalidError extends Error {
  readonly provider: LlmHttpProvider;
  constructor(provider: LlmHttpProvider) {
    super(`${LABEL[provider]} response is not valid JSON`);
    this.name = "LlmResponseInvalidError";
    this.provider = provider;
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
  if (!resp.body) {
    try {
      return await resp.json();
    } catch {
      throw new LlmResponseInvalidError(provider);
    }
  }
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
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new LlmResponseInvalidError(provider);
  }
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
    // UTF-8 is at most 3 bytes per UTF-16 unit: only measure what could be over the cap.
    const over = (l: string) => l.length * 3 > this.maxLine && utf8Length(l) > this.maxLine;
    if (over(rest)) throw new LlmResponseLimitError(this.provider, "line");
    for (const l of lines) if (over(l)) throw new LlmResponseLimitError(this.provider, "line");
  }
}
