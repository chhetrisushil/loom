# db-copilot infra series audit — DS&A, security, memory leaks

**Date:** 2026-07-15 · **Scope:** everything merged in the series (PRs #191–#196; ADRs
0058/0059) · **Method:** three independent lenses over the merged code, findings fixed
in-pass or deferred with rationale — the same discipline as the
[perpetual-agents audit](2026-07-15-perpetual-agents-audit.md).

## Fixed in-pass

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| F1 | **Stream-source handle leak** (claim-check ST-2): if `putStream` threw mid-consumption, the counting wrapper stayed suspended at a `yield` and the tool's underlying stream (file handle, socket) was never finalized. | HIGH (leak) | The middleware finalizes the wrapper in a `finally` — `counted.return()` propagates through its for-await to the **source** iterator's `return()` (protocol-correct, no duck-typing). Regression test: a failing store mid-upload now runs the source's `finally`. |
| F2 | **`catchUp` read amplification** (RM): M registered models × E executions = M×E `readFrom` calls re-deserializing the same events M times (14,600 vs 1,460 in the acceptance shape). | HIGH (hot path) | One shared read per execution from the **minimum watermark frontier**, filtered per model by sequence; idempotent apply keeps correctness unchanged. Regression test counts `readFrom` calls with two models. |
| F3 | **SQLite statement re-preparation**: every `apply`/`save`/`put`/`get`/paged-list call re-parsed identical SQL (better-sqlite3 does not cache prepares). | MEDIUM (hot path) | Constructor-prepared statements in `SqliteReadModelStore`, `SqliteContentStore`, `SqliteDurableStateStore`; lazily-cached paged statements in `SqliteEventStore`. Dynamic-`where` query SQL stays per-call by necessity. |
| F4 | **Unbounded query `limit`** (all read-model stores): `limit: MAX_SAFE_INTEGER` materializes everything. | MEDIUM (DoS) | `clampQueryLimit` — positive-integer validation + 10,000 ceiling — exported from the plugin and **pinned as SPI contract** by a new conformance case. |
| F5 | **Malformed-cursor crash** (all read-model stores): `JSON.parse(q.cursor)` threw raw `SyntaxError`s / type-confused on non-tuple JSON. | MEDIUM (availability) | `parseQueryCursor` — parse + shape validation, loud `TypeError` with guidance — shared by all three backends, conformance-pinned. |
| F6 | **Non-advancing-cursor spin** (`iterateExecutionIds`): a buggy 3P store returning the same `nextCursor` forever would spin every maintenance pass. | LOW (hardening) | The iterator refuses loudly when the cursor does not advance. |
| F7 | **Postgres `apply` N+1** (noted deferred in ADR 0058). | MEDIUM (multi-node latency) | Batched multi-VALUES inserts (500 rows/round-trip, 4,000 params — well under the 65,535 cap); `ON CONFLICT DO NOTHING` keeps the batch exactly as idempotent as the loop. |

## Clean (no findings)

**Security:** SQL fully parameterized in both new stores (the SQLite JSON-path `""` escaping
is correct and the path itself is a parameter; `ORDER BY` direction is a boolean-derived
literal; Postgres `where` rides one parameterized JSONB `@>`); no prototype-pollution vector;
tenant scoping holds — `TenantScopedEventStore` lacks `listExecutionsPage`, so scoped
catch-ups fall back to the correctly-scoped `listExecutions`; forged `__loomStreamResult`
objects fail loudly (`TypeError` on iteration, effect fails, nothing recorded); CLI paths are
operator-trusted by design.

**Memory/resources:** `sweepContent` closes all three stores in `finally` (archive included);
Postgres pool ownership flags correct; `sentinelPreset` is allocation-free composition;
`iterateExecutionIds` holds no handles (early break finalizes via the generator protocol);
fire-and-forget `handleEvent` applies are bounded by ingestion×latency with the `onError`
loudness default — acceptable by the documented contract.

## Deferred with rationale

| Item | Why |
| --- | --- |
| `putStream` chunk accumulation in the in-memory/SQLite backends | Inherent: those media hold the full bytes anyway; the ADR 0059 contract puts spooling strategy on the backend, and the future object-store backend is the one that must not buffer. |
| In-memory read-model `structuredClone` per row + full sort per query | Reference-implementation value semantics (matches the durable backends' JSON round-trip); production queries ride SQLite/Postgres indexes. |
| Postgres `Number()` precision on >2^53 sequences | Sequences are per-execution and bounded runs keep them tiny by design (ADR 0051 D1). |
| `handleEvent` backpressure valve | Add only when a real ingest burst shows up; the `onError` hook is the monitoring point. |
| gc sweep one-read-per-execution | Inherent to log-derived mark-and-sweep (ADR 0055); the incremental version is issue #185, evidence-gated. |
