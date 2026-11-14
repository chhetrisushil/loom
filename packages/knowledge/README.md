# @loomwork/knowledge — document corpora over memory

A corpus of documents you ingest, revise, delete and retrieve passages from, built on the memory seam. There
is no `knowledge$` construct and no separate embedding interface (ADR 0090): this package owns the one thing
a `MemoryStore` cannot, which is the mapping from a document (what you edit) to its passages (what you
search). Re-ingesting a revised document supersedes its old passages instead of indexing both. Use it for
retrieval-augmented answers over a runbook, wiki or policy set. `app.knowledge(scope)` opens one over the
same `memoryStore` that backs `app.memory`.

```ts
import { InMemoryMemoryStore } from "@loomwork/memory";
import { assertGrounded, groundedRequest, openKnowledgeBase } from "@loomwork/knowledge";
import type { ExecutionContext } from "@loomwork/workflow-runtime";

const kb = openKnowledgeBase(new InMemoryMemoryStore(), { scope: "runbooks" });

// `sync` takes the COMPLETE set: new or changed documents are written, absent ones are removed.
await kb.sync([
  { id: "restart-db", title: "Restarting the database", text: "Drain connections first.\n\nThen restart." },
]);

export async function ask(ctx: ExecutionContext, question: string) {
  // `decide` is required: the retrieved passages are recorded, so a replay rebuilds the same prompt.
  const passages = await kb.retrieve(question, { decide: ctx.decide, limit: 4 });
  // Passages go in fenced user messages, never the system prompt.
  const request = groundedRequest({ instructions: "Answer from the passages only.", question, passages });
  // After the model answers, check the document ids it cited: throws for one it was never shown.
  const cited = assertGrounded(["restart-db"], passages);
  return { request, cited };
}
```

## Surface

- **Corpus.** `openKnowledgeBase(store, { scope, tier?, chunker?, origin? })`, or `new KnowledgeBase({ memory,
  scope, ... })` over a `TieredMemory` you share with something else. Methods: `putDoc` (upsert), `sync`,
  `planSync` (dry run, same result shape), `removeDoc`, `listDocs`, `retrieve`.
- **Chunking.** `packParagraphs(maxChars = 1000)` is the default: split on blank lines, then pack. Pass
  your own `Chunker` for structured text.
- **Prompt boundary.** `groundedRequest` and `passageMessages` build the request; `checkCitations`,
  `assertGrounded` and `UngroundedCitationError` check which documents an answer claims.
- **Types.** `KnowledgeDoc` (`id`, `title?`, `text`, `meta?`), `Passage`, `DocRecord`, `SyncResult`
  (`written`, `unchanged`, `removed`, `retained`), `SourceOptions`, `RetrieveOptions`.
- **CLI.** `loom knowledge` operates a corpus from the command line.

## Behaviour that surprises people

- **Passage text is tainted at ingest** (ADR 0085) and stays tainted into the model request, so
  `guardRequest` refuses it in a system prompt. That is why `groundedRequest` types `instructions` as a
  plain string and sends one `user` message per passage.
- **`sync` is a destructive reconcile.** Passing a subset removes every other document of that writer.
  Unchanged documents are skipped by fingerprint over title, text and `meta`.
- **One document, one writer.** Pass `{ source }` to name a writer; a `sync` leaves other sources'
  documents alone and reports them as `retained`, and `putDoc` on a document another writer owns throws.
- **The tier must not evict.** A tier with `ttlMs` or `maxEntries` is refused at construction, and
  `app.knowledge` throws if a `memory$` with those limits shares the tier. Use `semantic` (the default) or
  `procedural`, or give the corpus its own tier.
- **Retrieval records content, not ids**, so a replay still works after the document behind a passage was
  revised. `assertGrounded` compares exact document ids and does not judge whether a claim follows from a
  passage.
- **`putDoc` is crash-safe by write order** (an uncommitted manifest row first), so a crash converges on a
  rewrite instead of a document that the status views call present but that has no passages.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/knowledge` — a corpus over the memory seam" in [docs/api-reference.org](../../docs/api-reference.org). It shows `openKnowledgeBase(config)`; the source takes `(store, options)`.
- Guide: [user guide, section 8: intent, planner and memory](../../docs/user-guide.md#8-intent-planner--memory).
- ADRs: [0090 knowledge is retrieval over memory](../../docs/adr/0090-knowledge-is-retrieval-over-memory.md), [0091 corpus lifecycle](../../docs/adr/0091-corpus-lifecycle-and-the-knowledge-package.md), [0085 untrusted content](../../docs/adr/0085-untrusted-content-integrity-axis.md).
- Source: `packages/knowledge/src`. Storage and tiers: [`@loomwork/memory`](../memory/README.md).
