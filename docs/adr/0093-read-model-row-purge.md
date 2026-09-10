# ADR 0093 — Row-granular purge on the read-model SPI

- Status: **Accepted — implemented** (2026-09-10)
- Date: 2026-09-10
- Implements: the item [ADR 0092](0092-adaptive-operator-profiles-placement.md) D6 deferred,
  and supplies the measurement its gate asked for (below).
- Builds on: [ADR 0058](0058-read-model-plugin.md) (the read-model plugin and its
  cache-not-authority contract), K10.2 crypto-shredding, `@loom/compliance`'s `eraseSubject`.
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged (1.18.0).** A plugin SPI grows one
  optional method: `READ_MODEL_STORE_SPI_VERSION` 1.0.0 → **1.1.0**.

## Context

[ADR 0092](0092-adaptive-operator-profiles-placement.md) D6 recorded that subject erasure never
reaches a derived read model, and deferred the efficient fix: *"reopen when a measured rebuild
cost at production log size exceeds the erasure SLA."*

The gate was **lifted by decision** rather than tripped, and the measurement was taken afterwards
instead of before. It is recorded here so the record shows which of the two happened, and because
the number turned out to matter more than the deferral assumed.

`plugins/read-model/src/purge.bench.ts`, erasing one subject of 50 from a 20,000-event corpus:

| path | mean | |
|---|---|---|
| `purge` | **0.49 ms** | work proportional to the erased subject's rows |
| `clear` + rebuild | **33.8 ms** | work proportional to the whole log |

**68×**, and the ratio is not the interesting part — the *shape* is. Rebuild's cost is independent
of how much of the model the subject owned, so the cheapest possible erasure (one operator out of
a thousand, three rows) costs a full re-scan of everything everyone else ever did. The first draft
of that bench measured 2.08× because seeding sat inside both timed bars; the correction is noted
in the file, because a 2× gap and a 68× gap justify different decisions.

## Decisions

### D1 — One optional method, equality over declared indexed fields

```ts
purge?(modelId: string, where: Record<string, ReadModelScalar>): Promise<number>;
```

Same equality semantics as `query`, ANDed, so a purge deletes exactly the rows the equivalent
query would have returned — a caller can *see* what it is about to erase, with the tool it
already has. Returns the count, because an erasure that reports nothing is indistinguishable
from one that did nothing.

MINOR, not MAJOR: a backend that omits it behaves precisely as it did at 1.0.0.

### D2 — Watermarks are not touched, and that is what makes it an erasure

The tempting implementation clears the affected watermarks, on the reasoning that the rows are
gone so the history should be re-read. That reasoning is exactly backwards: the source events are
still in the log (a shred destroys a *field*, not the row's existence), so the next incremental
catch-up would re-derive the rows just deleted, and the erasure would silently undo itself
somewhere between one restart and the next.

Purge means *these rows are erased*, never *re-read this history*. The conformance kit pins it.

### D3 — An empty filter is refused, in both directions

`purge(modelId, {})` throws. Read as match-all it silently wipes a model; read as match-none it
reports an erasure that never happened. Both are wrong, and neither is the caller's intent: an
empty filter is what a caller *computes* — from a subject id that resolved to nothing, a tenant
lookup that missed — rather than what anyone writes. Match-all already has a name (`clear`) and
requires typing it.

This is the [vacuous-input](0083-second-consumer-rule.md)-shaped failure the repo keeps finding:
an absent input that silently means "pass". `assertPurgeFilter` is contract, not hygiene —
backends route through it, exactly as they do `clampQueryLimit`.

### D4 — A backend that cannot purge refuses loudly

`ReadModelService.purge` raises a typed `PurgeUnsupportedError` naming the `clear` + rebuild
fallback rather than resolving with zero. The alternative — silently performing the no-op — hands
a caller under a legal erasure obligation a successful-looking result for work that did not
happen. Typed rather than a bare `TypeError` so a compliance path can catch it and choose the
*O(log)* fallback deliberately.

The service refuses a filter naming an undeclared field for the same reason: only declared fields
are stored on a row, so such a filter could never match, and "erased 0 rows" would be the report.

### D5 — The Postgres backend joins the conformance kit

Adding an optional method exposed that `PostgresReadModelStore` was covered by one hand-rolled
case while `SqliteReadModelStore` was held to `runReadModelStoreConformance` — the portable
contract was enforced on one backend and assumed on the other. It now runs the kit, which is how
the four new purge cases execute against real Postgres semantics (`fields @> $2::jsonb`) rather
than against an in-memory approximation of them.

## Consequences

- Erasure of one subject from a read model is now proportional to that subject.
- `clear` + rebuild remains correct and remains the fallback; nothing about RM-2 changes.
- Third-party backends are unaffected until they implement the method, and the conformance kit
  skips the purge cases for those that do not.
- The extractor obligation from [ADR 0092](0092-adaptive-operator-profiles-placement.md)'s
  addendum still stands: purge removes rows that already exist, and says nothing about what a
  *rebuild* does with `{ $shredded }` placeholders.
