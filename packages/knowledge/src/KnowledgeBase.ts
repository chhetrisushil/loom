import { tainted } from "@loom/classify";
import { canonicalJson, fnv1a64 } from "@loom/core";
import { TieredMemory } from "@loom/memory";
import type { MemoryEntry, MemoryStore } from "@loom/memory";
import { packParagraphs } from "./chunk";
import type { Chunker, DocRecord, KnowledgeDoc, Passage } from "./types";

/** The `decide` a retrieval is recorded through — structurally `ctx.decide`. */
export type DecideFn = <T>(key: string, compute: () => Promise<T> | T) => Promise<T>;

export interface KnowledgeBaseConfig {
  /** The memory the corpus lives in. Its tier must not evict — see {@link KnowledgeBase}. */
  memory: TieredMemory;
  /** Names this corpus within the tier. One knowledge base, one scope. */
  scope: string;
  /** Defaults to `"semantic"` — the tier that never evicts. */
  tier?: string;
  /** Defaults to {@link packParagraphs}. */
  chunker?: Chunker;
  /**
   * The provenance label stamped on every passage's taint, shown to the model when
   * `guardRequest` fences the content. Defaults to `knowledge:<scope>:<docId>`.
   */
  origin?: (doc: KnowledgeDoc) => string;
}

export interface RetrieveOptions {
  /** REQUIRED — `ctx.decide`. See {@link KnowledgeBase.retrieve}. */
  decide: DecideFn;
  limit?: number;
  /** Overrides the recorded decision key. Defaults to the tier/scope/query triple. */
  decisionKey?: string;
}

export interface SyncResult {
  /** Documents written because they were new or their fingerprint changed. */
  written: string[];
  /** Documents already present at the same fingerprint — not rewritten. */
  unchanged: string[];
  /** Documents removed because the source no longer lists them. */
  removed: string[];
}

/**
 * A document corpus over a memory tier: ingest, revise, delete, retrieve — with the
 * provenance and the recorded retrieval that make the result usable in a prompt.
 *
 * ## What this is not
 *
 * It is not a construct, an SPI, or a retrieval engine. Ranking is the `MemoryStore`'s
 * (FTS5, `tsvector`, cosine — whichever backend is configured), reproducibility is
 * `ctx.decide`'s, safety is ADR 0085's, and the corpus is an ordinary `semantic` tier
 * anyone can read with `recall`. What lives here is the one thing none of those provide:
 * the mapping from a DOCUMENT — the unit a corpus is edited in — to the PASSAGES it is
 * searched in, so that revising a document supersedes its old passages instead of
 * duplicating them.
 *
 * ## The tier must not evict
 *
 * A corpus is kept until someone deletes it, so the tier it lives in must have no `ttlMs`
 * and no `maxEntries`. Under eviction, the store would drop passages the manifest still
 * counts, and a document would silently retrieve as a fragment of itself. `semantic` and
 * `procedural` are unbounded by default, which is exactly why they are the tiers a corpus
 * belongs in — and the constructor refuses a bounded one rather than letting it rot.
 *
 * ## Two scopes
 *
 * Passages live in `scope`; the manifest lives in `scope::docs`, one small row per
 * document. They are separate because they are searched differently: a manifest row in
 * the corpus would be an entry that matches queries and answers nothing.
 */
export class KnowledgeBase {
  private readonly memory: TieredMemory;
  private readonly tier: string;
  private readonly scope: string;
  private readonly manifestScope: string;
  private readonly chunker: Chunker;
  private readonly origin: (doc: KnowledgeDoc) => string;

  constructor(config: KnowledgeBaseConfig) {
    this.memory = config.memory;
    this.tier = config.tier ?? "semantic";
    this.scope = config.scope;
    this.manifestScope = `${config.scope}::docs`;
    this.chunker = config.chunker ?? packParagraphs();
    this.origin = config.origin ?? ((doc) => `knowledge:${config.scope}:${doc.id}`);

    const policy = this.memory.tierPolicy(this.tier);
    if (policy === undefined) {
      throw new Error(
        `KnowledgeBase: unknown memory tier "${this.tier}" (have: ${this.memory.tierNames.join(", ")})`
      );
    }
    if (policy.ttlMs !== undefined || policy.maxEntries !== undefined) {
      throw new Error(
        `KnowledgeBase: tier "${this.tier}" evicts (ttlMs/maxEntries), and a corpus must not. Eviction would drop passages the document manifest still counts, so a document would retrieve as a fragment of itself with nothing to detect it. Use an unbounded tier ("semantic"/"procedural" are unbounded by default).`
      );
    }
  }

