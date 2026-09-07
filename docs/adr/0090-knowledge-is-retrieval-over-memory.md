# ADR 0090 — Knowledge is retrieval over memory, not a construct

- Status: **Accepted — implemented** (2026-09-07)
- Date: 2026-09-07
- Prompted by: "every agentic execution requires memory and knowledge — would it make sense to
  add memory and knowledge capability in loom?"
- Builds on: the P9 decision seam ([ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md)),
  1P/3P plugin placement ([ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md)),
  the SPI conformance contracts ([ADR 0033](0033-spi-conformance-contracts.md)),
  the second-consumer rule ([ADR 0083](0083-second-consumer-rule.md)),
  the integrity axis ([ADR 0085](0085-untrusted-content-integrity-axis.md))
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged.** No syscall, no event type, no fold
  change. Two adapters in plugins that already owned the databases, one optional verb on an
  existing SPI, and a rule about where the rest belongs.

## Context

`@loom/memory` looked finished. Four tiers with per-tier eviction and summarization, promotion
between them, and — the part most frameworks get wrong — `recall` routed through `ctx.decide`, so
a memory-driven prompt is a recorded fact and a replay rebuilds the prompt that actually ran.

Two things were true underneath it.

**It had no durable backend.** A workspace-wide search for `MemoryStore` implementors returned
exactly one: `InMemoryMemoryStore`. Every store plugin shipped an EventStore, a SnapshotStore, a
TimerStore, a DurableStateStore and a ReadModelStore (SQLite also a ContentStore) and no
MemoryStore. `defineConfig.ts` said so in a comment — *"content is lost on restart"*. So what
shipped was a **prompt-context manager**: an agent that restarted remembered nothing. The seam was
pluggable in principle and unplugged in fact, a shape this repo
keeps producing: a capability whose only producer is its own fallback, indistinguishable in a
green suite from one that works.

**Nothing could retrieve by relevance.** The SPI was `append` / `read` / `clear` keyed by a
string, so recall meant *the tail of this scope*. That is right for a conversation and useless for
the tiers where memory accumulates: `semantic` and `procedural` declare **no eviction at all**, so
their "newest N" means nothing and the only way to use one was to load it whole. The sole mention
of a vector store in the repo was a comment saying you could write one.

So the question decomposed into three, and they have three different answers.

## Decisions

### D1 — Durable memory belongs in the store plugins, not in a new package

`SqliteMemoryStore` and `PostgresMemoryStore`, in the packages that already own those databases,
pointed at the same file/URL as the event log so one backup captures execution history and memory
together. No new package, no new `defineConfig` key: `memoryStore` already existed and had nothing
durable to point at.

**A key names an ORDERED LIST, read back in APPEND order.** Not timestamp order — entries
routinely share a timestamp (one turn written in one tick), so ordering by it silently reshuffles
a conversation, and a backend needs an insertion key of its own. Three conformance cases exist
because they are what a SQL backend gets wrong first and what an in-memory reference *cannot* fail:
append order, list-not-set, and an absent `role` reading back absent rather than as `null` (a
nullable column turns `{ content }` into `{ role: null, content }`, which is a different prompt).

**`replace` (OPTIONAL) is a durability fix, not an optimisation.** `MemoryRuntime` rewrites a
scope's whole list on *every* TTL/`maxEntries` eviction. As clear-then-re-append, a crash between
the two loses the scope — routine eviction would be the thing that destroys memory. Both durable
backends do it in one transaction; the fallback remains for stores without it.

### D2 — `search` is one optional verb, and the projection is the contract

**Rejected: an `EmbeddingProvider` SPI in first-party.** It is provider-shaped, exactly like
`LlmProvider`'s concrete providers, and belongs beside them in third-party. Rejected too: a query
DSL. `search(key, query: string, opts)` takes text, because a text query is what an FTS backend
consumes directly and what a vector backend can embed itself.

What *is* first-party is the pair a backend must agree on: `searchableText(entry)` (the string and
number **leaves** of `content` — not `role`, not the timestamp, not object keys, and a tainted
value contributes its content and not its origin label) and `tokenize`. **What text gets indexed
and what counts as a term are the contract**: a backend indexing something else still returns
matches, just to a different question than the app asked.

Terms are **OR**-ed. `plainto_tsquery` ANDs by default, which makes a longer question return
*fewer* memories — backwards for retrieval. Ranking then sorts it out, and ranking is deliberately
left to the backend: BM25, `ts_rank` and the reference IDF scorer disagree, and a kit that pinned
an order would be pinning an implementation.

Second consumers, named before the verb shipped (ADR 0083): `db-sentinel` retrieving runbooks and
schema notes, `incident-war-room` retrieving past postmortems.

### D3 — Relevance recall requires `decide`; a store that cannot search refuses

