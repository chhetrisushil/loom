# ADR 0140 — An opt-in zstd snapshot codec: a format byte, a BYTEA/BLOB frame, compress before sealing

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #733 (part 3 of 3 of the snapshot-size umbrella #730), from the measurement in #730:
  a zstd-3 frame stored as `BYTEA` is smaller than Postgres `JSONB` under pglz AND reads about 2x faster.
- Builds on: [ADR 0134](0134-snapshot-pruning.md) (pruning), [ADR 0136](0136-snapshot-lz4-compression.md) (the
  opt-in, fail-soft, short-lock-wait migration pattern this reuses; its D4 deferred compress-before-encrypt as a
  separate security decision, which is decided here), [ADR 0138](0138-compaction-archives-what-it-removes.md)
  (a legacy-checkpoint archive segment holds a checkpoint byte-exact).
- Owner rulings (2026-10-31): nothing may slow resume; auditability stays intact (the log and the ADR 0138
  archive are the audit record; a snapshot is a cache that must decode to the IDENTICAL state); default behaviour
  unchanged (opt-in); flipping the default later is an owner decision after soak.
- Version impact: **none to a contract.** `SNAPSHOT_STORE_SPI_VERSION` stays **1.2.0** (the `Snapshot` a store
  accepts and returns is unchanged: the codec lives inside each store and is invisible at the SPI), `KERNEL_ABI`,
  `EVENT_SCHEMA` and every other SPI are unchanged. New additive options on existing stores and presets, a new
  `durability.snapshots` config group, a new `loom snapshot show` command, and a new nullable column on
  Postgres `snapshots` that exists only when the operator opts in.
- Placement: **1P**, in `@loom/snapshot-runtime` (the codec), `@loom/plugin-sqlite`, `@loom/plugin-postgres`,
  `@loom/plugin-crypto`, `@loom/app` (config) and the CLI. Kernel untouched. Reviewed as storage + schema
  migration + a security boundary (the sealed path).

## Context

Resume is one snapshot read plus a short log tail, so the snapshot read is the resume path. The #730 measurement
(a running `agentLoop$` execution, PG 17 over loopback):

| 200 turns | stored plain | stored claim-checked | resume read plain / claim-checked |
|---|---|---|---|
| JSONB, pglz (today) | 170 KB | 26.8 KB | 3.09 / 1.17 ms |
| JSONB, lz4 (ADR 0136) | 242 KB | 28.9 KB | 2.52 / 1.14 ms |
| **zstd-3 frame in BYTEA** | **138 KB** | **15.9 KB** | **1.47 / 0.64 ms** |

The JSONB server cost (`jsonb_out` plus detoast) dominates the read, so shipping the compressed bytes and
decoding them in the client is faster at every size, not just smaller. msgpack and CBOR were measured and
rejected (lossy for `__proto__` keys and lone surrogates reachable from tool output, and not faster); zstd
dictionaries (help only tiny snapshots, need dictionary versioning) and reverse deltas were rejected in #730.

A third fact: JSONB already reorders keys, so snapshot text is not byte-stable on Postgres today. A codec that
stores `JSON.stringify(state)` verbatim (compressed) is MORE faithful than the column it competes with.

## Decisions

### D1 — The frame: one format byte, then JSON or zstd of JSON

`@loom/snapshot-runtime` `encodeState` / `decodeState`. A frame is `[format byte][payload]`:

| byte | payload |
|---|---|
| `0x01` | UTF-8 `JSON.stringify(state)`, uncompressed (a state too small or too random for zstd to help: a frame is never larger than the text plus one byte) |
| `0x02` | zstd level 3, content-checksummed, of the same UTF-8 JSON |

The payload is JSON and nothing else, so the round trip is exact for everything JSON can say: `__proto__` keys
stay OWN keys, lone surrogates are escaped by `JSON.stringify` and restored by `JSON.parse`, key order is kept.
Both format bytes are control characters, which can never start a JSON text, so a reader that may meet a
pre-codec bare-JSON plaintext (D3) tells the two apart by the first byte alone. An unknown byte (a newer loom's
frame) is a loud `SnapshotDecodeError`, never a guess; a corrupted payload fails the zstd checksum rather than
decoding to a wrong state; decompression is capped (1 GiB) so a tampered row cannot allocate without bound.
No dictionary.

