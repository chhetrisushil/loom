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

export type LlmContentPart = LlmTextPart | LlmMediaPart | LlmToolUsePart | LlmToolResultPart;
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
  | LlmToolResultPartInput;
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
 * The `assistant` message that records a model response — text (when any) then one
 * `tool_use` part per call — so the next turn's `tool_result`s have something to
 * answer. A response with neither text nor calls yields an empty text part rather than
 * an empty array (providers reject empty content).
 */
export function assistantMessageOf(response: {
  content: string;
  toolCalls?: readonly { id: string; name: string; input: unknown }[];
}): { role: "assistant"; content: LlmContentPart[] } {
  const parts: LlmContentPart[] = [];
  if (response.content !== "") parts.push({ type: "text", text: response.content });
  for (const c of response.toolCalls ?? []) {
    parts.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return { role: "assistant", content: parts };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte length of a base64 string, or `undefined` if it is not valid base64. */
export function base64ByteLength(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - pad;
}