  /** `docId#index` — derived, never stored, so a document's passage ids are its count. */
  private passageId(docId: string, index: number): string {
    return `${docId}#${index}`;
  }

  private fingerprint(doc: KnowledgeDoc): string {
    // canonicalJson + fnv1a64 are core's one canonicalization and one hash (ADR 0063).
    // Over the WHOLE document, not just its text: a changed title or a changed `meta`
    // reaches the prompt through every passage, so it is a revision like any other.
    return fnv1a64(
      canonicalJson({
        title: doc.title,
        text: doc.text,
        meta: doc.meta,
      })
    );
  }

  private toPassages(doc: KnowledgeDoc): Passage[] {
    const origin = this.origin(doc);
    return this.chunker(doc).map((text, index) => ({
      docId: doc.id,
      ...(doc.title !== undefined && { title: doc.title }),
      index,
      text: tainted(text, origin),
      ...(doc.meta !== undefined && { meta: doc.meta }),
    }));
  }

  /**
   * What is actually WRITTEN for a passage: its `text`, and its `title`/`meta` if any.
   *
   * `docId` and `index` are deliberately NOT stored, because a store indexes the string
   * and number leaves of `content` — so storing them would make a document's own id a term
   * matching all of its passages, and the chunk ordinal a term matching the first passage
   * of every document in the corpus. That is the same widening that made a tainted value's
   * `origin` unindexable (ADR 0090), and the same rule the SPI states for `MemoryEntry.id`.
   *
   * They are not lost: the entry id IS `docId#index`, ids are required to round-trip
   * (SPI 2.0.0), and ids are not indexed. The requirement earns its keep twice.
   */
  private storedPassage(passage: Passage): Record<string, unknown> {
    return {
      ...(passage.title !== undefined && { title: passage.title }),
      text: passage.text,
      ...(passage.meta !== undefined && { meta: passage.meta }),
    };
  }

  /**
   * The tiered memory the corpus lives in, for a caller that also wants to `recall` it,
   * point a second corpus at the same store, or inspect it from ops code.
   */
  get tieredMemory(): TieredMemory {
    return this.memory;
  }

  /** `docId#revision` — a manifest row's id. Rows are appended; the highest revision wins. */
  private rowId(docId: string, revision: number): string {
    return `${docId}#${revision}`;
  }

  /**
   * The manifest: the live record per document, plus every row id currently standing for
   * it so superseded rows can be pruned.
   *
   * One read of a small scope — rows are ids, counts and hashes, never passage text — which
   * is what keeps `sync` proportional to the number of DOCUMENTS rather than to the size of
   * the corpus. Read order is append order (the SPI guarantees it), so the last row for a
   * document is the live one.
   */
  private async manifest(): Promise<Map<string, ManifestSlot>> {
    const entries = await this.memory.recall(this.tier, this.manifestScope);
    const slots = new Map<string, ManifestSlot>();
    for (const entry of entries) {
      const record = entry.content as DocRecord;
      const slot = slots.get(record.docId);
      const rowId = this.rowId(record.docId, record.revision);
      if (slot === undefined) slots.set(record.docId, { record, rowIds: [rowId] });
      else {
        slot.rowIds.push(rowId);
        slot.record = record;
      }
    }
    return slots;
  }

  private async appendRecord(record: DocRecord): Promise<void> {
    await this.memory.remember(this.tier, this.manifestScope, {
      id: this.rowId(record.docId, record.revision),
      content: record,
    });
  }

  /**
   * Remove a document's passages, by the count the manifest holds. Idempotent — a document
   * that is absent, or whose passages were already deleted, is a no-op.
   */
  async removeDoc(docId: string): Promise<void> {
    const slot = (await this.manifest()).get(docId);
    if (slot === undefined) return;
    await this.removeRecordedPassages(slot.record);
    await this.memory.forget(this.tier, this.manifestScope, slot.rowIds);
  }

  private async removeRecordedPassages(record: DocRecord): Promise<void> {
    const ids = Array.from({ length: record.chunkCount }, (_, i) =>
      this.passageId(record.docId, i)
    );
    if (ids.length > 0) await this.memory.forget(this.tier, this.scope, ids);
  }

