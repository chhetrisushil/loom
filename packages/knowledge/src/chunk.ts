import type { Chunker, KnowledgeDoc } from "./types";

/**
 * The default {@link Chunker}: split on blank lines, then greedily pack paragraphs up to
 * `maxChars` so a passage is a coherent unit of prose rather than a fixed window that cuts
 * mid-sentence.
 *
 * It is a DEFAULT and not a recommendation. Chunking decides what retrieval can return —
 * too small and a passage loses the context that makes it answer the question, too large
 * and one irrelevant paragraph drags a whole page into the prompt — and the right split is
 * a property of the corpus, not of the framework. Pass your own for anything structured.
 *
 * A paragraph longer than `maxChars` is emitted whole rather than cut: splitting mid-word
 * to satisfy a soft bound produces two passages that each retrieve badly, and the bound is
 * a packing target, not a storage limit. Oversized content belongs behind
 * `claimCheckMiddleware` at the effect boundary, which is where size actually bites.
 */
export function packParagraphs(maxChars = 1_000): Chunker {
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new TypeError(`packParagraphs: maxChars must be a positive number (got ${maxChars})`);
  }
  return (doc: KnowledgeDoc): string[] => {
    const paragraphs = doc.text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter((p) => p.length > 0);

    const chunks: string[] = [];
    let current = "";
    for (const paragraph of paragraphs) {
      if (current.length > 0 && current.length + paragraph.length + 1 > maxChars) {
        chunks.push(current);
        current = paragraph;
      } else {
        current = current.length > 0 ? `${current} ${paragraph}` : paragraph;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  };
}
