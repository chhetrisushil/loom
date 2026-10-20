import type { LlmContentPart, LlmMediaPart, LlmModality } from "./parts";
import type { LlmRequest } from "./types";

// ── R5 — what a provider accepts, declared, and refused before the wire ─────

/**
 * The media types a provider accepts for one modality: a list of exact types
 * (`image/png`), type wildcards (`image/*`), or `"*"` for any.
 */
export type MediaTypeSet = readonly string[];

/** Text and tool calls are always supported; media is opt-in per modality. */
export interface LlmCapabilities {
  image?: MediaTypeSet;
  audio?: MediaTypeSet;
  file?: MediaTypeSet;
  /** ADR 0133 - the provider can return model reasoning. Drives the boot warning when no reasoning store is configured. */
  reasoning?: boolean;
}

/** Thrown, before any network call, when a request carries a modality the provider did not declare. */
export class UnsupportedModalityError extends Error {
  readonly modality: LlmModality;
  readonly mediaType: string;
  readonly provider: string | undefined;
  constructor(modality: LlmModality, mediaType: string, provider?: string) {
    super(
      `${provider ?? "This LLM provider"} does not accept ${modality} content of type "${mediaType}" (not in its declared capabilities). The request was refused before any network call.`
    );
    this.name = "UnsupportedModalityError";
    this.modality = modality;
    this.mediaType = mediaType;
    this.provider = provider;
  }
}

export function mediaTypeAccepted(set: MediaTypeSet | undefined, mediaType: string): boolean {
  if (set === undefined) return false;
  const mt = mediaType.toLowerCase();
  for (const allowed of set) {
    if (allowed === "*" || allowed.toLowerCase() === mt) return true;
    if (allowed.endsWith("/*") && mt.startsWith(allowed.slice(0, -1).toLowerCase())) return true;
  }
  return false;
}

function* mediaParts(parts: readonly LlmContentPart[]): Generator<LlmMediaPart> {
  for (const p of parts) {
    if (p.type === "image" || p.type === "audio" || p.type === "file") yield p;
    else if (p.type === "tool_result" && typeof p.content !== "string") {
      for (const r of p.content) if (r.type !== "text") yield r;
    }
  }
}

/** Every media part in a request, in order (including those inside `tool_result`s). */
export function* requestMediaParts(request: Pick<LlmRequest, "messages">): Generator<LlmMediaPart> {
  for (const m of request.messages) {
    if (typeof m.content !== "string") yield* mediaParts(m.content);
  }
}

/**
 * Refuse a request that uses a modality / media type the provider has not declared.
 * Pure and cheap (one walk); providers call it at the top of `complete` / `stream` and
 * `createLlmEffect` calls it before resolving any content, so the refusal precedes
 * every byte of I/O.
 */
export function assertRequestSupported(
  request: Pick<LlmRequest, "messages">,
  capabilities: LlmCapabilities | undefined,
  provider?: string
): void {
  for (const p of requestMediaParts(request)) {
    if (!mediaTypeAccepted(capabilities?.[p.type], p.mediaType)) {
      throw new UnsupportedModalityError(p.type, p.mediaType, provider);
    }
  }
}

/**
 * The modalities a shipped provider declares for `model`: an ALLOWLIST. `base` only when the id
 * matches a family known to take media (`allow`); every other id — unknown, older, a local alias —
 * declares nothing, so a model that cannot take an image is refused locally instead of 400'd by the
 * API, and a new family needs one line here before it is trusted with media. `config.capabilities`
 * always wins (`capabilities: {}` = text-only). A provider on a non-default `baseUrl` (an
 * OpenAI-compatible server) declares nothing either, since the model id says nothing about what is
 * behind it; pass `capabilities` to turn media on.
 */
export function capabilitiesForModel(
  model: string,
  base: LlmCapabilities,
  allow: readonly RegExp[]
): LlmCapabilities {
  return allow.some((re) => re.test(model)) ? base : {};
}
