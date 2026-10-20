import { type TaintedValue, isTainted } from "@loom/classify";

// ── R5 — content parts (ADR 0120) ─────────────────────────────────────────────
//
// A message's content is `string | LlmContentPart[]`. The string form is the
// compatibility path and stays first-class (a text-only caller changes nothing);
// the parts form carries media and the tool-call turn structure.
//
// Tool results ride in a `user`-role message as `tool_result` parts and tool calls
// in an `assistant` message as `tool_use` parts (the Anthropic Messages shape —
// there is NO `tool` role). One canonical shape, mapped per provider: OpenAI's
// `role: "tool"` messages and Gemini's `functionResponse` parts are the providers'
// problem. It also leaves ADR 0085's positional rule intact — "tainted content may
// appear only in a `user` message, fenced" — rather than adding a third position
// that every guard would have to learn.

/**
 * A claim-check for large bytes held in a content store (ADR 0046).
 *
 * Deliberately NOT the store's own `{ __loomContent }` marker: the resolving event
 * store would substitute that marker with a JSON-decoded value on read, which is
 * wrong for raw media bytes. This is an opaque address the caller resolves (see
 * `CreateLlmEffectOptions.resolveContent`) at call time, so the log carries the
 * address and never the bytes.
 */
export interface LlmContentRef {
  /** The content address, e.g. `"sha256:<hex>"`. */
  readonly address: string;
  /** Byte length, informational. */
  readonly size?: number;
}

/** Where a media part's bytes are. */
export type LlmBinarySource =
  | { readonly kind: "ref"; readonly ref: LlmContentRef }
  /** Small inline bytes, base64. Capped (see `MAX_INLINE_BYTES`) so the log never carries real media. */
  | { readonly kind: "data"; readonly data: string };

export interface LlmTextPart {
  type: "text";
  text: string;
}
/** Provenance for a media part whose bytes came from an untrusted party (see `guardRequest`). */
export interface LlmUntrustedMark {
  untrusted?: { origin: string };
}
export interface LlmImagePart extends LlmUntrustedMark {
  type: "image";
  /** e.g. `image/png`. */
  mediaType: string;
  source: LlmBinarySource;
}
export interface LlmAudioPart extends LlmUntrustedMark {
  type: "audio";
  mediaType: string;
  source: LlmBinarySource;
}
export interface LlmFilePart extends LlmUntrustedMark {
  type: "file";
  mediaType: string;
  source: LlmBinarySource;
  name?: string;
}
export type LlmMediaPart = LlmImagePart | LlmAudioPart | LlmFilePart;
export type LlmModality = LlmMediaPart["type"];

/** A tool call the model made (assistant messages only). */
export interface LlmToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  /** Provider-opaque continuation bytes that belong to this call (Gemini `thoughtSignature`). Sent back unchanged; never dropped with reasoning parts (ADR 0133 D5). */
  signature?: string;
}

/**
 * What the model returned as reasoning, in its RECORDED form (ADR 0133 D2): kind, provider,
 * opaque signature, and a reference to the readable text in a sidecar store. Never readable text
 * in a step value or a transcript. Assistant messages only.
 */
export interface LlmReasoningPart {
  type: "reasoning";
  kind: LlmReasoningKind;
  /** The provider that produced it: a part is only sent back to this provider. */
  provider: string;
  signature?: string;
  /** Where the text lives (sidecar store), when it was captured and is non-empty. */
  textRef?: LlmContentRef;
  /** SHA-256 hex of the text, so a resolved text can be checked. */
  digest?: string;
  /** The model returned readable text that was NOT kept (no store, or capture off). Such a part cannot be reproduced for continuation, so the drop rule (ADR 0133 D5) drops it. */
  omitted?: true;
  /**
   * REQUEST-TIME ONLY: the readable text `resolveRequestContent` fetched from `textRef`, for the
   * provider to map back unchanged. Never present on a recorded value.
   */
  text?: string;
}

/** What the provider returned. Never upgrade a `summary` to `text` (ADR 0133 D2). */
export type LlmReasoningKind = "text" | "summary" | "redacted";

