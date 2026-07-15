# ADR 0058 — `@loom/plugin-read-model`: durable, checkpointed cross-execution read models

- Status: **Accepted — shipped** (plugin + in-memory/SQLite/Postgres backends + conformance kit)
- Date: 2026-07-15
- Builds on: [the db-copilot infrastructure requirements](../requirements/2026-07-15-db-copilot-infrastructure.md)
  (§3 RM, issue #183), the perpetual-agents series (ADRs 0051–0057), ADR 0043 (plugin packaging),
  ADR 0049 (projections fold on demand).
- Part of: the db-copilot infra series (RM, issue #183). No kernel changes; KERNEL_ABI and
  EVENT_SCHEMA untouched.

## Context

The copilot's institutional-memory queries ("why is this column nullable?", "what happened in
the March migration?") span years of findings and decisions across millions of executions. The
existing read paths — per-execution `read()` + the in-process `ProjectionRuntime` (ephemeral,
LRU-bounded, rebuilt from scratch on restart) — re-fold the world on cold start and cannot
answer field-filtered, paged queries across executions.

Two constraints shaped the design: `EventStore.subscribe` is **per-execution** (no store-wide
positioned feed exists, and inventing one would be a kernel change), and the CI layering guard
forbids kernel packages from depending on plugins (so no `defineConfig` field can name this
plugin — wiring rides the existing `onEvent` seam).

## Decisions

### D1 — A read model is a cache of the log with a watermark, never an authority (RM-2)

App-declared **extractors** (`{ id, kinds, indexes, extract(event) → rows }`) index domain
events into a persisted row store. `rebuild()` = clear + re-scan; the conformance suite pins
that a rebuilt model equals the incrementally-built one. Queries are read-only and never
recorded — replay never touches a read model, so determinism is untouched by construction.

### D2 — Convergent ingestion: idempotent apply + monotonic per-execution watermarks (RM-1)

No global event order exists, so the design does not require one:

- **Rows are idempotent** per `rowId` (`eventId`, suffixed by `rowKey` for multi-row
  extractions): applying the same row twice is a no-op.
- **Watermarks are monotonic** per `(modelId, executionId)`: `apply(model, execution,
  upToSequence, rows)` advances the high-water mark (never regresses), even when no rows
  matched.

Any mix of feeds therefore converges: the **live tail** (`service.handleEvent` wired into
`defineConfig({ onEvent })` — the same in-process path projections use; fire-and-forget with
an `onError` hook so a throwing model never breaks the execution pipeline), the **catch-up
scan** (`listExecutions` + `readFrom(execution, watermark + 1)` — the RM-1 cold-start
property: applied history is skipped, not re-folded), and **multiple nodes** ingesting into a
shared backend. Reserved `__loom_*` control streams are never indexed. A source that cannot
be enumerated makes catch-up **refuse** (silent under-indexing would masquerade as "no
results" in decisional queries — the same safety stance as the K10.6 sweep). Archive stores
participate as additional sources (RM-4), so month-1 decisions stay queryable after K10.1
archival.

### D3 — The store SPI is a dumb indexed row store; queries are kind + field-equality, keyset-paged (RM-3)

`ReadModelStore`: `apply` / `watermark` / `watermarkedExecutions` / `query` / `clear`. All
model knowledge lives in the service. Queries filter by `kind` and ANDed equality over
**declared** indexed fields (undeclared fields are a loud `TypeError` at extraction), ordered
over `(timestamp, sequence, rowId)` with **keyset pagination** (opaque cursor; no
duplicates/gaps across pages — conformance-pinned in both directions). Backends: in-memory
reference (deep-cloning), SQLite (`json_extract` equality, row-value cursor comparison, same
one-file-one-backup discipline as the other stores), Postgres (JSONB `@>` containment over a
`jsonb_path_ops` GIN index, `GREATEST` watermark upserts — multi-node convergent without
locks). `runReadModelStoreConformance` in `@loom/conformance` (structural idiom).

### D4 — Explicitly out of scope

Folded-state (aggregate) durable projections — this plugin indexes *rows*; an aggregate-state
variant can layer on the same watermark machinery when a consumer needs it. Full-text or
range queries — equality over declared fields is what the decisional layer needs; ranges ride
`timestamp` ordering. The SW incremental sweep (issue #185) consumes this plugin later;
SP paging (#184) will bound `catchUp`'s enumeration when it lands.

## Consequences

- Acceptance §5.1 is proven in-tree: a year of db-sentinel-shaped logs (1,460 executions)
  indexes incrementally and answers a by-target, newest-first query in well under 100ms; a
  warm re-scan touches zero events; drop-and-rebuild yields identical rows.
- The copilot wires it in three lines today: construct the service, register models, pass
  `onEvent: (e) => service.handleEvent(e)` to `defineConfig` and run `catchUp([live, archive])`
  at boot — no kernel or `@loom/app` change, layering guard intact.
- Postgres `apply` inserts rows one statement at a time (idempotence makes batching a pure
  optimization); batch it when a real ingest rate demands.
