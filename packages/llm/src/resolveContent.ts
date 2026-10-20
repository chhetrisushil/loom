import type { PrincipalChain } from "@loom/effect-runtime";
import type {
  LlmContentPart,
  LlmContentRef,
  LlmMediaPart,
  LlmReasoningPart,
  LlmResultPart,
} from "./parts";
import { reasoningDigest } from "./reasoning";
import type { LlmMessage, LlmRequest } from "./types";
import { validRefSize } from "./untrusted";

// ── R5 — resolving claim-checked media at call time ──────────────────────────
//
// The journaled model-call input carries `{ kind: "ref", ref: { address } }`; the bytes
// are fetched HERE, inside the effect handler, immediately before the provider call. A
// replayed call is served from the log and never reaches this, so replay neither needs
// the bytes nor changes if they are erased afterwards (crypto-shred / GC leave recorded
// history intact; only a LIVE call needs them, and an absent blob is a loud failure).

/**
 * What a resolver is told about the call it is serving — enough for a store to AUTHORIZE the read.
 *
 * **A resolver MUST authorize the ref.** The ContentStore is content-addressed and has no tenancy:
 * whoever can name an address can read its bytes. `executionId` / `principal` identify who is asking;
 * a store shared across tenants must check them (typically against the execution that wrote the blob)
 * rather than serving any address it is handed. `origin: "tool"` marks a ref that came out of a tool
 * result (a tool's output is data from outside the prompt author), `"app"` one the application put in
 * a message itself. A ref named by an untrusted party never reaches a resolver: the guard refuses it.
 */
export interface ContentResolveContext {
  readonly executionId: string;
  readonly stepId?: string;
  readonly principal?: PrincipalChain;
  readonly origin: "tool" | "app" | "reasoning";
  /** Bytes still available under the request's budget; return fewer, or `null`/throw, rather than exceed it. */
  readonly maxBytes: number;
  /** Aborts when the call is cancelled or the request's byte budget is already spent. */
  readonly signal?: AbortSignal;
}

/** Fetch a blob by address. `null` means erased/absent (never throw for absence). */
export type ContentResolver = (
  ref: LlmContentRef,
  context: ContentResolveContext
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
/** How many blobs are fetched at once; a spent budget stops the rest from starting. */
const FETCH_CONCURRENCY = 4;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function isMedia(p: { type: string }): p is LlmMediaPart {
  return p.type === "image" || p.type === "audio" || p.type === "file";
}

interface RefUse {
  ref: LlmContentRef;
  /** True when at least one use sits inside a `tool_result` (a tool-originated ref). */
  tool: boolean;
}

/** Distinct refs in the request, in first-seen order. */
function collectRefs(messages: readonly LlmMessage[]): Map<string, RefUse> {
  const refs = new Map<string, RefUse>();
  const visit = (p: { type: string }, tool: boolean): void => {
    if (!isMedia(p) || p.source.kind !== "ref") return;
    const prior = refs.get(p.source.ref.address);
    // An address used both ways is held to the stricter (app-supplied) rule: failing it fails the call.
    refs.set(p.source.ref.address, { ref: p.source.ref, tool: tool && (prior?.tool ?? true) });
  };
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type === "tool_result" && typeof p.content !== "string") {
        for (const r of p.content) visit(r, true);
      } else visit(p, false);
    }
  }
  return refs;
}

type Fetched = { ok: true; b64: string; bytes: number } | { ok: false; reason: string };

/**
 * Replace every `ref` source with inline base64 `data`, fetching each distinct address once.
 * Returns the request unchanged (same object) when it has no refs.
 *
 * The byte budget is a RUNNING one: fetches start at most {@link FETCH_CONCURRENCY} at a time, each is
 * told what is left, and the first to push the total over `maxBytes` aborts the rest (their signal
 * fires and no queued fetch starts). A blob whose actual size differs from the size its ref declares
 * is refused. Overshoot is bounded, not zero: at most {@link FETCH_CONCURRENCY} fetches are in flight when
 * the budget is spent, so a resolver that ignores `maxBytes` can hold at most that many blobs before the
 * abort lands. Resolvers SHOULD honour `maxBytes` (return `null` or throw rather than read more).
 * A failure — absent, over budget, size mismatch, a throwing resolver — for a ref that
 * sits inside a `tool_result` does NOT fail the call: the part becomes a text error and the
 * `tool_result` is marked `isError`, so the model sees that the tool's media is unavailable and can
 * carry on (the agent loop feeds a tool failure back the same way). The same failure for a ref the
 * application put in a message itself throws {@link UnresolvedContentError}: the app asked for that
 * content, so continuing without it would answer a different question.
 */