  /**
   * Ingest a document, superseding any previous revision of it. Returns the passages now
   * stored for it (empty if the document chunked to nothing).
   *
   * UPSERT, not append. Ingesting the same document twice must not double it in the index
   * — retrieval would then return the stale passage beside the current one, and a citation
   * could not say which is live. That is the operation a `MemoryStore` alone cannot
   * express, and the reason this class exists.
   *
   * The write order is the crash contract, and it is deliberate:
   *
   *  1. APPEND an uncommitted manifest row at the new count and fingerprint;
   *  2. delete the previous revision's passages (by the count the old row holds);
   *  3. append the new passages;
   *  4. APPEND the committed manifest row, then prune the superseded rows.
   *
   * A crash before (4) leaves an uncommitted row, which {@link sync} and every later
   * `putDoc` treat as changed no matter what the fingerprint says — so the document is
   * rewritten rather than skipped.
   *
   * Two orderings look more natural and neither survives. Passages first: passages nothing
   * counts are passages nothing can remove, and they stay retrievable forever. Manifest
   * updated in place (delete the old row, write the new one): the crash window between
   * them leaves the document with NO row, which is the same orphaning by a shorter path —
   * which is why rows are appended and superseded ones are pruned only afterwards.
   */
  async putDoc(doc: KnowledgeDoc): Promise<Passage[]> {
    return this.write(doc, (await this.manifest()).get(doc.id));
  }

  private async write(doc: KnowledgeDoc, slot: ManifestSlot | undefined): Promise<Passage[]> {
    const passages = this.toPassages(doc);
    const pending: DocRecord = {
      docId: doc.id,
      chunkCount: passages.length,
      fingerprint: this.fingerprint(doc),
      committed: false,
      revision: (slot?.record.revision ?? -1) + 1,
    };

    await this.appendRecord(pending);
    if (slot !== undefined) await this.removeRecordedPassages(slot.record);
    for (const passage of passages) {
      await this.memory.remember(this.tier, this.scope, {
        id: this.passageId(doc.id, passage.index),
        content: this.storedPassage(passage),
      });
    }
    const committed: DocRecord = { ...pending, committed: true, revision: pending.revision + 1 };
    await this.appendRecord(committed);
    // Prune only after the committed row is durable, and only rows this call has seen: a
    // concurrent writer's row is not ours to delete.
    const superseded = [...(slot?.rowIds ?? []), this.rowId(doc.id, pending.revision)];
    await this.memory.forget(this.tier, this.manifestScope, superseded);
    return passages;
  }

  /**
   * Reconcile the corpus against the documents the source currently has: write what is new
   * or changed, leave what is identical, remove what the source dropped.
   *
   * This is the operation a knowledge base is actually run with — a wiki export, a docs
   * directory, a table of policies — and it is what makes deletion complete rather than
   * best-effort. Without it, a document deleted upstream keeps answering questions.
   *
   * Cost is one manifest read (rows are ids and counts) plus writes for the documents that
   * genuinely changed — NOT a rewrite of the corpus, which is the whole point of the
   * fingerprint. Re-running it on an unchanged source writes nothing.
   *
   * `docs` is the COMPLETE set. Passing a subset removes everything not in it, which is
   * the correct reading of "reconcile" and the wrong thing to do with a page of results.
   */
  async sync(docs: readonly KnowledgeDoc[]): Promise<SyncResult> {
    const manifest = await this.manifest();
    const result: SyncResult = { written: [], unchanged: [], removed: [] };
    const seen = new Set<string>();

    for (const doc of docs) {
      if (seen.has(doc.id)) {
        throw new Error(
          `KnowledgeBase.sync: duplicate document id "${doc.id}". Ids identify a document across revisions, so two documents sharing one would each supersede the other on every sync.`
        );
      }
      seen.add(doc.id);
      const slot = manifest.get(doc.id);
      if (slot?.record.committed === true && slot.record.fingerprint === this.fingerprint(doc)) {
        result.unchanged.push(doc.id);
        continue;
      }
      // An UNCOMMITTED row is rewritten even when the fingerprint matches. That case is
      // exactly the crash this design exists for, and treating it as unchanged is how a
      // document disappears from a corpus that still lists it.
      await this.write(doc, slot);
      result.written.push(doc.id);
    }

    for (const [docId, slot] of manifest) {
      if (seen.has(docId)) continue;
      await this.removeRecordedPassages(slot.record);
      await this.memory.forget(this.tier, this.manifestScope, slot.rowIds);
      result.removed.push(docId);
    }
    return result;
  }