/** Reasoning on a response, as the provider returned it. Lives only on `LlmResponse`, never in a step value. */
export interface LlmReasoning {
  kind: LlmReasoningKind;
  /** Readable text; "" for an omitted-display block; absent for `redacted`. */
  text?: string;
  /** Provider-opaque continuation bytes (signature, redacted data). Never read by loom. */
  signature?: string;
  /** The provider that produced it (`"anthropic"`, `"gemini"`, ...): parts are only sent back to it. */
  provider: string;
}

/** What a tool result may contain: text and media. */
export type LlmResultPart = LlmTextPart | LlmMediaPart;

/** The answer to a tool call (user messages only). */
export interface LlmToolResultPart {
  type: "tool_result";
  /** The `id` of the `tool_use` this answers. */
  toolUseId: string;
  content: string | LlmResultPart[];
  isError?: boolean;
}

export type LlmContentPart =
  | LlmTextPart
  | LlmMediaPart
  | LlmToolUsePart
  | LlmToolResultPart
  | LlmReasoningPart;
export type LlmMessageContent = string | LlmContentPart[];

// ── input side: parts that may still carry provenance ────────────────────────

/** A content slot that may still carry provenance. */
export type LlmContent = string | TaintedValue<string>;

export interface LlmTextPartInput {
  type: "text";
  text: LlmContent;
}
/**
 * A media part whose bytes came from an untrusted party. `untrusted` is the media
 * analogue of `tainted()` on text: `guardRequest` refuses it outside a `user`
 * message, refuses one that names a stored `ref`, and leaves the mark on the part; the provider
 * mappers bracket it with the same fence tags as text (`fenceUntrustedMedia`) where their wire
 * shape allows — the fence must travel with the media, which not every wire keeps in one message.
 */
export type LlmMediaPartInput = LlmMediaPart;
export type LlmResultPartInput = LlmTextPartInput | LlmMediaPartInput;
export interface LlmToolResultPartInput {
  type: "tool_result";
  toolUseId: string;
  content: LlmContent | LlmResultPartInput[];
  isError?: boolean;
}
export type LlmContentPartInput =
  | LlmTextPartInput
  | LlmMediaPartInput
  | LlmToolUsePart
  | LlmToolResultPartInput
  | LlmReasoningPart;
export type LlmMessageContentInput = LlmContent | LlmContentPartInput[];

// ── helpers ──────────────────────────────────────────────────────────────────

/** Normalise message content to its parts form (a string becomes one text part). */
export function toParts(content: LlmMessageContent): LlmContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Thrown by {@link textOf} when handed a `tainted()` wrapper (`{ __loomTainted, value }`) instead
 * of message content. A wrapper is neither a string nor parts; reading it as text would either
 * crash obscurely or, worse, silently drop the provenance. The message never echoes the content.
 */
export class TaintedContentError extends Error {
  /** The `origin` recorded when the content was tainted. */
  readonly origin: string;
  constructor(origin: string) {
    super(
      `textOf() was given tainted content from "${origin}": untrusted data wrapped by tainted(), not message text. Unwrap it deliberately with unwrapTainted() (or, in a conversation summarizer, summarizerText() from @loom/conversation) and treat the result as DATA - never place it in an instruction position.`
    );
    this.name = "TaintedContentError";
    this.origin = origin;
  }
}

/**
 * The text of a message: the string itself, or its text parts joined (including text
 * inside `tool_result`s, which is what a text-only consumer wants to read). Media and
 * `tool_use` parts contribute nothing.
 *
 * Throws {@link TaintedContentError} on a `tainted()` wrapper - at the top level, in a text part's
 * `text`, or in a `tool_result`'s `content` (or its text parts): unwrap it on purpose first.
 */
export function textOf(content: LlmMessageContent): string {
  if (typeof content === "string") return content;
  if (isTainted(content)) throw new TaintedContentError(content.__loomTainted.origin);
  let out = "";
  for (const p of content) {
    if (isTainted(p)) throw new TaintedContentError(p.__loomTainted.origin); // off-type: a wrapper as a part
    if (p.type === "text") out += plainText(p.text);
    else if (p.type === "tool_result") {
      const c: unknown = p.content;
      if (isTainted(c)) throw new TaintedContentError(c.__loomTainted.origin);
      if (typeof c === "string") out += c;
      else
        for (const r of c as LlmResultPart[]) {
          // an off-type wrapper used as an element of the parts is refused like any other
          if (isTainted(r)) throw new TaintedContentError(r.__loomTainted.origin);
          if (r.type === "text") out += plainText(r.text);
        }
    }
  }
  return out;
}

