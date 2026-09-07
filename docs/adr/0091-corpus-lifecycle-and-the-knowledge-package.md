# ADR 0091 — A corpus is mutable: entry identity, and `@loom/knowledge`

- Status: **Accepted — implemented** (2026-09-07)
- Date: 2026-09-07
- Prompted by: a reopening of ADR 0090's D5 — "knowledge is an innate requirement in the agent
  era, so there should be a knowledge seam or at least a package"
- Amends: [ADR 0090](0090-knowledge-is-retrieval-over-memory.md) (D5 in particular)
- Builds on: the second-consumer rule ([ADR 0083](0083-second-consumer-rule.md)), the integrity
  axis ([ADR 0085](0085-untrusted-content-integrity-axis.md)), SPI conformance contracts
  ([ADR 0033](0033-spi-conformance-contracts.md)), the decision seam
  ([ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md))
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged.** No syscall, no event type, no fold
  change. One optional verb and one required field on an existing SPI
  (`MEMORY_STORE_SPI_VERSION` 1.0.0 → **2.0.0**), and one first-party package that owns no
  storage of its own.

## Context

ADR 0090 answered "should loom have knowledge?" with three verdicts, and two of them still hold:
durable memory belongs in the store plugins, and relevance retrieval is one optional `search`
verb. The third — **D5, knowledge is application code** — was argued from a corpus that only ever
grows, and that premise is wrong.

`MemoryStore` is `append` / `read` / `clear` keyed by a string. `search` ranks within ONE key, so
a searchable corpus has to be one key. A document — the unit that actually gets revised and
deleted — is a subset of that key, and the SPI could not name a subset. Concretely, on everything
0090 shipped:

- re-ingesting an edited document **duplicated** it. `append` is a list, so the corpus kept both
  revisions and retrieval returned the superseded passage beside the current one, with nothing in
  the result saying which was live.
- the only removal verb was `clear`, on the whole scope. Fixing one line of one wiki page meant
  rebuilding the entire corpus.
- a document deleted upstream kept answering questions forever.

None of that is visible in a green suite, because every test ingests once. `runbook-recall`, the
example 0090 shipped to prove knowledge needs no loom surface, ingests a fixed array at startup
and never revises it — which is precisely why it proved what it did.

So the reopening is legitimate, but not for the reason it was raised. "Agents need knowledge" is a
statement about ubiquity, and ubiquity is an argument for availability, not for surface — D5's
rejection of a `knowledge$` construct was right and stays. What reopens D5 is narrower and
mechanical: **the unit a corpus is searched in is not the unit it is edited in, and the SPI forced
a choice between them.**

## Decisions

### D1 — Entry identity is REQUIRED; `remove` is the optional verb

`MemoryEntry.id` is optional for a caller and **mandatory for a backend to round-trip**.
`MemoryStore.remove(key, ids)` is optional, with the runtime falling back to read-filter-`replace`.

The asymmetry is the decision. `remove` is optional because its fallback is *correct* — reading a
key, dropping the named entries and rewriting it produces exactly the right state, just in
O(scope). Identity is not optional because the fallback DEPENDS on it: a backend that dropped ids
would make read-filter-replace match nothing and delete nothing, silently, on the path taken by
precisely those backends that have no native delete. That is the failure shape this repo keeps
producing — a capability that is present, plausible and inert — so the conformance kit tests the
round trip for every backend, `remove` or not.

This makes the SPI version **2.0.0** rather than 1.1.0. Both first-party SQL backends decompose an
entry into columns, and a decomposing backend silently drops a field nobody told it to keep;
adding a case they fail is a breaking change by this repo's own rule, and the seam now has an
implementation outside this workspace to break. (`loom-plugin-vector`, which stores the entry
object whole, conforms unchanged — the same split that decides who has work to do.)

Neither SQL backend needed a migration or a column: both already persist the entry as JSON, so the
id is read back out of it (`json_extract(entry,'$.id')`, `entry->>'id'`) behind a partial
expression index. A column would have been a second copy of a value the SPI already round-trips,
and therefore a thing able to disagree with it.

