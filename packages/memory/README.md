# @loom/memory — agent memory

Scoped memory for agents and flows: ordered lists of entries kept outside the event log, addressed by a
memory id plus a scope (an execution, a conversation, a user). `MemoryRuntime` applies each memory's TTL
and size limits, `TieredMemory` adds named tiers with their own policy plus promotion between them, and
the `MemoryStore` interface is what a backend (SQLite, Postgres, a vector store) implements. Use it
directly when you want recency or relevance recall inside a flow; `defineConfig` already builds one
`MemoryRuntime` for `app.memory` over its `memoryStore` option.

```ts
import {
  DEFAULT_TIERS,
  EmbeddingMemoryStore,
  HashingEmbeddingProvider,
  InMemoryMemoryStore,
  TieredMemory,
} from "@loom/memory";
import type { ExecutionContext } from "@loom/workflow-runtime";

// Any MemoryStore works; wrapping one in EmbeddingMemoryStore makes `search` semantic.
// HashingEmbeddingProvider is the offline reference (lexical overlap only): swap in a real model.
const store = new EmbeddingMemoryStore({
  store: new InMemoryMemoryStore(),
  provider: new HashingEmbeddingProvider(),
  minScore: 0.2, // required: cosine is defined against every entry, so "matches" needs a floor
});
const memory = new TieredMemory({ tiers: DEFAULT_TIERS, store });

await memory.remember("episodic", "user-42", { role: "user", content: "prefers metric units" });
const recent = await memory.recall("episodic", "user-42", { limit: 5 }); // newest N

// Inside a flow, pass ctx.decide: the retrieved set is recorded, so a replay is served the same entries.
export async function relevantFacts(ctx: ExecutionContext, question: string) {
  return memory.recallRelevant("semantic", "user-42", question, { decide: ctx.decide });
}
```

## Surface

- **Runtime.** `MemoryRuntime` (`register`, `append`, `read`, `clear`, `remove`, `search`) keyed by
  `(memoryId, scope)`; definitions come from `memory$({ id, name, ttlMs, maxEntries })` in `@loom/core`.
- **Tiers.** `TieredMemory` (`remember`, `recall`, `recallRelevant`, `promote`, `summarize`, `forget`,
  `clear`) and `DEFAULT_TIERS`: `working` (`summarizeAfter: 20`), `episodic` (`maxEntries: 200`),
  `semantic` and `procedural` (no eviction). A tier policy is `ttlMs`, `maxEntries` or `summarizeAfter`.
- **Stores.** `InMemoryMemoryStore` (default; lost on restart). Durable ones are `SqliteMemoryStore`
  (`@loom/plugin-sqlite`) and `PostgresMemoryStore` (`@loom/plugin-postgres`).
- **Backend contract.** `MemoryStore` needs `append`, `read`, `clear`; `replace`, `search`, `remove` and
  `close` are optional. Also `MEMORY_STORE_SPI_VERSION` (2.1.0), `searchableText`, `tokenize`,
  `queryTerms` / `MAX_QUERY_TERMS`, `clampSearchLimit` with `DEFAULT_SEARCH_LIMIT` and `MAX_SEARCH_LIMIT`.
  `runMemoryStoreConformance` in `@loom/conformance` proves a backend.
- **Embeddings (ADR 0124).** `EmbeddingMemoryStore`, the `EmbeddingProvider` and `VectorIndex` interfaces,
  `InMemoryVectorIndex`, `HashingEmbeddingProvider`, `cosine`, `EmbeddingError`,
  `EmbeddingModelMismatchError`, `MemoryIndexTooLargeError`.

## Behaviour that surprises people

- **Relevance recall needs `search`.** `MemoryRuntime.search` throws if the store has none, and
  `recallRelevant` takes a required `decide` so what reached the prompt is a recorded fact. To search
  without recording (an ops lookup, a test), call the store's `search` directly.
- **TTL is applied after the store's `limit`**, so a search over an expiring memory can return fewer than
  `limit` hits. `read` persists the pruned list; `search` does not.
- **Reads are in append order**, not timestamp order, and an absent key reads as `[]`.
- **`forget` and `clear` are not recorded.** Only recall goes through `decide`.
- **Entry `id` is not indexed.** It is caller metadata that every backend must round-trip; `content` is
  what `searchableText` projects.
- **A tier that evicts cannot hold a corpus.** `@loom/knowledge` refuses `ttlMs` / `maxEntries` tiers for
  that reason.
- **An embedding failure on `append` to an already-indexed key means the append is not made**, so the
  store and its index do not silently disagree.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loom/memory` — agent memory" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [user guide, section 16: tiered memory](../../docs/user-guide.md#16-tiered-memory), [reasoning and memory](../../docs/loom-2.0/02-reasoning-and-memory.md).
- ADRs: [0033 SPI conformance](../../docs/adr/0033-spi-conformance-contracts.md), [0090 knowledge is retrieval over memory](../../docs/adr/0090-knowledge-is-retrieval-over-memory.md), [0124 learning lifecycle](../../docs/adr/0124-learning-lifecycle.md) (embeddings).
- Source: `packages/memory/src`. Retrieval over documents: [`@loom/knowledge`](../knowledge/README.md).
