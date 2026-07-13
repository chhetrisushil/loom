# Encryption at rest (K10.5)

> **The K10.5 obligation:** encryption-at-rest configuration is documented for both the
> SQLite and Postgres store backends. Loom does **not** encrypt the store *files* itself —
> that is a storage-layer concern, configured where the bytes physically live — and this page
> is that documentation. It composes with, and is distinct from, Loom's two **application-layer**
> crypto seams.

## Three complementary layers — pick what your threat model needs

Loom's log lifecycle (K10) gives you three independent protections. They stack; none replaces
another.

| Layer | Protects against | Where | Loom mechanism |
|---|---|---|---|
| **1. Field-level crypto-shredding (K10.2)** | A specific data-subject's PII must be *erasable* on demand (GDPR), even though the log is append-only | The **event/snapshot payloads** — the marked fields are ciphertext at rest | [`@loom/plugin-crypto`](../../packages/store-crypto/) — `EncryptingEventStore` / `EncryptingSnapshotStore`, erase by destroying the per-subject key |
| **2. Redaction markers (K10.3)** | A secret must **never be persisted at all** (API keys, passwords) | The log never contains the value — only a deterministic reference | `redactionMiddleware` + `SecretResolver` (`@loom/middleware`) |
| **3. Encryption at rest (K10.5)** | Someone reads the **raw disk / DB files / a stolen backup** | The whole store file/tablespace/volume | **Configured at the storage layer** — this page |

Layers 1–2 are Loom code you wire in your app. Layer 3 is infrastructure you configure below —
it defends the bytes on disk wholesale, without Loom knowing which fields are sensitive.

---

## SQLite backend

`SqliteEventStore` / `SqliteSnapshotStore` use `better-sqlite3`, which writes a **plain,
unencrypted** SQLite database file. Anyone who can read `.loom/events.db` reads the log. Choose
one (or both) of:

### Option A — encrypt the volume (simplest, OS-managed)

Put the store directory on an encrypted filesystem and there is nothing to change in Loom:

- **macOS:** FileVault (full-disk).
- **Linux:** LUKS / `dm-crypt` on the partition holding the `.loom` dir.
- **Cloud VMs / containers:** an encrypted block device (AWS EBS encryption, GCP CMEK persistent
  disks, Azure disk encryption). Point `storage.dir` at a mount on that device.

```ts
const app = defineConfig({ storage: sqliteStorage({ dir: "/mnt/encrypted/loom" }) });
```

This encrypts the DB file, its WAL, and any backups taken from the volume — transparently.

### Option B — encrypt the database file itself (SQLCipher)

For per-file encryption independent of the volume, use a SQLCipher-backed driver. `better-sqlite3`
does not bundle SQLCipher, so supply your own store via `storage.kind: "custom"` (mirror
`SqliteEventStore`/`SqliteSnapshotStore`, opening the DB through a SQLCipher build and running
`PRAGMA key = …` before the first query):

```ts
// Sketch — your driver opens an encrypted DB; the store methods are otherwise identical.
const db = new SqlCipherDatabase(path, { key: process.env.LOOM_DB_KEY });
const app = defineConfig({
  storage: { kind: "custom", eventStore: new EncryptedSqliteEventStore(db), snapshotStore: … },
});
```

Keep `LOOM_DB_KEY` in a secrets manager, not on disk beside the database.

> **WAL note:** SQLite runs in WAL mode (`journal_mode = WAL`) for concurrency. Volume
> encryption (Option A) covers the `-wal`/`-shm` sidecar files automatically; SQLCipher (Option
> B) encrypts them as part of the database. Don't leave a decrypted temp copy behind when you
> back up.

---

## Postgres backend

The Postgres stores (`@loom/plugin-postgres`, or the [reference backend](../examples/postgres-backend/README.md))
persist to a Postgres cluster. Encryption at rest is a **cluster/infrastructure** setting, not a
Loom one — configure it where the cluster runs:

### Managed Postgres (recommended)

All major managed offerings encrypt storage + backups at rest by default, with a
customer-managed-key (CMK) option:

- **AWS RDS / Aurora:** enable *Storage encryption* (KMS CMK) at instance creation — covers the
  volume, automated backups, snapshots, and read replicas.
- **GCP Cloud SQL:** encrypted by default; supply a CMEK for key control.
- **Azure Database for PostgreSQL:** encrypted by default; bring-your-own-key via Key Vault.

No Loom or SQL change — point `storage.url` at the encrypted instance.

### Self-managed Postgres

- **Cluster-wide TDE** where your distribution offers it, **or** the portable path: put the data
  directory (and WAL/`pg_wal`) on a **LUKS / dm-crypt** volume. This encrypts everything Postgres
  writes, including `events`, `snapshots`, and the `timers`/`fences` tables Loom adds.
- **Backups:** encrypt `pg_dump`/`pg_basebackup` output (`gpg`, or your backup tool's encryption)
  — the at-rest guarantee is only as good as its weakest copy.
- **In transit:** orthogonal but pair it — require `sslmode=verify-full` on the connection string.

### `pgcrypto` (column-level) — usually redundant with Loom

Postgres `pgcrypto` can encrypt individual columns, but for Loom that overlaps Layer 1
(crypto-shredding, which already encrypts marked *fields* portably across SQLite and Postgres and
gives you key-destruction erasure). Prefer `@loom/plugin-crypto` for field-level needs and reserve
volume/TDE encryption for the whole-file threat.

---

## Choosing

- **Erasure on request (GDPR):** Layer 1 (crypto-shredding) — at-rest volume encryption cannot
  selectively forget one subject.
- **Never persist a secret:** Layer 2 (redaction markers).
- **Stolen disk / leaked backup:** Layer 3 (this page) — volume encryption is the pragmatic
  default (managed-DB storage encryption for Postgres; FileVault/LUKS/encrypted-EBS for SQLite),
  SQLCipher/TDE when you need per-file/per-cluster keys.

Most regulated deployments enable **all three**: field-level crypto for erasable PII, redaction
for secrets, and volume encryption underneath for defence in depth.

> See also: **[K10 in the kernel-hardening deep-dive](04-kernel-hardening.md)** ·
> [`@loom/plugin-crypto`](../../packages/store-crypto/README.md) ·
> [ADR 0022](../adr/0022-k10-log-lifecycle-retention-redaction-encryption.md).
