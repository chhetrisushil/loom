# ADR 0108 — One order for execution ids, and fail-soft boot migrations

- Status: **Accepted — implemented** (2026-09-28)
- Date: 2026-09-28
- Closes: backlog L10 (`ShardedEventStore` over Postgres shards skipped execution ids when paging).
- Builds on: [ADR 0074](0074-storage-scale-out-decorators.md) (the scatter-gather pager and the
  `Sharded(TenantScoped(…))` composition), [ADR 0091](0091-corpus-lifecycle-and-the-knowledge-package.md)
  (the precedent for a MAJOR SPI bump when a conforming store can fail a new kit case).
- Placement: **SPI + first-party backends** (`@loom/event-runtime`, `@loom/plugin-postgres`,
  `@loom/conformance`). **`EVENT_STORE_SPI_VERSION` 1.5.0 → 2.0.0.** KERNEL_ABI and
  EVENT_SCHEMA unchanged. No method added or removed.

## Context

`listExecutionsPage` promised "lexicographic" order and an opaque cursor. That names no one
order. `PostgresEventStore` paged in the database collation (`en_US.UTF-8` puts `a_b` before
`A1`); `ShardedEventStore` merged shard pages with JavaScript's sort (`A1` first) and handed the
merged page's last id back to EVERY shard as the cursor. Each shard then skipped the ids that sort
after that cursor in one order and before it in the other. On a PG 17 `en_US.UTF-8` cluster, 17
mixed-case ids paged through three shards came back as 12 entries: 9 missing, 3 duplicated.
Retention, read-model catch-up and every `iterateExecutionIds` pass over a sharded Postgres log
were silently partial. `Sharded(TenantScoped(…))` also looped forever, because the tenant view
handed out its inner, prefixed cursor and got an outer id back.

## Decision

### D1 — Execution ids page in Unicode code point order; the cursor is an id (MAJOR)

- Order: Unicode **code point** order, which is UTF-8 byte order, SQL `COLLATE "C"` and SQLite
  BINARY. `compareExecutionIds` (`@loom/event-runtime`) is the reference comparator. It is not
  JavaScript's default order, which compares UTF-16 code units and disagrees on astral
  characters. The guarantee covers well-formed Unicode ids only: a lone surrogate cannot
  round-trip through UTF-8.
- Cursor: an executionId, **any string** (not only one the store returned). The page holds the
  ids strictly after it. `nextCursor` **must** be the page's last id.
- Why MAJOR: a store that conformed to 1.x (any order, an opaque cursor token) can fail the new
  kit case. `ShardedEventStore` needs all three rules, and `TenantScopedEventStore` now relies on
  the order to seek to its tenant's contiguous range and stop at its end. That is the rule that
  made MemoryStore 2.0.0 (ADR 0091). `checkCompatibility` refuses a `1.x` EventStore.

### D2 — Postgres: the column is `COLLATE "C"` (option B)

`events.execution_id` is declared `TEXT COLLATE "C"`, and the paging query also says
`COLLATE "C"`, so the order is right even on a column that has not been converted.

Measured on 1M executions / 2M events (PG 17, `en_US.UTF-8`, heavily loaded host, so compare
plan shapes more than milliseconds):

| Option | Paging plan | Per 1000-id page | Append cost (100k events, 3 rounds) |
|---|---|---|---|
| `COLLATE "C"` query, no matching index | parallel seq scan + external sort | ~230 ms; a full pass is quadratic | — |
| A: extra index `((execution_id COLLATE "C"))` | index-only scan | p50 1.2–1.7 ms | 9–13% slower (a fourth btree) |
| **B: column `COLLATE "C"` (chosen)** | index-only scan on `idx_events_exec`, no sort | p50 0.5–3.5 ms | 23–36% faster (memcmp, not `strcoll`) |

B wins on the hot write path, which is loom's measured bottleneck. Its cost is a one-time
conversion of existing tables: the change is binary-coercible (no table rewrite), but the two
`execution_id` indexes are rebuilt under an ACCESS EXCLUSIVE lock, about 4.5 s per 2M events.

### D3 — Boot migrations that take an exclusive lock are bounded and fail soft

`migrate()` runs at boot, so a migration that locks a hot table can stall or crash-loop a
deployment. Every future migration of that kind follows the same policy as this one:

1. **Bound the lock wait.** Set `lock_timeout` locally around the statement (here
   `MigrateOptions.lockTimeoutMs`, default 2000 ms). While an `ALTER` waits for its lock, every
   append queues behind it.
2. **Re-`ANALYZE` after a type change.** `ALTER … TYPE` drops the column's statistics, and the
   planner then chooses a seq scan + sort until autovacuum happens to run.
3. **Fail soft when correctness does not depend on it.** If the lock times out, a user view or
   rule depends on the column, or the role does not own the table, boot continues and a
   `WARNING` carries the exact statements to run by hand. Here only paging *speed* depends on the
   conversion, because the query states its own collation. A migration that correctness *does*
   depend on must keep failing loudly.
4. Guard it with a catalog check so later boots are no-ops, and look catalog objects up in a way
   supported by every Postgres the plugin supports (no `::regcollation`, which needs PG 13+).

## Consequences

- A third-party EventStore that implements `listExecutionsPage` must page in code point order
  with id cursors; the conformance kit checks it, including a cursor the store never returned.
- SQLite already conformed. The in-memory store now sorts with `compareExecutionIds` and keeps its
  sorted index across pages.
- `TenantScopedEventStore` reads its tenant's range only, rather than the whole shared store.
- Operators of large Postgres logs should plan the one-time conversion (D2), or run the two
  statements from the D3 warning themselves in a maintenance window.
- Out of scope: `BranchRegistry.listRefs` orders refs three different ways across backends
  (tracked separately), and other Postgres keyset pagers were not audited for the same mismatch.