export async function resolveRequestContent(
  request: LlmRequest,
  resolver: ContentResolver | undefined,
  options: {
    maxBytes?: number;
    signal?: AbortSignal;
    /** REQUIRED: who is asking. A resolver cannot authorize a read it cannot attribute. */
    context: Pick<ContentResolveContext, "executionId" | "stepId" | "principal">;
    /**
     * ADR 0133 D5 - how an assistant `reasoning` part's `textRef` is read. Defaults to `resolver`.
     * A request with no reasoning parts never calls it.
     */
    reasoningResolver?: ContentResolver;
  }
): Promise<LlmRequest> {
  const withReasoning = await resolveReasoningParts(
    request,
    options.reasoningResolver ?? resolver,
    options
  );
  return resolveMediaRefs(withReasoning, resolver, options);
}

const REASONING_FETCH_CAP = 8 * 1024 * 1024;

/**
 * ADR 0133 D5 (the drop rule for UNRESOLVABLE parts) - resolve each assistant reasoning part's
 * `textRef`, check its digest, and put the text on the part for the provider to map back unchanged.
 * A part whose text cannot be reproduced (blob absent or erased, digest or size mismatch, a failing
 * or missing resolver, or readable text that was never stored) is dropped TOGETHER WITH every
 * reasoning part after it, across later messages too: a provider's signature covers everything
 * before the block, so a block after a hole is no longer valid. A pure function of the request and
 * the resolver's answers. A call's own `tool_use.signature` is never touched. Returns the request
 * unchanged (same object) when it has no reasoning parts.
 */
