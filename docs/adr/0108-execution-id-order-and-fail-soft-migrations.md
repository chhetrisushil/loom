# ADR 0108 — One order for execution ids, and fail-soft boot migrations

- Status: **Accepted — implemented** (2026-09-28; addendum 2026-09-28)
- Date: 2026-09-28
- Closes: backlog L10 (`ShardedEventStore` over Postgres shards skipped execution ids when
  paging) and, per the addendum below, backlog L21 (`BranchRegistry.listRefs` ordered refs
  three different ways across backends).
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

1. **Bound the lock wait, and restore it.** Set `lock_timeout` locally around the statement
   (here `MigrateOptions.lockTimeoutMs`, default 2000 ms; set it with
   `migratePostgresStores(pool, { lockTimeoutMs })` before constructing stores, since the first
   migrator of a pool wins). While an `ALTER` waits for its lock, every append queues behind it.
   Afterwards, restore the caller's own `lock_timeout` (captured first), never a constant, so
   the rest of the migration stays as bounded as the operator configured it.
2. **Do not bound the work.** Exempt that one statement from `statement_timeout` (set it to 0
   transaction-locally, then restore the caller's value). A pool-level timeout shorter than the
   rebuild would otherwise abort it on every boot, taking the exclusive lock each time: a crash
   loop in which the migration never completes. A one-time, bounded stall at boot is the
   accepted cost of D2.
3. **Waiting on the migration lock is not bounded by the caller's timeouts.** The advisory
   lock that serializes migrations is taken with `statement_timeout` and `lock_timeout` set to
   0 (the caller's values are restored as soon as it is held). Queueing behind a peer's
   one-time rebuild is intended; with the caller's timeouts, a node booting mid-rebuild failed
   its migration, and its store then refused every call until the process restarted, which
   moved the crash loop from the migrator to its peers.
4. **Re-`ANALYZE` after a type change.** `ALTER … TYPE` drops the column's statistics, and the
   planner then chooses a seq scan + sort until autovacuum happens to run.
5. **Fail soft when correctness does not depend on it.** If the lock wait times out, an operator
   cancels the statement (`query_canceled`), or a user view or rule depends on the column, boot
   continues and a `WARNING` carries the exact statements to run by hand. Here only paging
   *speed* depends on the conversion, because the query states its own collation. A migration
   that correctness *does* depend on must keep failing loudly. Only catch what boot can
   actually survive: a role that does not own the table is not caught, because the migration's
   next DDL fails for it anyway, and a WARNING would only precede a fatal error.
6. Guard it with a catalog check so later boots are no-ops, and look catalog objects up in a way
   supported by every Postgres the plugin supports (no `::regcollation`, which needs PG 13+).

## Consequences

- A third-party EventStore that implements `listExecutionsPage` must page in code point order
  with id cursors; the conformance kit checks it, including a cursor the store never returned.
- SQLite already conformed. The in-memory store now sorts with `compareExecutionIds` and keeps its
  sorted index across pages.
- `TenantScopedEventStore` reads its tenant's range only, rather than the whole shared store.
- Operators of large Postgres logs should plan the one-time conversion (D2), or run the two
  statements from the D3 warning themselves in a maintenance window.
- The other keyset pagers were audited for the same mismatch: ContentStore, ReadModelStore,
  MemoryStore and the snapshot stores have no JavaScript-side merge and no cursor that crosses
  stores, so their backends' own orders are self-consistent. Only `BranchRegistry.listRefs`
  diverges (three orders across backends), tracked as backlog L21.

## Addendum (2026-09-28) — L21: `BranchRegistry.listRefs` gets the same order

Closes backlog L21, the divergence this ADR's Consequences section flagged and deferred.

`BranchRegistry.listRefs` ordered ref names three different ways: Postgres in the database
collation, SQLite in BINARY (already correct), and the in-memory store with
`String.prototype.localeCompare` — which is locale- **and normalization-aware**, so it can
return `0` for two DISTINCT names (an NFC "é", U+00E9, and its NFD decomposition "é"
are canonically equivalent under most locales). `pruneBranchRefs` pages `listRefs` with an
`after` cursor; a comparator that disagrees with the store's own order, or that ties two
distinct names, skips or repeats refs at a page boundary — D1's failure mode, on a second
SPI.

Same decision, applied to the second contract: **`BranchRegistry` SPI 1.2.0 → 2.0.0
(MAJOR)**. `listRefs` orders names in Unicode code point order (D1's order — UTF-8 byte
order, SQL `COLLATE "C"`, SQLite BINARY, `compareExecutionIds`), and `after` may be any
string, not only a name the store returned. MAJOR for the same reason as D1: a store
conforming to 1.x (any order, an opaque-or-store-returned cursor) can fail the new
conformance case.

- **In-memory**: `InMemoryBranchRegistry` now sorts with `compareExecutionIds` and caches
  the sorted name list across calls (invalidated only when a name is added or removed),
  mirroring `InMemoryAsyncEventStore.sortedIds` — a page costs a binary search plus the page
  size, not a full re-sort per call.
- **SQLite**: already conformed (BINARY collation on an unqualified `TEXT` column is
  memcmp order, which is UTF-8 byte order).
- **Postgres**: same D2/D3 treatment as `events.execution_id`. `refs.name` is declared
  `COLLATE "C"`; `PostgresBranchRegistry.listRefs` states `COLLATE "C"` explicitly in its
  `WHERE`/`ORDER BY` so the order is right even on a table whose column predates this. An
  existing table is converted in place by a new `L21_COLLATION` migration block
  (`plugins/postgres/src/schema.ts`), sharing `runMigration`'s transaction, its
  `loom.migration_lock_timeout` budget (renamed from `loom.l10_lock_timeout` — one setting
  for both conversions now) and its `statement_timeout` exemption for the rebuild, and
  failing soft with a `WARNING` naming the two manual statements under the same conditions
  as D3 (lock-wait timeout, cancelled statement, or a dependent view/rule). It runs after
  `DDL_REST`, which is what creates `refs` on a fresh database — `events` already exists by
  the time `L10_COLLATION` runs, but `refs` does not. Only one index depends on `name` (the
  table's own primary key), so the ALTER rebuilds it, once, rather than the two
  `events.execution_id` needed.
- The conformance kit gains a code-point-order + arbitrary-cursor case for `listRefs`
  (mixed case, `-`/`_`, digits, NFC vs. NFD "é", an astral name), and
  `plugins/postgres/src/branchRegistryMigration.test.ts` runs the L21 migration against a
  real pre-L21 `refs` table the same way `sharded.test.ts` does for L10's `events` table.
- `pruneBranchRefs` needed no code change: it was already contract-driven (page with
  `listRefs({ after })`, resume from the last name returned), so fixing the three backends'
  order fixes its paging too.