/** A text slot's string; a `tainted()` wrapper nested in a part is refused like a top-level one. */
function plainText(text: unknown): string {
  if (isTainted(text)) throw new TaintedContentError(text.__loomTainted.origin);
  return text as string;
}

/** Whether a message carries any non-text part. */
export function hasStructuredParts(content: LlmMessageContent): boolean {
  return typeof content !== "string" && content.some((p) => p.type !== "text");
}

/**
 * ADR 0133 D5 - where each block sat in the vendor's response, when that is NOT the canonical order
 * (reasoning parts, then ONE text, then the tool calls). A provider whose signatures bind block
 * order (Anthropic preserved thinking) needs the sequence back exactly: `thinking, text, tool_use,
 * thinking, tool_use` must not become `thinking, thinking, text, tool_use, tool_use`.
 *
 * An entry is `"reasoning"` (the next recorded reasoning part), `{ call }` (the tool call with that
 * id) or `{ text }` (the next `n` characters of the response's `content`). Positions only, no new
 * content, so nothing readable is added to a step value.
 */
export type LlmLayoutEntry = "reasoning" | { call: string } | { text: number };

/**
 * The layout to record for a response, or `undefined` when none is needed: no reasoning (the shape
 * stays exactly today's, G2) or the canonical order. Zero-length text blocks are dropped (a provider
 * rejects an empty text block, so there is nothing to reproduce).
 */
export function layoutOf(entries: readonly LlmLayoutEntry[]): LlmLayoutEntry[] | undefined {
  const kept = entries.filter((e) => typeof e !== "object" || !("text" in e) || e.text > 0);
  if (!kept.includes("reasoning")) return undefined;
  // canonical: "reasoning"*, at most one text, calls*. Phase 0 = reasoning, 1 = after the text, 2 = calls.
  let phase = 0;
  let canonical = true;
  for (const e of kept) {
    if (e === "reasoning") {
      if (phase !== 0) canonical = false;
    } else if ("text" in e) {
      if (phase !== 0) canonical = false;
      phase = 1;
    } else phase = 2;
  }
  return canonical ? undefined : kept.map((e) => (typeof e === "object" ? { ...e } : e));
}

/**
 * The `assistant` message that records a model response — text (when any) then one
 * `tool_use` part per call — so the next turn's `tool_result`s have something to
 * answer. A response with neither text nor calls yields an empty text part rather than
 * an empty array (providers reject empty content).
 *
 * With a `layout` (ADR 0133 D5) the parts come back in the vendor's own order, text blocks at their
 * positions. A layout that does not fit the response (malformed, text lengths not summing to `content`,
 * or a reasoning count that differs) drops every reasoning part rather than reorder them; a named call
 * that is missing drops the reasoning parts after it; calls it does not name go at the end.
 */
export function assistantMessageOf(response: {
  content: string;
  toolCalls?: readonly { id: string; name: string; input: unknown; signature?: string }[];
  /** ADR 0133 - recorded reasoning parts (`LlmReasoningPart`), carried first. Raw `LlmReasoning` is not accepted: readable text never enters a transcript. */
  reasoning?: readonly object[];
  /** ADR 0133 D5 - the vendor's block order, when not canonical. */
  layout?: readonly LlmLayoutEntry[];
}): { role: "assistant"; content: LlmContentPart[] } {
  const recorded: LlmReasoningPart[] = [];
  for (const r of response.reasoning ?? []) {
    if ((r as { type?: string }).type === "reasoning") recorded.push(r as LlmReasoningPart);
  }
  const parts: LlmContentPart[] = laidOut(response, recorded) ?? canonicalParts(response, recorded);
  if (!parts.some((p) => p.type === "text" || p.type === "tool_use")) {
    parts.push({ type: "text", text: "" });
  }
  return { role: "assistant", content: parts };
}

