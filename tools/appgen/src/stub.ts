import { templateLiteralText } from "./emit";
import { fnv1a32 } from "./hash";

// ── The generated handler stub: a single source of truth ─────────────────────
//
// When appgen creates a step it emits a placeholder `handler$` body. The brownfield
// safety gate later needs to answer one question with certainty: "is this handler
// still the untouched stub we generated, or did a human edit it?" That only works if
// exactly ONE definition of the stub text exists — `generate.ts` emits it via
// `stubHandlerBody`, and the gate recognises it via `isStubBody`, both below. Never
// inline the stub string anywhere else.

/** The canonical placeholder handler body appgen generates for a fresh step. */
export function stubHandlerBody(stepId: string): string {
  return `async (input: { prompt: string }) => ({ result: \`TODO: implement ${templateLiteralText(stepId)} for \${input.prompt}\` })`;
}

/**
 * Collapse insignificant whitespace so a reformat (re-indent, prettier pass) of an
 * otherwise-untouched stub still reads as a stub. The literal `TODO: implement <id>`
 * makes a false "stub" verdict on genuinely hand-written code astronomically unlikely.
 */
export function normalizeBody(src: string): string {
  return src.replace(/\s+/g, " ").trim();
}

/** Content hash of the canonical stub body for `stepId`. */
export function stubHash(stepId: string): number {
  return fnv1a32(normalizeBody(stubHandlerBody(stepId)));
}

/**
 * Is `body` (the source text of a `handler$(...)` argument) still the untouched
 * generated stub for `stepId`? The gate that decides whether appgen may overwrite a
 * handler body — a human-edited handler is insert-only, never mutated.
 */
export function isStubBody(stepId: string, body: string): boolean {
  return fnv1a32(normalizeBody(body)) === stubHash(stepId);
}
