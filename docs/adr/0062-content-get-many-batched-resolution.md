# ADR 0062 — `ContentStore.getMany` + batch-scoped reference resolution

- Status: **Accepted** (optional SPI method, coalescing resolver, cache
  decorator, conformance + bench)
- Date: 2026-07-19
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (TS-10), ADR 0046 (`ContentStore`), ADR 0054 (claim-check), ADR 0059
  (`putStream` — the write-side sequel of the same SPI; this is the read side).
- Part of: the GenUI/DE corrected series. No kernel changes.

## Context

Result-by-reference was specified against a write-heavy, read-rarely profile.
GenUI's frozen-snapshot sharing inverts it: a snapshot is a pointer to a
completed run, and serving it fans out over stored refs with a human waiting.
`ContentResolvingEventStore.resolveRefs` read one ref per round-trip with object
fields resolved *sequentially* — fine in-memory, a latency cliff on any network
backend. Interactive budget: p95 ≤ 150ms for ≤ 50 refs.

## Decisions

### D1 — Optional `getMany` on the SPI, and a version constant for the SPI

`getMany?(refs: ContentRef[]): Promise<(Uint8Array | null)[]>` — positionally
aligned, `null` per absent entry, MUST NOT throw on absence, duplicates legal.
Optional-method + conformance-skip idiom (the `readRange`/`putStream`
precedent). This ADR also introduces `CONTENT_STORE_SPI_VERSION = "1.2.0"`,
retroactively naming 1.0.0 (ADR 0046) and 1.1.0 (`putStream`, ADR 0059) — the
SPI had shipped two revisions without a version anchor for conformance to pin.

### D2 — Batch-scoped, two-phase resolution

Collect (pure DFS over every payload in the read batch, dedupe by content
address) → fetch (**one** `getMany` per `read`/`readFrom`/`readRange` call;
fallback: coalesced `Promise.all` of `get` — still strictly better than the old
sequential awaits) → decode once per distinct blob → substitute (pure rebuild).
First `null` ⇒ `ContentMissingError`, loudness unchanged. O(nodes) + 1
round-trip replaces O(refs) serialized round-trips. `subscribe` resolves
per-event through the same helper. Claim-check gains the batch twin
(`resolveClaimChecks`) under the same outside-the-determinism-boundary rule as
`resolveClaimCheck`.

### D3 — `CachingContentStore`: cache-forever, except deletion

Content addressing makes caching trivially correct — immutable blobs, cache
key = content hash — with exactly one edge: **`delete` must evict before
forwarding.** Erasure/crypto-shredding (K10, T3) must never be resurrected from
a warm cache. Byte-budgeted LRU (`maxBytes`, Map insertion-order, O(1) ops);
`getMany` splits batches into hits + one miss-fetch; a decorator is still a
conformant store and runs the full kit.

## Consequences

- Frozen-snapshot serving meets the interactive budget from the log-owned data —
  no bespoke materialization pipeline duplicating what the store already holds.
- Bench recorded in `docs/benchmarks.md` (latency-injected backend, 50 refs).
- Spec capability `content-batch-resolution` (L4: conformance + bench).