  /** The documents this corpus holds, in manifest order. Ids and counts — no passage text. */
  async listDocs(): Promise<DocRecord[]> {
    return [...(await this.manifest()).values()].map((slot) => slot.record);
  }

  /**
   * Retrieve the passages most relevant to a question, best first.
   *
   * `decide` is REQUIRED, and it is a type requirement rather than advice for the reason
   * ADR 0090 gives: a corpus grows and is edited, so the passages a question retrieves
   * genuinely differ between a run and its replay. Recorded, the retrieval is a fact and
   * the replay rebuilds the prompt that actually ran; unrecorded, "reproducing" an
   * incident quietly means asking today's corpus yesterday's question.
   *
   * What is recorded is the passage CONTENT, not passage ids — ids do not reconstruct a
   * prompt once the document behind them has been revised.
   */
  async retrieve(query: string, opts: RetrieveOptions): Promise<Passage[]> {
    const hits = await this.memory.recallRelevant(this.tier, this.scope, query, {
      decide: opts.decide,
      ...(opts.limit !== undefined && { limit: opts.limit }),
      ...(opts.decisionKey !== undefined && { decisionKey: opts.decisionKey }),
    });
    return hits.map(toPassage);
  }
}

/**
 * Open a corpus over a `MemoryStore` directly — the two-line form of the four every
 * consumer was writing by hand.
 *
 * A corpus needs exactly one memory tier and that tier must not evict, which is a fact
 * about corpora and not a decision each application should be re-deriving. Both first
 * consumers built the identical `new TieredMemory({ tiers: { semantic: {} }, store })`
 * before they could construct anything, and an application wiring `defineConfig` cannot
 * pass `app.memory` here at all — that is a {@link MemoryRuntime}, one layer below
 * `TieredMemory` — so the boilerplate was mandatory rather than incidental.
 *
 * Reach for the constructor instead when the corpus shares a memory with something else
 * (a conversation in `episodic`, say), which is exactly when the tier set is a decision.
 */
export function openKnowledgeBase(
  store: MemoryStore,
  opts: Omit<KnowledgeBaseConfig, "memory">
): KnowledgeBase {
  const tier = opts.tier ?? "semantic";
  return new KnowledgeBase({
    ...opts,
    memory: new TieredMemory({ tiers: { [tier]: {} }, store }),
  });
}

/** `docId#index` split at the LAST separator, so a document id may itself contain one. */
function splitPassageId(id: string): { docId: string; index: number } {
  const cut = id.lastIndexOf("#");
  const index = Number(id.slice(cut + 1));
  if (cut < 1 || !Number.isInteger(index)) {
    throw new Error(
      `KnowledgeBase: entry id "${id}" is not a passage id (expected "docId#index"). The corpus scope holds passages this KnowledgeBase wrote; something else appended to it.`
    );
  }
  return { docId: id.slice(0, cut), index };
}

/**
 * A stored entry, as a passage: its identity from the entry id, the rest from `content`.
 *
 * The content half is a cast and not a parse, deliberately: on replay this value comes back
 * out of a `DECISION_RECORDED` payload as plain JSON, and re-validating it would only be
 * able to reject what the log already contains — the value IS what ran. The taint wrapper
 * survives that round trip because it is plain JSON too, which is the property ADR 0085 was
 * built on. The identity half is checked, because an unparseable id means the entry was not
 * written by a KnowledgeBase and a `docId: undefined` would flow straight into a citation.
 */
function toPassage(entry: MemoryEntry): Passage {
  if (entry.id === undefined) {
    throw new Error(
      "KnowledgeBase: a corpus entry has no id, so the document it belongs to cannot be named. Either the backend does not round-trip `MemoryEntry.id` (REQUIRED since MemoryStore SPI 2.0.0 — run `runMemoryStoreConformance` against it), or something other than this KnowledgeBase appended to the corpus scope."
    );
  }
  const { docId, index } = splitPassageId(entry.id);
  const stored = entry.content as Omit<Passage, "docId" | "index">;
  return { docId, index, ...stored };
}

/** A document's live manifest record, plus every row id standing for it right now. */
interface ManifestSlot {
  record: DocRecord;
  rowIds: string[];
}
