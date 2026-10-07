import type { LlmContentRef, LlmMediaPart, LlmResultPart } from "./parts";
import type { LlmMessage, LlmRequest } from "./types";

// ── R5 — resolving claim-checked media at call time ──────────────────────────
//
// The journaled model-call input carries `{ kind: "ref", ref: { address } }`; the bytes
// are fetched HERE, inside the effect handler, immediately before the provider call. A
// replayed call is served from the log and never reaches this, so replay neither needs
// the bytes nor changes if they are erased afterwards (crypto-shred / GC leave recorded
// history intact; only a LIVE call needs them, and an absent blob is a loud failure).

/** Fetch a blob by address. `null` means erased/absent (never throw for absence). */
export type ContentResolver = (
  ref: LlmContentRef,
  signal?: AbortSignal
) => Promise<Uint8Array | null>;

/** A `ref` source reached a provider (or the effect) with no resolver able to turn it into bytes. */
export class UnresolvedContentError extends Error {
  readonly address: string;
  constructor(address: string, reason: string) {
    super(`Cannot resolve content "${address}": ${reason}`);
    this.name = "UnresolvedContentError";
    this.address = address;
  }
}

/** Default cap on the TOTAL resolved media bytes in one request (providers cap well below this). */
export const MAX_RESOLVED_BYTES = 32 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function isMedia(p: { type: string }): p is LlmMediaPart {
  return p.type === "image" || p.type === "audio" || p.type === "file";
}

/** Distinct refs in the request, in first-seen order. */
function collectRefs(messages: readonly LlmMessage[]): Map<string, LlmContentRef> {
  const refs = new Map<string, LlmContentRef>();
  const visit = (p: { type: string }): void => {
    if (isMedia(p) && p.source.kind === "ref") refs.set(p.source.ref.address, p.source.ref);
  };
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type === "tool_result" && typeof p.content !== "string") p.content.forEach(visit);
      else visit(p);
    }
  }
  return refs;
}

/**
 * Replace every `ref` source with inline base64 `data`, fetching each distinct address
 * once and concurrently. Returns the request unchanged (same object) when it has no refs.
 * Refuses, naming the address, when there is no resolver, a blob is absent, or the total
 * would exceed `maxBytes`.
 */
export async function resolveRequestContent(
  request: LlmRequest,
  resolver: ContentResolver | undefined,
  options: { maxBytes?: number; signal?: AbortSignal } = {}
): Promise<LlmRequest> {
  const refs = collectRefs(request.messages);
  if (refs.size === 0) return request;
  const first = refs.keys().next().value as string;
  if (resolver === undefined) {
    throw new UnresolvedContentError(
      first,
      "the request references stored content but no `resolveContent` is configured"
    );
  }
  const limit = options.maxBytes ?? MAX_RESOLVED_BYTES;
  // Declared sizes are informational, but a ref that ADMITS to being too big is refused
  // before a single byte is fetched.
  let declared = 0;
  for (const r of refs.values()) declared += r.size ?? 0;
  if (declared > limit) {
    throw new UnresolvedContentError(
      first,
      `declared media totals ${declared} bytes, over the ${limit}-byte cap`
    );
  }
  let total = 0;
  const entries = await Promise.all(
    [...refs.values()].map(async (ref) => {
      const bytes = await resolver(ref, options.signal);
      if (bytes === null) {
        throw new UnresolvedContentError(
          ref.address,
          "the content is absent (erased or never stored)"
        );
      }
      return [ref.address, toBase64(bytes), bytes.byteLength] as const;
    })
  );
  const data = new Map<string, string>();
  for (const [address, b64, n] of entries) {
    total += n;
    data.set(address, b64);
  }
  if (total > limit) {
    throw new UnresolvedContentError(
      first,
      `resolved media totals ${total} bytes, over the ${limit}-byte cap`
    );
  }
  const inline = <T extends { type: string }>(p: T): T =>
    isMedia(p) && p.source.kind === "ref"
      ? ({ ...p, source: { kind: "data", data: data.get(p.source.ref.address) as string } } as T)
      : p;
  const messages: LlmMessage[] = request.messages.map((m) => {
    if (typeof m.content === "string") return m;
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === "tool_result" && typeof p.content !== "string"
          ? { ...p, content: p.content.map(inline) as LlmResultPart[] }
          : inline(p)
      ),
    };
  });
  return { ...request, messages };
}

/**
 * The base64 bytes of a media part for a provider mapper. A provider only ever sees
 * `data` sources (the effect resolves refs first); a `ref` here means it was called
 * directly with an unresolved request, which fails closed rather than sending nothing.
 */
export function inlineData(p: LlmMediaPart): string {
  if (p.source.kind === "data") return p.source.data;
  throw new UnresolvedContentError(
    p.source.ref.address,
    "providers accept inline media only — resolve refs via createLlmEffect({ resolveContent })"
  );
}
