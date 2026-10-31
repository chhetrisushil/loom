# ADR 0136 — Postgres snapshot state: opt-in lz4 TOAST compression, measured

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #707 (part 2 of the #706 snapshot-growth plan). The issue proposed switching
  `snapshots.state` from the default pglz TOAST compression to lz4 to shrink snapshot storage without
  slowing resume.
- Builds on: [ADR 0134](0134-snapshot-pruning.md) (pruning, part 1), [ADR 0129](0129-creation-marker-incarnation.md)
  (the fail-soft, warn-through-`onWarn` migration pattern this reuses).
- Placement: **1P plugin (`@loom/plugin-postgres`) only.** Kernel, KERNEL_ABI, EVENT_SCHEMA and every SPI
  unchanged. One additive option on the existing `migrate` / `PostgresEventStore` / `postgresStorage`
  options.

## Context

Resume is one full read of the latest snapshot plus a short log tail, so the snapshot read is the resume
path, and nothing may slow it. `snapshots.state` is `JSONB`; values over ~2 kB are TOASTed and compressed
with the server's `default_toast_compression` (pglz). PostgreSQL 14+ can compress a column with lz4 instead
(`ALTER TABLE … ALTER COLUMN … SET COMPRESSION lz4`) when the server was built `--with-lz4`.

## Measurements

`plugins/postgres/src/snapshotCompression.perf.test.ts` (excluded from `pnpm test`; `pnpm test:perf`),
PostgreSQL 17.x on a local macOS cluster, deterministic synthetic agent-like state (steps with tool calls,
ids and prose from a ~50-word vocabulary). Bytes are `pg_column_size(state)`; times are medians (7 saves, 15
reads) of single statements over loopback, so read them as ratios, not absolutes. Treat the data as
synthetic: real states with more entropy compress less under either method.

| raw JSON | pglz bytes | lz4 bytes | lz4 / pglz | save pglz / lz4 (ms) | read pglz / lz4 (ms) |
|---|---|---|---|---|---|
| 102 kB | 27,033 | 39,939 | 1.48x | 2.1 / 1.1 | 0.7 / 0.5 |
| 1.01 MB | 262,233 | 391,823 | 1.49x | 16.4 / 6.8 | 5.6 / 4.4 |
| 5.06 MB | 1,304,369 | 1,948,969 | 1.49x | 94.3 / 34.1 | 28.7 / 21.5 |

The real resume read, `PostgresSnapshotStore.loadLatest` of a 1 MB state: **5.6 ms (pglz) vs 4.5 ms (lz4)**,
median of 25.

Events payload column (2,000 rows of 0.3-4 kB structured JSON, batches of 50, same payloads both ways):
5.96 MB raw; **2.81 MB stored with pglz vs 3.37 MB with lz4 (1.20x)**; inserts 14.1k/s (pglz) vs 25.7k/s
(lz4). Single-run, scratch-table figures.

**The finding the issue did not expect: lz4 does not shrink snapshots. It stores about 1.5x MORE bytes than
pglz on this data (pglz compresses it ~3.9x, lz4 ~2.6x).** What lz4 buys is speed: about 20-25% faster reads
(the resume path) and about 1.5-2.4x faster writes (two runs). The goal of #707 was storage, so the speed win alone does
not justify turning it on for everyone.

## Decisions

### D1 — `snapshots.state` lz4 is OPT-IN, fail-soft, and warns

`migrate(pool, { snapshotCompression: "lz4" })`, and the same option on `PostgresEventStore` and
`postgresStorage` (the first migrator of a pool decides, as for `lockTimeoutMs`). Default `"default"`: the
column is not touched. Because the measured effect is more bytes for faster I/O, the operator picks the
trade; the default stays what #706's goal needs (smallest at rest). `"default"` never reverts a column that
already uses lz4 (switching back is an explicit `ALTER … SET COMPRESSION pglz`, which is also new-values-only).

When lz4 is requested the migration, AFTER the main migration commits, runs one more SHORT transaction
(its own, under the same advisory lock, taken before the probes so they see a settled catalog):

1. reads `SHOW server_version_num`; below 140000 it skips;
2. probes `pg_attribute.attcompression`; already `l` means a no-op that takes no table lock (`SET
   COMPRESSION` needs ACCESS EXCLUSIVE, so a catalog probe keeps every later boot lock-free, like the index
   probes);
3. runs the `ALTER` with its OWN `lock_timeout` of min(`lockTimeoutMs`, 200 ms). The `ALTER` is metadata-only
   (instant once it has the lock) but while it WAITS every snapshot load/save queues behind it (measured: a
   plain `SELECT` blocked 1.5 s), so it must not borrow the conversion budget: with a long reader on
   `snapshots`, a booting node stalls snapshot I/O, hence resume, for at most ~200 ms, per boot, until a boot
   finds the table free. On `feature_not_supported` (server built without lz4), `invalid_parameter_value`,
   `syntax_error`, `undefined_column` (a fork without `attcompression`), `insufficient_privilege`,
   `lock_not_available`, `query_canceled` or `deadlock_detected` the transaction rolls back and the migration
   continues; the next boot retries. Any other error still fails the migration.

Running it after the main COMMIT (not inside that transaction) means no lock from the `events`/`refs`
conversions is held across it, so it can neither extend their ACCESS EXCLUSIVE nor create an
events-then-snapshots lock order. Like every option it is decided by the first migrator of a pool: requesting
lz4 on a pool another store already migrated is ignored.

A skip is reported ONCE per migration through the existing `onWarn` seam (default `console.warn`; no new
logging path): the operator asked for lz4 and is not getting it, which silence would hide. Not requesting lz4
produces no message, so an old server running the default configuration is quiet.

**Existing rows keep pglz until they are rewritten.** `SET COMPRESSION` is metadata-only and applies to
values written afterwards. Nothing here rewrites old rows (a rewrite is a table-wide lock and I/O the
operator should choose; a snapshot is rewritten naturally when re-saved by id). A mixed column reads fine:
each value carries its own compression method (`pg_column_compression`).

### D2 — Events payload: measured, not changed

The numbers above (1.20x more bytes, ~1.4-1.8x faster inserts in a scratch table) are a hint, not a decision.
The event log is the throughput bottleneck (ADR notes on the 5.7K exec/s ceiling), and changing its
column would need a full-system append benchmark and a size/throughput call by the owner. Out of scope here;
the measurement is reproducible with the perf file.

### D3 — SQLite unchanged

State is `TEXT`; SQLite has no column compression, so this would be application-level compression with a
format marker so old rows still read, in a store whose role is dev and single-node. That is a new on-disk
format for the store where size matters least. Left as is.

### D4 — Encryption: compress-before-encrypt is out of scope

`EncryptingSnapshotStore` writes ciphertext, which is incompressible (TOAST stores it raw, and lz4 vs pglz
is moot). Compressing before encrypting would work but leaks plaintext size through the ciphertext length
(the CRIME/BREACH family when an attacker can influence the plaintext). At rest that is often acceptable,
but it is a security-boundary decision for a separate ADR, not a side effect of a column setting.

## Consequences

- `MigrateOptions.snapshotCompression?: "lz4" | "default"` (default `"default"`): existing deployments change
  nothing.
- With `"lz4"`: new snapshots are ~1.5x larger on disk and ~20% faster to read on this data. Measure your own
  states with `ProfilingSnapshotStore` (#708) and the perf file before enabling it. The mixed old/new column
  and the fallback are covered by `snapshotCompression.test.ts`.
- If the owner prefers it on by default, it is one constant (`options.snapshotCompression ?? "default"` in
  `schema.ts`).