`remove` matching an entry with NO id is the sharp edge. SQL NULL handles it for free — `NULL IN
(…)` is never true — but a JavaScript backend comparing `entry.id` against a Set will happily
match `undefined` against nothing and then match the *string* `"undefined"` against a missing
field if it stringifies first. The kit passes `["a", "undefined", "null", ""]` for that reason.

### D2 — `@loom/knowledge`: the document ↔ passage mapping, and nothing else

A first-party package, ~200 lines, owning no storage and no ranking. `KnowledgeBase` sits over an
ordinary `TieredMemory` and holds exactly what neither the store nor the app should:

- **`putDoc` is an UPSERT.** The passage ids of a document are derived (`docId#0…docId#n`), so a
  small manifest row holding the count IS the id list, and a revision can delete precisely its
  predecessor's passages.
- **`sync(docs)` reconciles** the corpus against the source's current set: write what changed
  (compared by a `canonicalJson`+`fnv1a64` fingerprint over the whole document, so a changed title
  or `meta` counts as a revision), leave what did not, remove what the source dropped. An
  unchanged source costs one manifest read and zero writes, which is what makes it runnable on a
  schedule — and what makes deletion complete rather than best-effort.
- **the manifest is append-only, and pruned afterwards.** Rows are `docId#<generation>`, the
  highest wins, and superseded rows are removed only once the new one is durable. The obvious
  alternative — delete the old row, write the new one — has a crash window in which the document
  has NO row, and a document nothing counts is a document nothing can remove. This was not
  theoretical: the first implementation did exactly that, and the crash test written against it
  failed.
- **a two-phase `committed` flag**, for the inverse window. A manifest row that claims a revision
  whose passages were never appended would make every later `sync` compare fingerprints, match,
  and skip the document *forever* — a corpus silently missing a document that every status view
  lists as present. Writing the row uncommitted first, and flipping it only after the passages
  land, converges on a re-run instead.
- **the tier must not evict**, and the constructor refuses one that does. Under `ttlMs`/
  `maxEntries` the store would drop passages the manifest still counts, and a document would
  retrieve as a fragment of itself with nothing downstream able to tell.

What is NOT in it, and why: a chunker beyond an ignorable default (`packParagraphs`) — how a
document splits is a property of the corpus and is most of retrieval quality; a document
vocabulary beyond `{ id, title?, text, meta? }` — `source`, `section`, `author`, `updatedAt` differ
per corpus and belong in `meta`, which travels verbatim; embeddings — provider-shaped, third-party,
exactly as 0090 said; and retrieval inside `agentLoop$` — still a hidden input to the fold.

### D3 — Two mechanisms that were app code and should not have been

**`groundedRequest` / `passageMessages`.** Retrieved passages become one `user` message per
passage, taint intact, with the untrusted-content note in `system`. The shape almost every RAG
tutorial writes — passages joined into a string under a header in the SYSTEM prompt — is refused by
`guardRequest` at run time (ADR 0085), so today every author meets this rule as a *failure* rather
than as a default. `groundedRequest` types `instructions` as `string`, so the natural mistake does
not compile; the runtime refusal stays as the second belt. One message per passage rather than a
join, because taint is attached to a value: joining means unwrapping first, and provenance stops
travelling exactly where it starts to matter.

**`checkCitations` / `assertGrounded`.** A claimed citation outside the retrieved set was not
misread from a passage — there was no passage. Because the retrieval is recorded, the set of
documents the model could possibly have read is known exactly, which makes this the one
hallucination in a RAG answer that is *decidable* rather than judged. It costs a set membership
test and is almost never written. It deliberately does not check whether the answer's claims follow
from the cited passage: that needs a judge, it belongs to `@loom/learning`'s evaluation surface, and
merging the two would turn a decidable check into an approximate one.

### D4 — What this does NOT reopen

