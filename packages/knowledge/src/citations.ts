import type { Passage } from "./types";

export interface CitationCheck {
  /** Claimed ids that were actually retrieved, deduplicated, in retrieval order. */
  grounded: string[];
  /**
   * Claimed ids that were NOT retrieved — the model named a source it was never shown.
   * Non-empty is a fabricated citation, not a near miss.
   */
  ungrounded: string[];
  /** Retrieved documents the answer did not cite. Not an error — evidence for tuning `limit`. */
  unused: string[];
}

export class UngroundedCitationError extends Error {
  constructor(
    readonly ungrounded: readonly string[],
    readonly retrieved: readonly string[]
  ) {
    super(
      `answer cites ${ungrounded.length} document(s) that were not retrieved: ${ungrounded.join(", ")} (retrieved: ${retrieved.join(", ") || "none"})`
    );
    this.name = "UngroundedCitationError";
  }
}

/**
 * Compare the documents an answer CLAIMS to cite against the ones actually retrieved.
 *
 * The check is nearly free and almost never written, because the number it needs is
 * already in hand: the retrieval was recorded, so the set of documents the model could
 * possibly have read is known exactly. A citation outside that set was not misread from a
 * passage — there was no passage. It is the one hallucination in a RAG answer that can be
 * detected with certainty rather than judged, which is what makes it mechanism and not a
 * quality heuristic.
 *
 * What it does NOT check is whether the answer's CLAIMS follow from the cited passage.
 * That needs a judge, it belongs to `@loom/learning`'s evaluation surface, and conflating
 * the two would turn a decidable check into an approximate one.
 *
 * Ids are compared exactly: a corpus's document ids are its own keys, and normalizing
 * case or punctuation here would be guessing at someone else's namespace.
 */
export function checkCitations(
  claimed: readonly string[],
  passages: readonly Passage[]
): CitationCheck {
  const retrieved: string[] = [];
  const retrievedSet = new Set<string>();
  for (const passage of passages) {
    if (retrievedSet.has(passage.docId)) continue;
    retrievedSet.add(passage.docId);
    retrieved.push(passage.docId);
  }

  const claimedSet = new Set(claimed);
  const ungrounded: string[] = [];
  const seen = new Set<string>();
  for (const id of claimed) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!retrievedSet.has(id)) ungrounded.push(id);
  }

  return {
    // Retrieval order, not claim order: it is the order the app can explain (best first),
    // and the model's ordering carries no meaning worth preserving.
    grounded: retrieved.filter((id) => claimedSet.has(id)),
    ungrounded,
    unused: retrieved.filter((id) => !claimedSet.has(id)),
  };
}

/**
 * {@link checkCitations}, but a fabricated citation throws.
 *
 * Returns the grounded ids, so the caller's happy path is `cited: assertGrounded(...)`.
 * Use it where an answer is about to be shown as sourced: the failure mode this prevents
 * is an answer that reads as attributed, names a plausible document, and cannot be traced
 * to anything — the citation making it MORE trusted than an uncited answer would be.
 */
export function assertGrounded(claimed: readonly string[], passages: readonly Passage[]): string[] {
  const check = checkCitations(claimed, passages);
  if (check.ungrounded.length > 0) {
    throw new UngroundedCitationError(check.ungrounded, [...new Set(passages.map((p) => p.docId))]);
  }
  return check.grounded;
}
