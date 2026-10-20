import { createHash } from "node:crypto";
import { type TaintedValue, tainted } from "@loom/classify";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmReasoning, LlmReasoningKind, LlmReasoningPart } from "./parts";
import type { ContentResolver } from "./resolveContent";

// ── ADR 0133 — model reasoning as audit evidence ─────────────────────────────
//
// The provider returns reasoning next to its answer. `captureReasoning` runs BEFORE `parse`
// and reduces it to its recorded form: kind, provider, signature and a reference to the readable
// text in a sidecar store. The text never reaches a step value; the audit fact is a userspace
// event naming references and digests, never text and never signatures. `readReasoning` joins
// those events back to their blobs for an auditor.

/** The event the capture emits (userspace: the fold ignores it). */
export const LLM_REASONING_CAPTURED = "LLM_REASONING_CAPTURED";

/**
 * Write and read view of the sidecar store (structural: a `ContentStore` satisfies it, with no
 * package dependency). Content-addressed and idempotent by hash, so a crash-recovery rerun that
 * produces the same bytes stores nothing new.
 */
export interface ReasoningStore {
  put(bytes: Uint8Array): Promise<{ readonly __loomContent: string }>;
  get(ref: { readonly __loomContent: string }): Promise<Uint8Array | null>;
}

/** Read-only view, for {@link readReasoning}. */
export type ReasoningReader = Pick<ReasoningStore, "get">;

export interface LlmReasoningOptions {
  /** Where readable text is kept. Without one, text is dropped and only signatures are recorded. */
  store?: ReasoningStore;
  /** Default: on iff a store is configured. `false` is the explicit opt-out. */
  capture?: boolean | ((ctx: EffectContext) => boolean);
  /** Deliver readable reasoning deltas live (D6): through the per-call sink under a runtime pipe, else to `onDelta`. Off by default. */
  live?: boolean;
  /**
   * The configured live sink for reasoning, the analogue of `createLlmEffect`'s text `onDelta`
   * (a transport such as `ConversationHub.reasoningSink()`). Called only when `live` is on and the
   * call is streamed, with the increment still WRAPPED as untrusted content
   * (`llm-reasoning:<stepId>`): the sink unwraps it at its own transport edge, never earlier.
   * Never journaled; not called on replay.
   */
  onDelta?: (delta: TaintedValue<string>, ctx: EffectContext) => void;
  /** Recorded on the audit event (the provider SPI does not expose its model id). */
  model?: string;
  /**
   * An AUTHORIZING resolver for a reasoning part's `textRef` (the ADR 0120 `ContentResolver` seam,
   * called with `origin: "reasoning"` and the call's executionId / stepId / principal). It returns the
   * readable text's bytes, or `null` for absent / not yours; a throw is an outage and fails the call.
   * Default: {@link reasoningStoreResolver} over `store`, which serves only blobs sealed to the
   * calling execution.
   */
  resolve?: ContentResolver;
}

/** One part of an `LLM_REASONING_CAPTURED` payload: references and digests, never text. */
export interface CapturedReasoningPart {
  kind: LlmReasoningKind;
  ref?: string;
  digest?: string;
  size?: number;
}