**No `knowledge$` construct** (0090 D5 stands): it would encode documents/chunks/citations as
kernel vocabulary. **No knowledge SEAM**: there is nothing to plug — ranking is `MemoryStore`'s
seam, embeddings are a third-party backend's business, and a `KnowledgeBase` with an alternative
implementation would differ only in its manifest layout. The user's request named "a seam or at
least a package"; the honest answer is that the package is the right half of that disjunction, and
the seam it would have needed already exists one layer down.

### D5 — What a passage puts in the index is part of the package's contract

A store indexes the string and number LEAVES of an entry's `content`, so the shape a passage
is stored in decides what it matches. Three of its five fields are therefore stored
differently from how they are returned:

- `docId` and `index` are **not stored in `content` at all**. Storing them would make a
  document's own id a term matching all of its passages, and the chunk ordinal a term
  making `search("0")` match the first passage of every document in the corpus. Both are
  the widening that made a tainted value's `origin` unindexable (ADR 0090 D2), and both are
  what the SPI already forbids for `MemoryEntry.id`. They survive in the entry id —
  `docId#index`, required to round-trip and never indexed — which is the second place that
  requirement earns its keep. A corpus entry with no parseable passage id is REFUSED on
  read rather than yielding `docId: undefined`, which would flow straight into a citation.
- `title` and `meta` ARE indexed, deliberately for the first and by the same rule for the
  second. A question is often phrased in a document's title. `meta` is the caller's own
  vocabulary, which makes it useful as a filter and surprising as a relevance term: a
  `{ team: "payments" }` stamped on 300 documents makes "payments" match all 300. Pinned by
  a test rather than left to be discovered.

## Consequences

**`sync` is proportional to documents, not to the corpus.** One manifest read (ids, counts and
hashes — never passage text) plus writes for what genuinely changed. The cost that remains is that
manifest read, which grows with the number of documents; a corpus of hundreds of thousands of
documents would want the manifest paged or indexed, and this is the point at which that becomes a
real design question rather than a hypothetical one.

**A backend without `remove` pays O(scope) per document edit.** Correct, and slow in a way that is
invisible until the corpus is large. The plugin-authoring guidance is now "implement `remove` if
the backend can express a delete", and both first-party SQL backends do it in one indexed
statement — with the SQLite suite asserting the query plan actually USES that index, since an
index the planner ignores turns the fast path back into the slow one with extra steps.

**`@loom/memory` was missing from `SPI_PACKAGES`**, and had been for as long as the seam
existed. `loom plugin check` reported a green "SPI packages are peer dependencies" to every
memory backend while being structurally unable to see the one package that matters to it —
the same vacuity the list's `@loom/learning` entry was added to fix. For this seam a bundled
copy is not a duplicate kernel but a duplicate CONTRACT: `searchableText`, `tokenize` and
`clampSearchLimit` decide what a backend indexes and what counts as a term, so a plugin
carrying its own copy can answer a different question than the app asked and still pass
conformance. Fixed here because ADR 0091 is what made a third-party memory backend likely
enough to matter.

**The manifest occupies a second scope** (`<scope>::docs`) in the same tier. Anything walking a
tier's scopes sees it. Keeping it in the corpus scope was the alternative and it is worse: a
manifest row in a searchable corpus is an entry that matches queries and answers nothing.

## Follow-on — the wiring surfaces (2026-09-07)

Three DX surfaces, none of them a new decision, all of them the same question: a corpus lives in
the app's `memoryStore`, and nothing connected the two.

`app.knowledge(scope)` opens one over the configured store, cached per scope. Its two refusals are
the content: **options on an already-open corpus** throw rather than being ignored (two parts of an
app configuring one corpus with different chunkers chunk it differently on alternate ingests, and
the only symptom is retrieval quality), and a corpus tier that a registered `memory$` would evict
throws with the escape named — both run over one store, and only the runtime that READS applies its
own policy, so `app.memory` would evict passages the corpus manifest still counts.

`loom knowledge sync | list | search` operates a corpus from outside a flow. `sync` is a dry run by
default, because the reconcile deletes what the source no longer lists; its preview is
`KnowledgeBase.planSync`, the same classification `sync` runs, so it previews the real operation and
not a second implementation of it. `search` prints that the retrieval was **not recorded** — the
ops escape hatch ADR 0090 named, made visible in the output rather than only in the code.