`TieredMemory.recallRelevant(tier, scope, query, { decide })` takes `decide` as a **required**
option, where `recall`'s is optional. That asymmetry is the decision, not an oversight.

Recency recall re-reads a list the caller mostly controls. Relevance recall ranks over a corpus
that grows — `semantic` never evicts — so the set returned for one question genuinely differs
between the run and its replay, and a "reproduction" of an incident would quietly be a different
prompt. Making it a *type* requirement beats documenting it. The escape hatch for a non-flow
caller (ops, a CLI, a test) is calling the store's `search` directly, where the bypass is visible
in the code.

`MemoryRuntime.search` **fails loudly** on a store without `search` rather than degrading to
`read`. A silent fallback would look like retrieval, return plausible entries, and be undetectable
downstream — it would surface only as worse answers. It also applies TTL to hits, because expiry
is lazy and the one path that skips the list must not be the one that leaks stale context into a
prompt; and it never writes its view back the way `read` does, since a search sees an arbitrary
subset and persisting that would delete everything the query did not match.

### D4 — For an optional method, PRESENCE IS THE FEATURE FLAG

The runtime tests for `replace`/`search`/`close` and takes a fallback when they are absent. So a
stub that throws is strictly worse than no stub: it advertises a capability the store does not
have, and turns a fallback path into a failure. This is why `loom plugin new memory` emits only
the three required verbs and explains the optional ones in prose — a scaffold that emitted a
throwing optional method would not be a starting point, it would be a bug with a template.

### D5 — Knowledge is application code plus third-party plugins

**Rejected: a `knowledge$` construct in `@loom/core`.** It would encode a vocabulary — documents,
chunks, sources, citations — rather than a mechanism, which is what ADR 0083 gates. `tool$` and
`memory$` already span it.

**Rejected: retrieval inside `agentLoop$`.** Retrieval the agent performs implicitly is a hidden
input to the fold. If it is not passed and logged it is a P2 violation dressed as convenience.

What remains is application code, and everything it needs already existed for other reasons: the
`semantic` tier as the corpus, `MemoryStore.search` as the retriever, `ctx.decide` for
reproducibility, ADR 0085 taint for safety — a corpus is edited by whoever can edit the wiki, so
retrieved passages are third-party content by definition and belong in the fenced `user` position
— and `claimCheckMiddleware` for oversized results.

## Consequences

**A similarity backend has to choose a floor.** The contract's requirement that a query matching
nothing returns `[]` is free for an inverted index (a term is present or it is not) and is the one
real design decision for a vector store, where cosine similarity is defined against *every* stored
entry: unthresholded, `search(key, "unrelated")` returns the whole scope ordered, least-unrelated
first, and is never empty. "Matches" therefore has to be given a meaning, and a minimum score is
the only available one. It belongs in the plugin's options because the right value is a property
of the embedding model, not of the store, and does not transfer between models. Recorded in the
SPI comment and in the conformance kit's own doc, since running the kit is where it bites.

**A portable kit cannot see index maintenance.** A backend that joins its index back to the rows
satisfies the clear/replace search cases whether or not it maintains the index — verified by
removing the FTS5 delete trigger and watching all 80 SQLite conformance cases stay green while the
index grew without bound. That assertion lives in the backend's own suite, and the kit says so
rather than implying coverage it lacks.

## Evidence

`runMemoryStoreConformance` (25 cases) is run by **four** independent implementations: the
in-memory reference (IDF scorer), SQLite (FTS5), Postgres (`tsvector`), and the third-party
`loom-plugin-vector` (cosine over embeddings) — which passes it **unmodified**, and is what makes
"the seam is a contract, not a description of an inverted index" a result rather than a hope.

Two second consumers were built rather than imagined, and each found defects that every package
involved was green through:

- **`runbook-recall`** (loom-examples) — RAG assembled entirely from the primitives above, whose
  suite deletes the entire corpus and replays the execution to the same answer and citations. It
  found that `ctx.decide` could not be passed as a value (`decide: ctx.decide` — the spelling in
  loom's own docs — lost its receiver; `agentLoop$` carried a private workaround at two call sites
  with a comment telling readers to copy it), and that a tainted value's `origin` was being indexed
  as searchable text, so one term matched an entire ingested corpus.
- **`loom-plugin-vector`** (loom-plugins) — the unlike backend, which produced the floor finding
  above and, via `loom plugin check`, the discovery that the scaffold was still minting the
  ESM-unreachable exports map that had just been swept out of 49 packages.

`packages/memory/src/search.test.ts`, `evictionRewrite.test.ts` (both rewrite paths pinned by
recording store calls, since the rewrite is invisible in the resulting entries),
`plugins/sqlite/src/SqliteMemoryStore.test.ts` (the index, read without the join that hides it),
and `packages/workflow-runtime/src/decideBinding.test.ts`.