interface ToolCallLike {
  id: string;
  name: string;
  input: unknown;
  signature?: string;
}

function toolUse(c: ToolCallLike): LlmToolUsePart {
  return {
    type: "tool_use",
    id: c.id,
    name: c.name,
    input: c.input,
    ...(c.signature !== undefined && { signature: c.signature }),
  };
}

function canonicalParts(
  response: { content: string; toolCalls?: readonly ToolCallLike[] },
  recorded: readonly LlmReasoningPart[]
): LlmContentPart[] {
  const parts: LlmContentPart[] = [...recorded];
  if (response.content !== "") parts.push({ type: "text", text: response.content });
  for (const c of response.toolCalls ?? []) parts.push(toolUse(c));
  return parts;
}

function laidOut(
  response: {
    content: string;
    toolCalls?: readonly ToolCallLike[];
    layout?: readonly LlmLayoutEntry[];
  },
  recorded: readonly LlmReasoningPart[]
): LlmContentPart[] | undefined {
  const layout = response.layout;
  if (layout === undefined || layout.length === 0) return undefined;
  // A thinking block is valid only while everything before it is unchanged, so a layout that cannot be
  // replayed exactly must never be "repaired" by moving blocks (a 400 on a preserved-thinking account).
  // When it does not fit at all, every reasoning part is dropped instead: stripping is always valid.
  let total = 0;
  let reasoningEntries = 0;
  for (const e of layout) {
    if (e === "reasoning") reasoningEntries++;
    else if (
      typeof e === "object" &&
      e !== null &&
      typeof (e as { text?: unknown }).text === "number"
    ) {
      total += (e as { text: number }).text;
    } else if (
      typeof e !== "object" ||
      e === null ||
      typeof (e as { call?: unknown }).call !== "string"
    ) {
      return canonicalParts(response, []);
    }
  }
  if (total !== response.content.length || reasoningEntries !== recorded.length) {
    return canonicalParts(response, []);
  }
  const calls = new Map((response.toolCalls ?? []).map((c) => [c.id, c]));
  const used = new Set<string>();
  const parts: LlmContentPart[] = [];
  let nextReasoning = 0;
  let offset = 0;
  // Once a named call is missing (screened out by the loop), every later block's prefix has changed:
  // drop the reasoning parts from there on (a suffix drop), keep the earlier ones.
  let prefixChanged = false;
  for (const e of layout) {
    if (e === "reasoning") {
      const r = recorded[nextReasoning++] as LlmReasoningPart;
      if (!prefixChanged) parts.push(r);
    } else if ("text" in e) {
      parts.push({ type: "text", text: response.content.slice(offset, offset + e.text) });
      offset += e.text;
    } else {
      const c = calls.get(e.call);
      if (c !== undefined && !used.has(e.call)) {
        used.add(e.call);
        parts.push(toolUse(c));
      } else prefixChanged = true;
    }
  }
  // A call the layout did not name goes after every block, so it changes no block's prefix.
  for (const c of response.toolCalls ?? []) if (!used.has(c.id)) parts.push(toolUse(c));
  return parts;
}

/**
 * ADR 0133 D5 - the same message without its `reasoning` parts (the edit-point drop). Returns the
 * SAME object when it holds none, so callers can compare by identity; tool-call signatures are never
 * touched. A message left empty keeps the shape `assistantMessageOf` gives an empty turn.
 */
export function withoutReasoningParts<M extends { content: unknown }>(message: M): M {
  const content = message.content;
  if (!Array.isArray(content) || !content.some((p) => p?.type === "reasoning")) return message;
  const kept = content.filter((p) => p?.type !== "reasoning");
  return { ...message, content: kept.length > 0 ? kept : [{ type: "text", text: "" }] };
}

/** Whether a message holds a `reasoning` part. */
export function hasReasoningParts(message: { content: unknown }): boolean {
  return Array.isArray(message.content) && message.content.some((p) => p?.type === "reasoning");
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a base64 string, or `undefined` if it is not valid base64. */
export function base64ByteLength(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - pad;
}