`loom doctor` gains the memory-store check, whose two outcomes are chosen rather than uniform: an
unconfigured store is a SKIP that names the cost (0090's opening symptom), a configured store
without `search` is a FAILURE (someone chose that backend, and relevance retrieval refuses it at run
time). `LoomStores.memoryStore` is therefore present only when CONFIGURED — the distinction is the
signal, and it is what lets `loom knowledge` refuse to ingest into a store the process discards.

The second consumers (ADR 0083) are the CLI itself and `runbook-recall`, which builds its app,
opens its corpus from it, and registers the flow — the ordering `app.knowledge` imposes, documented
rather than hidden.

## Follow-on — two writers, one corpus (2026-09-07)

`@loom/knowledge` was designed around a corpus whose documents are authored elsewhere and
reconciled from a source of truth. Asked whether knowledge that comes from a FEEDBACK LOOP fits
the same structure, the answer is mostly yes — a learning is a document whose author is the
agent, `putDoc` writes it, taint keeps it out of instruction positions, and `ctx.decide` makes a
replay reconstruct what the agent knew *then*. What did NOT fit is `sync`: a destructive
reconcile over everything the manifest holds would delete every learned document on the next run
of a nightly wiki job, because they are not in the set the wiki produced and never will be.

`DocRecord.source` names the writer that may revise or delete a document, and a reconcile only
ever touches its own. Three details are the decision:

- **`undefined` is a source, not a wildcard.** An unstamped corpus behaves exactly as before, and
  a named source cannot quietly adopt documents nobody claimed.
- **An absent document has no owner**, so any writer may create it. The rule is about not taking
  someone else's, not about permission.
- **A write to a document another writer owns is REFUSED**, not re-stamped. Re-stamping makes the
  two writers fight — each `sync` claims the document and the other's next `sync` deletes it — so
  the corpus flaps between revisions forever while every individual run looks correct.

`SyncResult.retained` reports what a reconcile protected. "Deleted nothing" and "protected four
documents it does not own" describe very different corpora, and only one of them is something an
operator should stop noticing.

What this deliberately does NOT do is judge a learning. Whether one was any good is
`@loom/learning`'s question — trajectories, propensity, off-policy evaluation — and giving a
corpus a notion of reward would duplicate that substrate badly.

## Evidence

- `packages/knowledge/src/KnowledgeBase.test.ts` — re-ingest does not duplicate; a revision's old
  passages stop retrieving (not merely rank lower); a shorter revision leaves no orphans; `sync`
  writes NOTHING for an unchanged source (asserted by recording store calls, since "no-op" and
  "rewrote everything" produce identical corpora); superseded manifest rows are compacted; and the
  crash test — a store that throws mid-ingest — which found the non-atomic manifest update
  described in D2.
- `packages/knowledge/src/durable.test.ts` — the same operations over `SqliteMemoryStore`: a
  revision superseded in the FTS INDEX and not merely in the rows, and a corpus (passages *and*
  manifest) surviving a process restart.
- `packages/memory/src/remove.test.ts` — the fallback proven live on a store with neither `remove`
  nor `replace`, and proven to prefer `replace` where there is one.
- `runMemoryStoreConformance` — 36 cases now (was 25), run by four implementations; the new ones
  cover id round-trip, `replace` preserving ids, an id NOT being searchable text, and seven
  `remove` cases.
- `plugins/sqlite/src/SqliteMemoryStore.test.ts` — `remove` maintaining the FTS index (the kit
  cannot see this: the search join hides a stale index), and the `EXPLAIN QUERY PLAN` assertion.
- `packages/knowledge/src/KnowledgeBase.test.ts` — the searchable projection of a passage
  (D5), pinned in both directions: `docId`/`index` absent from `searchableText`, `title`/`meta`
  present.
- `tools/cli/src/plugin.ts` via `SPI_PACKAGES` — verified by running `checkPlugin` over a
  manifest that bundles `@loom/memory` and watching the warning appear, since a rule that
  cannot fire looks exactly like one that passes.