async function resolveReasoningParts(
  request: LlmRequest,
  resolver: ContentResolver | undefined,
  options: {
    signal?: AbortSignal;
    context: Pick<ContentResolveContext, "executionId" | "stepId" | "principal">;
  }
): Promise<LlmRequest> {
  const addresses = new Map<string, LlmReasoningPart>();
  for (const m of request.messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content) {
      if (p.type === "reasoning" && p.textRef !== undefined && !addresses.has(p.textRef.address)) {
        addresses.set(p.textRef.address, p);
      }
    }
  }
  const hasReasoning = request.messages.some(
    (m) => typeof m.content !== "string" && m.content.some((p) => p.type === "reasoning")
  );
  if (!hasReasoning) return request;

  // address -> verified text, or undefined when it cannot be reproduced.
  const texts = new Map<string, string | undefined>();
  if (resolver !== undefined) {
    const queue = [...addresses.values()];
    const worker = async (): Promise<void> => {
      for (let part = queue.shift(); part !== undefined; part = queue.shift()) {
        const ref = part.textRef as LlmContentRef;
        try {
          const bytes = await resolver(ref, {
            executionId: options.context.executionId,
            ...(options.context.stepId !== undefined && { stepId: options.context.stepId }),
            ...(options.context.principal !== undefined && {
              principal: options.context.principal,
            }),
            origin: "reasoning",
            maxBytes: REASONING_FETCH_CAP,
            ...(options.signal !== undefined && { signal: options.signal }),
          });
          const ok =
            bytes !== null &&
            part.digest !== undefined &&
            reasoningDigest(bytes) === part.digest &&
            (ref.size === undefined || bytes.byteLength === ref.size);
          texts.set(ref.address, ok ? new TextDecoder().decode(bytes) : undefined);
        } catch {
          texts.set(ref.address, undefined);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
    // A cancelled call is a cancelled call, not a missing blob.
    if (options.signal?.aborted === true) throw options.signal.reason ?? new Error("aborted");
  }

  let dropping = false;
  const messages: LlmMessage[] = request.messages.map((m) => {
    if (typeof m.content === "string") return m;
    if (!m.content.some((p) => p.type === "reasoning")) return m;
    const kept: LlmContentPart[] = [];
    for (const p of m.content) {
      if (p.type !== "reasoning") {
        kept.push(p);
        continue;
      }
      if (dropping) continue;
      if (p.omitted === true) {
        dropping = true;
        continue;
      }
      if (p.textRef === undefined) {
        kept.push(p);
        continue;
      }
      const text = texts.get(p.textRef.address);
      if (text === undefined) {
        dropping = true;
        continue;
      }
      kept.push({ ...p, text });
    }
    // Providers reject an empty assistant turn; keep the shape `assistantMessageOf` gives one.
    return { ...m, content: kept.length > 0 ? kept : [{ type: "text", text: "" }] };
  });
  return { ...request, messages };
}

async function resolveMediaRefs(
  request: LlmRequest,
  resolver: ContentResolver | undefined,
  options: {
    maxBytes?: number;
    signal?: AbortSignal;
    context: Pick<ContentResolveContext, "executionId" | "stepId" | "principal">;
  }
): Promise<LlmRequest> {
  const refs = collectRefs(request.messages);
  if (refs.size === 0) return request;
  const first = refs.keys().next().value as string;
  if (typeof options.context?.executionId !== "string" || options.context.executionId === "") {
    throw new UnresolvedContentError(
      first,
      "no execution identity was supplied for the read; a resolver cannot authorize a read it cannot attribute"
    );
  }
  for (const { ref } of refs.values()) {
    if (!validRefSize(ref.size)) {
      throw new UnresolvedContentError(
        ref.address,
        "its declared size is not a non-negative safe integer"
      );
    }
  }
  if (resolver === undefined) {
    throw new UnresolvedContentError(
      first,
      "the request references stored content but no `resolveContent` is configured"
    );
  }
  const limit = options.maxBytes ?? MAX_RESOLVED_BYTES;
  // Declared sizes are informational (and a ref can lie), but a ref that ADMITS to being too big is
  // refused before a single byte is fetched.
  let declared = 0;
  for (const { ref } of refs.values()) declared += ref.size ?? 0;
  if (declared > limit) {
    throw new UnresolvedContentError(
      first,
      `declared media totals ${declared} bytes, over the ${limit}-byte cap`
    );
  }

  const budget = new AbortController();
  const onOuterAbort = (): void => budget.abort(options.signal?.reason);
  if (options.signal?.aborted === true) onOuterAbort();
  else options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const results = new Map<string, Fetched>();
  let used = 0;
  const queue = [...refs.values()];
  const worker = async (): Promise<void> => {
    for (;;) {
      const use = queue.shift();
      if (use === undefined || budget.signal.aborted) return;
      const { ref } = use;
      try {
        const bytes = await resolver(ref, {
          executionId: options.context.executionId,
          ...(options.context.stepId !== undefined && { stepId: options.context.stepId }),
          ...(options.context.principal !== undefined && { principal: options.context.principal }),
          origin: use.tool ? "tool" : "app",
          maxBytes: Math.max(0, limit - used),
          signal: budget.signal,
        });
        if (bytes === null) {
          results.set(ref.address, {
            ok: false,
            reason: "the content is absent (erased or never stored)",
          });
        } else if (ref.size !== undefined && bytes.byteLength !== ref.size) {
          results.set(ref.address, {
            ok: false,
            reason: `the content is ${bytes.byteLength} bytes but its ref declares ${ref.size}`,
          });
        } else {
          used += bytes.byteLength;
          if (used > limit) {
            results.set(ref.address, {
              ok: false,
              reason: `resolved media exceeds the ${limit}-byte cap`,
            });
            budget.abort(new Error("media byte budget spent"));
          } else {
            results.set(ref.address, { ok: true, b64: toBase64(bytes), bytes: bytes.byteLength });
          }
        }
      } catch (err) {
        results.set(ref.address, {
          ok: false,
          reason: `the resolver failed: ${String((err as Error)?.message ?? err)}`,
        });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker));
  } finally {
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
  // A cancelled call is a cancelled call, not a missing blob.
  if (options.signal?.aborted === true) throw options.signal.reason ?? new Error("aborted");

  const failure = (address: string): string | undefined => {
    const r = results.get(address);
    if (r === undefined) return "not fetched: the request's media byte budget was spent first";
    return r.ok ? undefined : r.reason;
  };
  // An app-supplied ref that failed fails the call, naming the address.
  for (const [address, use] of refs) {
    const why = failure(address);
    if (why !== undefined && !use.tool) throw new UnresolvedContentError(address, why);
  }

  const inline = (p: LlmResultPart): LlmResultPart => {
    if (!isMedia(p) || p.source.kind !== "ref") return p;
    const r = results.get(p.source.ref.address);
    return r?.ok === true ? ({ ...p, source: { kind: "data", data: r.b64 } } as LlmResultPart) : p;
  };
  const messages: LlmMessage[] = request.messages.map((m) => {
    if (typeof m.content === "string") return m;
    return {
      ...m,
      content: m.content.map((p) => {
        if (p.type === "tool_result" && typeof p.content !== "string") {
          let isError = p.isError;
          const content = p.content.map((r): LlmResultPart => {
            if (isMedia(r) && r.source.kind === "ref") {
              const why = failure(r.source.ref.address);
              if (why !== undefined) {
                isError = true;
                return {
                  type: "text",
                  text: JSON.stringify({
                    error: {
                      code: "content_unavailable",
                      address: r.source.ref.address,
                      message: why,
                    },
                  }),
                };
              }
            }
            return inline(r);
          });
          return { ...p, content, ...(isError !== undefined && { isError }) };
        }
        if (isMedia(p) && p.source.kind === "ref") return inline(p) as typeof p;
        return p;
      }),
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