export interface LlmReasoningCaptured {
  stepId: string;
  attempt: number;
  provider: string;
  model?: string;
  parts: CapturedReasoningPart[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── the execution seal (ADR 0133 D5, "who may resolve a ref") ─────────────────
//
// The sidecar is content-addressed and, like every ContentStore, has no tenancy of its own: whoever
// can name an address can read it, and a reasoning part's `textRef` rides in a transcript a caller
// may have assembled. So the stored bytes are SEALED to the execution that captured them (a tiny
// JSON envelope naming it), and the default resolver serves a blob only to that execution. A forged
// or copied ref to another execution's blob resolves to `null` (not yours), which the drop rule
// treats as a hole. The part's `digest` and the audit event's `digest`/`size` stay those of the
// readable text itself.

/** The bytes stored for `text`: sealed to `executionId`. */
export function sealReasoningText(text: string, executionId: string): Uint8Array {
  return enc.encode(JSON.stringify({ e: executionId, t: text }));
}

/** The text bytes inside a sealed blob, or `null` when it is not sealed to `executionId` (or is not a sealed blob). */
export function openReasoningText(bytes: Uint8Array, executionId: string): Uint8Array | null {
  try {
    const v = JSON.parse(dec.decode(bytes)) as { e?: unknown; t?: unknown } | null;
    if (v === null || typeof v !== "object" || v.e !== executionId || typeof v.t !== "string") {
      return null;
    }
    return enc.encode(v.t);
  } catch {
    return null;
  }
}

/** The default reasoning resolver: reads the sidecar and serves a blob only to the execution it is sealed to. */
export function reasoningStoreResolver(store: ReasoningReader): ContentResolver {
  return async (ref, ctx) => {
    const bytes = await store.get({ __loomContent: ref.address });
    return bytes === null ? null : openReasoningText(bytes, ctx.executionId);
  };
}

/** SHA-256 hex of the canonical UTF-8 bytes of `text`. */
export function reasoningDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether capture is on for this call: an explicit choice wins, else on iff a store is configured. */
export function captureOn(options: LlmReasoningOptions | undefined, ctx: EffectContext): boolean {
  if (options === undefined || options.store === undefined) return false;
  const c = options.capture;
  return c === undefined ? true : typeof c === "function" ? c(ctx) : c;
}

/**
 * Reduce a response's reasoning to its recorded parts and (when anything was captured) emit the
 * audit event. Pure with respect to the response; the only side effects are the store `put`s and
 * the one `ctx.emit`. A failing `put` throws: audit evidence that cannot be kept fails the step
 * (and retries it) instead of silently recording less than was configured.
 */
export async function captureReasoning(
  reasoning: readonly LlmReasoning[],
  options: LlmReasoningOptions | undefined,
  ctx: EffectContext
): Promise<LlmReasoningPart[]> {
  const store = captureOn(options, ctx) ? options?.store : undefined;
  const parts: LlmReasoningPart[] = [];
  const audit: CapturedReasoningPart[] = [];
  for (const r of reasoning) {
    const part: LlmReasoningPart = {
      type: "reasoning",
      kind: r.kind,
      provider: r.provider,
      ...(r.signature !== undefined && { signature: r.signature }),
    };
    const text = r.text ?? "";
    if (text !== "") {
      if (store !== undefined) {
        const bytes = enc.encode(text);
        const ref = await store.put(sealReasoningText(text, ctx.executionId));
        part.textRef = { address: ref.__loomContent, size: bytes.byteLength };
        part.digest = reasoningDigest(bytes);
        audit.push({
          kind: r.kind,
          ref: ref.__loomContent,
          digest: part.digest,
          size: bytes.byteLength,
        });
      } else {
        // Readable text existed and was not kept: the part cannot be reproduced for continuation.
        part.omitted = true;
      }
    } else if (store !== undefined) {
      audit.push({ kind: r.kind });
    }
    parts.push(part);
  }
  if (store !== undefined && audit.length > 0) {
    const payload: LlmReasoningCaptured = {
      stepId: ctx.stepId,
      attempt: ctx.attempt,
      provider: reasoning[0]?.provider ?? "",
      ...(options?.model !== undefined && { model: options.model }),
      parts: audit,
    };
    ctx.emit(LLM_REASONING_CAPTURED, payload);
  }
  return parts;
}

// ── the audit reader (D4) ────────────────────────────────────────────────────

/** The minimal log view `readReasoning` needs: an `EventStore` satisfies it. */
export interface ReasoningLogReader {
  read(executionId: string): Promise<readonly { eventType: string; payload: unknown }[]>;
}

export type ReasoningPartStatus = "ok" | "erased" | "digest-mismatch";

export interface ReasoningPartRead {
  kind: LlmReasoningKind;
  provider: string;
  status: ReasoningPartStatus;
  /** Present only when `status` is `"ok"` and the part had readable text; wrapped as untrusted. */
  text?: TaintedValue<string>;
}

export interface ReasoningAttemptRead {
  attempt: number;
  provider: string;
  model?: string;
  /** This attempt's value is the one the step recorded (the last capture before `STEP_COMPLETED`). */
  recorded: boolean;
  parts: ReasoningPartRead[];
}

export interface ReasoningStepRead {
  stepId: string;
  /** In log order; superseded attempts are kept. */
  attempts: ReasoningAttemptRead[];
  /** The attempt whose value the step recorded, when the step completed. */
  recordedAttempt?: number;
}

/**
 * Join `LLM_REASONING_CAPTURED` events to their blobs. Each part is checked against its digest:
 * an absent blob reports `erased`, an altered one `digest-mismatch`. Readable text comes back
 * wrapped as untrusted content (origin `llm-reasoning:<stepId>`), so it cannot be put in a prompt
 * instruction position. Grouped by step with every attempt; the attempt whose value the step
 * recorded is the last capture before that step's `STEP_COMPLETED`.
 */
export async function readReasoning(
  log: ReasoningLogReader,
  store: ReasoningReader,
  query: { executionId: string; stepId?: string }
): Promise<ReasoningStepRead[]> {
  const events = await log.read(query.executionId);
  const steps = new Map<string, ReasoningStepRead>();
  const latest = new Map<string, ReasoningAttemptRead>();
  for (const ev of events) {
    if (ev.eventType === LLM_REASONING_CAPTURED) {
      const p = asCaptured(ev.payload);
      if (p === undefined || (query.stepId !== undefined && p.stepId !== query.stepId)) continue;
      const attempt: ReasoningAttemptRead = {
        attempt: p.attempt,
        provider: p.provider,
        ...(p.model !== undefined && { model: p.model }),
        recorded: false,
        parts: [],
      };
      for (const part of p.parts) {
        attempt.parts.push(await readPart(store, part, p.provider, p.stepId, query.executionId));
      }
      let step = steps.get(p.stepId);
      if (step === undefined) {
        step = { stepId: p.stepId, attempts: [] };
        steps.set(p.stepId, step);
      }
      step.attempts.push(attempt);
      latest.set(p.stepId, attempt);
    } else if (ev.eventType === "STEP_COMPLETED") {
      const id = (ev.payload as { stepId?: unknown } | null)?.stepId;
      const attempt = typeof id === "string" ? latest.get(id) : undefined;
      if (attempt !== undefined && typeof id === "string") {
        attempt.recorded = true;
        const step = steps.get(id);
        if (step !== undefined) step.recordedAttempt = attempt.attempt;
      }
    }
  }
  return [...steps.values()];
}

function asCaptured(payload: unknown): LlmReasoningCaptured | undefined {
  const p = payload as Partial<LlmReasoningCaptured> | null;
  if (
    p === null ||
    typeof p !== "object" ||
    typeof p.stepId !== "string" ||
    typeof p.attempt !== "number" ||
    typeof p.provider !== "string" ||
    !Array.isArray(p.parts)
  ) {
    return undefined;
  }
  return p as LlmReasoningCaptured;
}

async function readPart(
  store: ReasoningReader,
  part: CapturedReasoningPart,
  provider: string,
  stepId: string,
  executionId: string
): Promise<ReasoningPartRead> {
  const base = { kind: part.kind, provider };
  if (part.ref === undefined) return { ...base, status: "ok" };
  const stored = await store.get({ __loomContent: part.ref });
  if (stored === null) return { ...base, status: "erased" };
  // A blob not sealed to this execution is not what this execution captured.
  const bytes = openReasoningText(stored, executionId);
  if (bytes === null) return { ...base, status: "digest-mismatch" };
  if (part.digest === undefined || reasoningDigest(bytes) !== part.digest) {
    return { ...base, status: "digest-mismatch" };
  }
  return { ...base, status: "ok", text: tainted(dec.decode(bytes), `llm-reasoning:${stepId}`) };
}
