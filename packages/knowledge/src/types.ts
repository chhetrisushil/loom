import type { TaintedValue } from "@loom/classify";

/**
 * A source document, as the application already has it: an id it can name the document
 * by again tomorrow, its text, and whatever metadata it wants carried onto every passage.
 *
 * There is deliberately no `source`, `url`, `author`, `section` or `updatedAt` here. Those
 * are a vocabulary, they differ per corpus, and a framework that named them would be
 * asking every app to translate into its dialect — put them in `meta`, which travels
 * verbatim and is indexed like any other content.
 */
export interface KnowledgeDoc {
  /** Stable across revisions. This is what a re-ingest supersedes and what a citation names. */
  id: string;
  /** Optional label, carried onto every passage so a citation can read as a title. */
  title?: string;
  text: string;
  /** Carried onto every passage verbatim. Must be JSON — it is stored in a MemoryEntry. */
  meta?: Record<string, unknown>;
}

/**
 * One retrieved (or just-ingested) piece of a document.
 *
 * `text` is TAINTED (ADR 0085) and stays tainted all the way into the model request. A
 * corpus is edited by whoever can edit the source, so a passage is third-party content by
 * definition — the same class as an MCP tool result — and `guardRequest` refuses it in
 * every instruction position. Tainting at INGEST rather than at the prompt is what makes
 * that hold on every path: the wrapper is plain JSON, so it survives the store, the
 * recorded retrieval, and a replay that rebuilds the prompt from the log.
 */
export interface Passage {
  docId: string;
  title?: string;
  /** 0-based position within the document, in source order. */
  index: number;
  text: TaintedValue<string>;
  meta?: Record<string, unknown>;
}

/**
 * Splits a document into passage texts, in source order.
 *
 * Injected, never inferred. How a document splits is a property of the corpus — a runbook
 * splits on paragraphs, a legal contract on numbered clauses, a chat export on turns — and
 * the retrieval quality of a knowledge base is mostly decided here. {@link packParagraphs}
 * is a default worth having, not a default worth hiding.
 */
export type Chunker = (doc: KnowledgeDoc) => string[];

/**
 * The manifest row for one document: what a corpus knows about a document without
 * reading its passages.
 *
 * `chunkCount` is what makes removal possible at all — passage ids are derived
 * (`docId#0…docId#n`), so the count IS the id list, in one small row instead of n.
 *
 * `fingerprint` is over the document's content, so re-ingesting an unchanged document is
 * free: that is what turns {@link KnowledgeBase.sync} from "rebuild the corpus" into "write
 * the documents that actually changed".
 *
 * `committed` is the crash-safety flag, and the reason ingest writes a manifest row TWICE.
 * The dangerous interleaving is not a lost write, it is a manifest that claims a revision
 * whose passages were never appended: the next sync would compare fingerprints, see a
 * match, and skip the document forever — a corpus silently missing a document that every
 * status view calls present. Writing `committed: false` first, and flipping it only after
 * the passages land, makes the crash window converge on a re-run instead.
 */
export interface DocRecord {
  docId: string;
  chunkCount: number;
  fingerprint: string;
  committed: boolean;
  /**
   * WHO manages this document — the writer that may revise or delete it. `undefined` is a
   * source of its own (the corpus's default writer), not a wildcard.
   *
   * It exists because `sync` is a destructive reconcile over everything the manifest holds,
   * and a corpus is not always written by one thing. An agent that writes down what it
   * learned from feedback puts documents in the same scope as an authored corpus — and the
   * nightly sync of a wiki export would then delete every one of them, because they are not
   * in the set the wiki produced. Stamping each document with its writer makes that
   * impossible instead of documented: a `sync` only ever reconciles its own documents.
   */
  source?: string;
  /**
   * Generation of this manifest ROW, not a version of the document.
   *
   * Manifest rows are only ever APPENDED — `docId#0`, `docId#1`, … — and the highest one
   * wins, because the alternative (delete the old row, append the new one) has a crash
   * window in which the document has no manifest row at all. That window is the worst of
   * the three: passages nothing counts are passages nothing can remove. Superseded rows
   * are pruned after the new one is durable, so a crash costs a stale row and never a
   * missing one.
   */
  revision: number;
}