### D2 — Per-backend storage: reads dispatch on the stored format, nothing is rewritten

- **Postgres.** A new `snapshots.state_z BYTEA` column (TOAST storage `EXTERNAL`: the bytes are already
  compressed, the server must not try again). A codec row has `state NULL` and `state_z` set; a legacy row is the
  reverse. `state`'s `NOT NULL` is dropped (catalog-only, no scan), and a `CHECK (state IS NULL OR state_z IS
  NULL)` is added `NOT VALID` (enforced for every later write, no table scan: every existing row satisfies it by
  construction). `PostgresSnapshotStore` reads with `SELECT *` and dispatches on the row: `state_z` present means
  a frame, else JSONB. It reads BOTH whatever it is configured to write.
- **SQLite.** No DDL: the existing `state TEXT` column holds a `BLOB` for a frame (SQLite is dynamically typed;
  the storage class is the discriminator: `string` is legacy JSON text, `Buffer` is a frame). No migration, no
  lock. An older loom that meets a frame fails loudly (`JSON.parse` of a binary value throws).
- **In-memory.** `InMemoryAsyncSnapshotStore({ codec })`: with `"zstd"` it holds frames and decodes on every read
  (so a read is an independent copy and the store exercises the real format); default holds the saved object.

Old rows stay readable forever and are never rewritten (a re-save by id replaces a row, in the format then
configured). A re-save by id over a row of the other format flips it and, on Postgres, clears the other column:
a store that knows the column exists writes `state_z = NULL` on a JSONB upsert; a store that probed BEFORE
another node opted in does not know it, and the `CHECK` turns its write into a loud `23514` instead of a silently
stale frame (the mixed-config-fleet case).

### D3 — Compress BEFORE sealing

`EncryptingSnapshotStore` seals the whole folded state; ciphertext is incompressible, so a codec in the backend
below it sees only random-looking base64 and can recover only base64's 25% overhead. With
`new EncryptingSnapshotStore(inner, keys, { sealState: true, codec: "zstd" })` the PLAINTEXT inside the AES-GCM
envelope becomes a D1 frame (`encryptValue(..., codec)`); `decryptValue` opens either a frame or the bare JSON
text every earlier envelope holds, by the first byte. Consequences, all deliberate:

- The envelope shape, the AAD binding (`executionId|sequence`) and every reader of a sealed state
  (`openWholeState`, shredding, `loadLatestSealed`) are unchanged. The frame is inside the GCM tag, so the format
  byte cannot be flipped without failing authentication.
- Default `"none"` writes exactly today's bytes. A store with a codec opens snapshots written without it and
  the reverse (a codec-off store opens frames).
- Measured (`plugins/crypto/src/snapshotCodec.test.ts`, stored bytes through a `measure: "stored"` profiling
  store): compress-then-seal is more than 4x smaller than today's sealed JSON on a repetitive state, while a
  codec only in the backend (below the seal) stays within 30% of today's.
- **The cost, stated (this reverses ADR 0136 D4's deferral to an explicit, opt-in decision).** Ciphertext length
  now reveals the COMPRESSED length of the state, the CRIME/BREACH family of leaks when a party can both
  influence the plaintext and observe stored sizes. The state is the folded execution written by the runtime, not
  an attacker-chosen string compressed beside a secret in one request, so the practical oracle is narrow, but an
  operator whose threat model includes it keeps `codec` off. It applies to `sealState` only (a static-path store
  seals small fields; passing `codec` without `sealState` throws).

### D4 — Node version: refuse loudly, never fall back silently

`zlib.zstdCompressSync` exists from Node 22.15; the repo's supported range is `>=20` (CI runs 20). `engines` is
NOT raised: the feature is opt-in. Requesting the codec on a Node without it THROWS at construction
(`SnapshotCodecUnavailableError`, naming the Node requirement and "leave the codec off") from every entry point:
the stores, the presets, `EncryptingSnapshotStore` and `defineConfig`. It never silently writes uncompressed: an
operator who asked for zstd and got JSON would find out from a bill. READING a frame on a Node without zstd
throws the same error (the data needs it); an operator who turns the codec on must run Node >= 22.15 on every
node that reads. The codec's own tests are skipped (not failed) on Node 20.

### D5 — The Postgres migration: opt-in, fail soft, short lock wait, not first-migrator-decides

`ensureSnapshotZstd(pool, { lockTimeoutMs, onWarn })`, run by `PostgresSnapshotStore` when built with
`codec: "zstd"` (and by `migrate(pool, { snapshotCodec: "zstd" })` for provisioning ahead of time), is ADR 0136's
pattern applied again:

- its OWN short transaction, AFTER the main migration committed, under the same migration advisory lock (taken
  before the probes so they see a settled catalog): it can neither extend nor reorder the conversions' locks;
- a catalog probe first (`pg_attribute`, `pg_constraint`): when the column, the nullable `state` and the CHECK
  already exist it takes NO table lock, so every boot after the first is lock-free;
- otherwise the statements run in ONE transaction under ONE `ACCESS EXCLUSIVE` acquisition with `lock_timeout` =
  min(`lockTimeoutMs`, 200 ms). Each is catalog-only, so the lock is held for microseconds once granted; while it
  WAITS, snapshot I/O (hence resume) queues behind it for at most that timeout, per boot, until a boot finds the
  table free;
- on the same soft SQLSTATEs as ADR 0136 (`lock_not_available`, `insufficient_privilege`, `deadlock_detected`,
  `query_canceled`, ...) it rolls back, warns ONCE through `onWarn`, and the store keeps writing JSONB (always
  correct, just larger); the next boot retries. A failure is not memoized;
- unlike the other migration options it is NOT decided by the first migrator of a pool: it runs for whoever asks
  (idempotent, memoized per pool on success).

A store that does NOT opt in does no DDL; it makes one lock-free catalog read at boot (`state_z` present?) so a
JSONB re-save never leaves a stale frame (D2).

**Rollout order.** Upgrade every node to a build that reads frames first, then opt in. A pre-0140 Postgres store
that meets a frame row reads `state NULL` as the state; do not roll back below this build once frames exist
(re-save is not needed to downgrade, but the older code cannot read the frame rows). SQLite fails loudly instead.

### D6 — Every reader goes through the stores, so every reader decodes

No code outside the stores reads `snapshots.state`; everything calls `loadLatest` / `loadAt` /
`loadLatestBefore` / `loadLatestSealed`, which now decode: the runtime's resume and fork, pruning (a range
`DELETE`, no state read), compaction checkpoints, the ADR 0138 legacy-checkpoint archive segment (it copies the
DECODED `Snapshot` into the segment, so the archived checkpoint is the exact JSON that was saved, which under
JSONB it never was: key order), the content sweep (`snapshots.loadLatest*` to pin refs), `exportSubject`, the CLI
(`loom retention`, `sweep content`, `repair`, `learn`, `debug`), and the conformance kit. The SQL a human might
have run (`state->…`) cannot traverse a frame: use D7. `docs/` was searched for that advice; none existed.

### D7 — `loom snapshot show <store-flags> <executionId> [--at SEQ] [--redact a,b]`

Prints one stored snapshot, DECODED, as indented JSON (`id`, `executionId`, `workflowId`, `sequence`,
`createdAt`, `state`). Latest by default; `--at SEQ` is the snapshot stored at exactly SEQ (it does not
substitute a neighbour). It reads through the deployment's own snapshot store, so an encrypting store opens it and
either format decodes. Read-only; `--db` also needs `--snap`; exit 1 when there is no such snapshot.

### D8 — Opt-in surface

- `new SqliteSnapshotStore(path, { codec })`, `sqliteStorage({ snapshotCodec })`.
- `new PostgresSnapshotStore(pool, { codec, migrationLockTimeoutMs, onWarn })`, `postgresStorage({ snapshotCodec })`,
  `migratePostgresStores(pool, { snapshotCodec })`.
- `new InMemoryAsyncSnapshotStore({ codec })`, `new EncryptingSnapshotStore(inner, keys, { sealState, codec })`.
- `defineConfig({ durability: { snapshots: { codec: "zstd" } } })`: validated at boot (an unknown codec or key is
  a `TypeError`; a codec this Node cannot write throws). It applies to the stores `defineConfig` builds itself:
  `storage: { kind: "memory" }` and the default sealed checkpoint store of an encrypting custom event store
  (compressed BEFORE sealed). A snapshot store the app passes is already built, so it must be given the codec at
  its own construction; `defineConfig` warns when such a store reports (`snapshotCodec`) a codec that disagrees.
- `ProfilingSnapshotStore` measures STORED bytes (the frame) by default when the wrapped store reports
  `snapshotCodec: "zstd"` (`measure: "stored" | "json"` overrides), so a zstd deployment's size histogram shows
  what is on disk.

### D9 — What this does not change

`SNAPSHOT_STORE_SPI` (D header). The default for everyone: JSONB on Postgres, JSON text on SQLite, the object on
memory, today's sealed plaintext. Pruning, retention, the archive and the log. The decision to make zstd the
default is the owner's, after soak; it would be one constant per store plus the rollout order in D5.

## Measurements

`plugins/postgres/src/snapshotCodec.perf.test.ts` (excluded from `pnpm test`; `pnpm test:perf`), PG 17.x on a
local macOS cluster over loopback, a deterministic synthetic agent state built to the #730 harness's shape (1-4 kB
tool outputs over a 20-word vocabulary; claim-checked replaces each output above the 1 kB cap by a content ref).
Bytes are `pg_column_size(state)` for JSONB and `length(state_z)` for the frame; reads are the median of 25
`PostgresSnapshotStore.loadLatest` (query plus decode):

| turns | claim-checked | raw JSON | JSONB pglz | zstd frame | zstd / pglz | read pglz / zstd (ms) |
|---|---|---|---|---|---|---|
| 50 | no | 152,381 | 45,643 | 36,487 | 0.80 | 1.39 / 0.84 |
| 50 | yes | 30,889 | 7,612 | 3,531 | 0.46 | 0.52 / 0.33 |
| 200 | no | 600,001 | 174,492 | 137,946 | 0.79 | 4.48 / 2.55 |
| 200 | yes | 124,390 | 27,694 | 13,681 | 0.49 | 1.40 / 0.85 |

This reproduces #730's bytes (170 / 138 KB plain at 200 turns) and its direction on reads (zstd 1.7-1.9x faster
here, 2.1x in #730). Treat the data as synthetic: real states with more entropy compress less under either method;
the ranking is what carries over. Only the byte comparison is asserted; wall clock is printed.

## Consequences

- Opt-in, so an existing deployment changes nothing: no DDL, no new column, the same bytes.
- With the codec: about 0.8x the bytes of JSONB on plain agent state, about 0.5-0.6x claim-checked, a faster
  resume read, key order preserved, and a sealed state that actually shrinks (D3).
- A Postgres operator who opts in gets one extra nullable column and a `NOT VALID` CHECK, provisioned fail-soft
  with at most a ~200 ms snapshot-I/O stall per boot while a long reader holds the table.
- The cost of the sealed path (D3) is a conscious, documented length leak.
- Tests: `snapshotCodec.test.ts` (round trip and byte-identical JSON for plain, claim-checked and adversarial
  states: `__proto__`, lone surrogates, deep nesting, 2,000 steps; corruption; unknown format), the in-memory,
  SQLite and Postgres suites (mixed old and new rows, opt-out reads frames, re-save flips format, fail-soft under
  a held lock, the SnapshotStore conformance kit in BOTH formats on every backend), the crypto suite (size win
  proven on stored bytes, mixed envelopes, AAD still binds), `defineConfig`, and `loom snapshot show`.
