# Operating Loom

An operator's runbook for a durable, multi-node deployment. It is a map, not a second manual: each
section says what to run or set, why, and where the full reference lives. Everything here is about
the **durable** configuration; the default in-memory storage needs none of it.

Contents: [1. Postgres store](#1-postgres-store) -
[2. Heartbeat leases](#2-heartbeat-leases) -
[3. Failure recovery](#3-failure-recovery) -
[4. Erasure and crypto-shredding](#4-erasure-and-crypto-shredding) -
[5. Backups](#5-backups) -
[6. Pre-flight checklist (`loom doctor`)](#6-pre-flight-checklist-loom-doctor)

---

## 1. Postgres store

`@loom/plugin-postgres` ships `postgresStorage`, a `defineConfig({ storage })` preset that returns the
event store, snapshot store and (with `branching: true`) branch registry, plus a **co-located lease
store** (see section 2):

```ts
import { defineConfig } from "@loom/app";
import { postgresStorage } from "@loom/plugin-postgres";

const app = defineConfig({
  storage: postgresStorage({ url: process.env.DATABASE_URL!, branching: true }),
  flows,
});
// at shutdown: closing the event store also ends the pool the preset created
await app.stores.eventStore.close?.();
```

- **Schema** is created and migrated on first connect (`migratePostgresStores` is exported if you
  want to run it as a deploy step). Concurrent migrations from several booting nodes are safe.
- **One pool for every store.** The preset opens a single `pg` pool and shares it across the event,
  snapshot, lease and branch stores. You may pass your own pool (`url` accepts a connection string, a
  `PoolConfig`, or an already-built pool; a pool you hand in is never `end()`ed by Loom).
- **Pool sizing.** Budget connections per node as `pool.max` (the pool) plus one dedicated
  `LISTEN` connection for cross-node live subscribe; multiply by node count and keep the product
  under the server's `max_connections`. Do not size the pool upward for throughput: the append path
  is flat from about 8 concurrent writers, and more concurrency only buys latency
  ([scaling.md](scaling.md), section 1). Scaling past one log is a separate topic (same document,
  section 3.4).
- **`notifyBuckets`** (default 16) must be identical on every node of the database.
- A Postgres store is **fail-closed on lost writes**: a write that cannot be made durable fails the
  run rather than continuing (`StorageWriteError`; observe it with `observability.onStorageError`).
- Timer rows (`PostgresTimerStore`) belong in the **same database** as the log, so one backup
  captures the full kernel state ([user guide](user-guide/delivery-versioning-and-recovery.md#durable-timers-t1), "Durable timers").

Reference: [user guide, section 9 (configuration)](user-guide.md),
[plugins](plugins.md).

---

## 2. Heartbeat leases

Every driver (a process that is running an execution) holds a renewed lease while it drives. A lease
that **existed and expired** is evidence that a driver died, which is what lets the timer poll and the
recovery sweep re-drive an abandoned execution without a guessed timeout. Decision record:
[ADR 0130](adr/0130-sealed-payload-delivery-guard.md) D11, including the 2026-10-15 amendment (S7g).

```ts
defineConfig({
  storage: postgresStorage({ url }),
  durability: {
    heartbeat: {
      ttlMs: 30_000,            // default 30 s: your tolerance for a node that DIED
      renewEveryMs: 10_000,     // default TTL/3; must be below ttlMs - floor(ttlMs / 6)
      acquire: "lazy",          // default; see below
      lazyGraceMs: 10_000,      // default TTL/3
      onStoreError: "stop",     // default; or "continue"
    },
  },
});
```

| Option | Default | What to know |
|---|---|---|
| `ttlMs` | 30 000 | Not a bound on run time: a lease is renewed for the whole run. Longer TTL = slower detection of a dead node, fewer false stops during a store hiccup. |
| `renewEveryMs` | `max(floor(ttlMs/3), 1)` | `defineConfig` throws a `TypeError` if the cadence is not below the self-fencing deadline `ttlMs - floor(ttlMs/6)`. |
| `acquire` | `"lazy"` | Lazy applies to **every `start`**, a caller-chosen id included: it takes its lease after `lazyGraceMs`, so a short run never touches the lease store. A `start` onto an id whose stream already exists is refused at the sequence-0 bootstrap with `ExecutionAlreadyExistsError` before the body runs. **Every resume-like entry is eager**: `resume` (incl. the `send`/notify winner), `resumeAs`, `restoreFromState`, a continue-as-new successor, the poll/sweep re-drive claim, a timer fire, a local worker attempt. Residual (ADR 0130 D11 amendment): a ghost lease row left by a failed start whose release also failed can be met by an immediate retry of the same caller-chosen id, which then loses it (`taken-over`) and stops; the row's expiry makes the execution recoverable, and `acquire: "eager"` closes it. `"eager"` leases every run before its first append (it measured 25-30% overhead on Postgres, which is why lazy is the default). |
| `lazyGraceMs` | TTL/3 | The unleased window of a `start`. A fresh driver that dies inside it left no lease, and an absent lease is never evidence, so only a host `isAbandoned` re-drives that crash. |
| `onStoreError` | `"stop"` | `"stop"`: a driver that cannot confirm a renewal aborts at its self-fencing deadline (appends nothing), so an expired lease stays true evidence. `"continue"`: drivers keep running through a lease-store outage (the fence still guards the log) but their leases stop proving liveness. |

**Set `onStoreError` fleet-wide.** A `"continue"` node marks its lease owner as heuristic, so every
node treats that node's expired leases as a heuristic and the poll's default re-drive is off for that
fleet. A fleet that mixes `"stop"` and `"continue"` nodes gets neither guarantee cleanly: pick
`"continue"` on every node if you prefer availability during a lease-store outage, `"stop"` on every
node otherwise.

**The lease store is co-located with the event store** (the preset's `leaseStore`), so a Postgres
deployment gets cluster-visible leases with no extra config. `LeaseStore.scope` says how far a lease
is visible: `process` (in-memory), `host` (SQLite: one machine), `cluster` (Postgres), or `unknown`
(a custom store that does not declare it). Only `cluster` sets `app.heartbeat.clusterVisible`, and
only then does the poll re-drive by default on an expired lease. A durable event store with no
derivable lease store **disables** heartbeat (fail-closed); `loom doctor` reports it.

**Enable heartbeat on every node that polls or sweeps.** An unexpired lease vetoes an `isAbandoned`
heuristic, but only on a node that reads leases; a node with heartbeat off can still double-enter a
live leased driver (the fence protects the log, not the in-flight effect).

Check the resolved decision with `app.heartbeat` (`HeartbeatStatus`) or `loom doctor` (section 6).
Full reference: [usage.md](usage.md), "Heartbeat leases".

---

## 3. Failure recovery

Three layers, from automatic to manual:

1. **Worker died or hung** (the dispatcher is alive): `executeTimeoutMs` plus `maxAttempts`
   redispatches the package; completed steps are served from the log
   ([ADR 0004](adr/0004-failure-recovery.md)). Nothing to run.
2. **Supervisor died** (the process that was driving is gone, so the execution sits `running` with
   no owner): the timer poll and the recovery sweep re-drive it, on the evidence below.
3. **Operator action**: `loom recover`, `loom census`, and the sealed-payload verbs.

**What the poll and the sweep use as evidence.**

- With heartbeat on in `"stop"` mode over a cluster-visible lease store, the `TimerService` poll
  re-drives a refused `running` execution **by default** on an **expired** lease; no `isAbandoned`
  needed (ADR 0130 S7d). A host `isAbandoned` only narrows it.
- An **unexpired lease vetoes** any `isAbandoned` heuristic: a live but silent driver is never
  superseded.
- An **absent lease is never evidence** (a legacy or pre-grace driver is re-driven only by
  `isAbandoned`).
- The takeover appends the `EXECUTION_RECOVERED` marker with a conditional append before taking the
  fence, so a driver that was not really dead wins.
- An expired lease with no stream (a **ghost**) is garbage-collected; the poll runs
  `collectGhostLeases` (bounded, once per TTL).
- A lease-store read error **fails closed**: nothing is re-driven, the error is reported as
  `LeaseEvidenceError`, and a one-TTL quiet period follows.

**Refusal rows.** A node that cannot open a recorded sealed payload refuses the replay and leaves a
timer-store row carrying `refused` (ADR 0130 D10). A capable node's poll re-drives the `running`
execution only on the evidence above and only while the log has not moved since the refusal. Wire
`timers` (a `TimerStore`) on the nodes that should do this, and give every node the same
`redriveBackoff`. See [usage.md](usage.md), "Sealed inbox payloads".

**The sweep.** `recoverAbandoned(app.runtime, { source, isAbandoned?, leases?, fenced: true, limit })`
is a maintenance pass you schedule (cron, a Kubernetes Job, a leader-elected ticker). Keep
`fenced: true` so a predecessor that is not really dead loses at the store. Be generous with any
time-based threshold: a wrongly preempted live worker's in-flight effect may still land
([user guide](user-guide/delivery-versioning-and-recovery.md#recovering-executions-whose-supervisor-died-adr-0004), "Recovering executions whose supervisor died").

**The CLI.**

```bash
loom census  <store-flags>                      # read-only: what is stuck, is anything watching it
loom recover <store-flags> --stale 15m          # dry run: lists what it would re-drive
loom recover <store-flags> --stale 15m --config ./loom.config.js --apply
```

`loom recover` needs `timers.leases` or `--stale`; `--apply` needs `--config` because re-driving runs
the flow. `--max-recoveries N` skips and lists executions whose last N re-drives made no progress.
Reference: [usage-cli.md](usage-cli.md), "loom recover", "loom census".

**A sealed message blocks its execution on a node that cannot open it.** Hold just that topic with
`runtime.quarantineInbox(executionId, { topic }, { principal })` (the principal is required). Its
effects, the auto-release by a capable node, and the `releaseInbox` exits (`"deliver"` or
`"discard"`) are in [usage.md](usage.md), "A sealed message at the head blocks the whole execution"
(ADR 0130 D9). Quarantine is never automatic, and a held topic stays held indefinitely if no
capable node ever runs.

**Caller-chosen ids.** A `start` with an id that already exists is refused at the durable bootstrap,
before the body runs ([ADR 0103](adr/0103-durable-bootstrap-for-caller-chosen-ids.md)); one that
finds a lease but no sequence 0 (a ghost) rejects with the retryable `StartLeaseHeldError`.

---

## 4. Erasure and crypto-shredding

Erasure destroys the subject's key so the sealed fields become unrecoverable; it does not rewrite
the log. The full procedure and its edge cases are in [compliance.md](compliance.md), and the design
context in [data-protection-patterns.md](data-protection-patterns.md). The operator's end-to-end view:

1. **Prerequisites** (set once). `security.compliance: { subjectOf, erase: { shred } }` plus
   `security.crypto` with a durable `KeyStore`. The snapshot store must seal under the same
   `KeyStore` (`sealState: true`, [ADR 0130](adr/0130-sealed-payload-delivery-guard.md) D8): with an
   encrypting event store the kernel refuses to boot over a plaintext checkpoint
   (`PlaintextCheckpointError`) unless you opt out with `allowPlaintextCheckpoints`. `loom doctor`
   reports the mismatch before you boot.
2. **Request**: `await app.eraseSubject(subjectId)`. The result is `erased`, `parked` or `unknown`.
3. **Parked is not failed.** Erasure never shreds an execution that is still in flight. It records a
   durable `ERASURE_PENDING` fact. With the default `{ parked: "defer" }` it then **completes by
   itself**, with no re-issue, when the subject's last live execution reaches a terminal event. A
   *suspended* execution is live, so a flow parked forever blocks it forever: cancel it, or pass
   `{ parked: "shred" }`, which cancels each suspended owner (reason `"erased"`) and then shreds. That
   mode relies on the `erase.cancel` hook, which `defineConfig` wires by default (a hand-built
   `EraseCoordinator` without `cancel` throws). A *running* owner defers even under `"shred"`, and
   the parked request then only completes if no suspended owner remains, so **re-issue
   `eraseSubject` with `{ parked: "shred" }` once the running owner parks**.
4. **Quiesce new work for the subject** before erasing: a run started while the erasure executes is
   not covered, and its sealed writes fail loudly once the key is destroyed.
5. **Proof of destruction.** `shredSubject` writes intent (`ERASURE_PENDING` on each log), destroys the
   key, then writes the `PAYLOAD_SHREDDED` tombstone. A crash between steps is completed by a retry
   only if the key store can prove it destroyed the key (`KeyStore.wasDestroyed`). Implement
   `wasDestroyed` and persist the destroy tombstone in any third-party key store (KMS, vault, HSM).
   The `force: "key-destroyed-elsewhere"` override is an assertion; a wrong one writes a false
   tombstone.
6. **Derived read models are not erased by the shred.** Purge the subject's rows (preferred) or
   `clear` and rebuild ([compliance.md](compliance.md), "Erasure does not reach a derived read
   model").
7. **Keep the erasure request itself as the audit record**; the journaled cancel records only
   `reason: "erased"`.

A node that cannot open a sealed stream refuses to deliver (it does not fail the execution); that
is a mixed-fleet or wrong-key condition, not an erasure. See [compliance.md](compliance.md),
"A node that cannot open a sealed stream".

---

## 5. Backups

Loom does not ship a backup tool; this is what must be true of yours.

| Store | Backup stance |
|---|---|
| **Event store** | The source of truth. Back it up first and treat it as the system of record. Postgres: a physical or point-in-time backup, or a consistent `pg_dump`. SQLite: a copy taken with the SQLite backup API or while quiesced, never a naive file copy of a live WAL database. |
| **Snapshot store** | An optimisation while the log is complete (a lost snapshot is re-folded from the log). It is **required** for a log that has been compacted, because compaction truncates the log behind a checkpoint ([ADR 0106](adr/0106-compaction-integrity.md)). Back it up in the same snapshot as the event store. |
| **Compaction archive** | Compaction MOVES the events it removes into the `ArchiveStore` (ADR 0138; also the inbox's trimmed and deleted reserved streams, ADR 0139), so after a compaction the archive holds history the log no longer does. `sqliteStorage()` keeps it in `archive.db` beside the event store (back the file up with it) and `postgresStorage()` in the same database (`archive_segments`), so one backup captures it; a custom archive must be backed up with the log, and a restore of the log without its archive reads as a `missing` range in `archiveCoverage` (and makes the erasing content sweep refuse). |
| **Timer, lease and branch rows** | Keep them in the event store's database so one backup captures them. Leases are ephemeral: a restored lease is expired by the time it matters and is harmless. |
| **Content store** | The log holds content **addresses**, not bytes. A log restored without its content store has dangling refs. Back the content store up with, or just after, the log, and run `sweepUnpinnedContent` with a `dryRun` first; erasing requires the completeness acknowledgement and every store passed ([user guide](user-guide/log-and-read-models.md#log-lifecycle-crypto-shredding-retention--compaction-k10), retention). |
| **Key store** | Two opposite hazards, so snapshot it **together with** the event store. Too NEW: a key backup that outlives `shredSubject` defeats erasure, and restoring it resurrects destroyed keys. Too OLD: a key-store backup older than the log backup lacks every key created since, so those sealed streams are unreadable after the restore (nodes refuse delivery, and `loom doctor` will not necessarily flag it). Keep the out-of-band destruction record outside the restore set. |
| **Read models** | Derived; rebuild from the log instead of restoring. |

Rules of thumb:

- **Consistency**: take the event store, snapshot store and timer rows from the same instant (one
  database, one backup), so a snapshot never describes a log position the restored log lacks.
  Take the key store in the same instant, or just after the log backup, but never older than it
  (a stale key store makes new sealed streams unreadable). After a restore, re-run every erasure
  recorded after the backup point, from the out-of-band destruction record, so keys shredded since
  are destroyed again.
- **Incarnation**: a store assigns each execution stream an incarnation anchor, so a late write
  that observed a stream which was since deleted and re-created is refused rather than applied
  ([ADR 0129](adr/0129-creation-marker-incarnation.md)).
- **Residuals** accepted in the ADR 0130 D11 amendment and D8: a snapshot already written in plaintext
  is never rewritten or deleted; a lease expiry is decided by the store's clock, so a clock step
  forward of more than TTL/6 on the store host expires live leases early (the fence stays the write
  guard). Encrypting the files themselves against a leaked backup is a storage-layer concern
  ([encryption at rest](loom-2.0/11-encryption-at-rest.md)).
- **Test the restore**: boot a node against the restored copy, run `loom doctor`, `loom census`, and
  replay a few executions with `loom debug`.

---

## 6. Pre-flight checklist (`loom doctor`)

Run `loom doctor` against the built config before each deploy and after each restore. It runs every
check whose input it can find and says which it skipped. Exit code 1 means a defect; a skip or an
advisory never fails the run but is never a pass ([usage-cli.md](usage-cli.md), "Validate before you
run").

Before you ship, confirm:

- [ ] `loom doctor` is green and you have read every `-` (skipped) and `!` (advisory) line.
- [ ] **Heartbeat leases**: `heartbeat leases on` with scope `cluster` for a multi-node deployment.
      An advisory for `host` or `unknown` scope means the evidence holds only if every node shares
      that store.
- [ ] **Timers**: `durable timers` passes (schedules need `timers.store`), and `timer wake ownership`
      has `timers.leases` before there is a second node.
- [ ] **Memory store**: a durable `memoryStore` if agents must remember across restarts.
- [ ] **Encryption**: no `snapshot-plaintext-under-encrypting-events` finding; the snapshot store
      seals under the event store's `KeyStore`.
- [ ] **Postgres**: `max_connections` covers nodes x (`pool.max` + 1 listener); `notifyBuckets` equal
      everywhere; the timer store is in the same database as the log.
- [ ] `onStoreError` is the same on every node; `onStorageError` is wired to an alert.
- [ ] A recovery path exists: a scheduled `recoverAbandoned` sweep or a `TimerService` with leases,
      and an operator who knows `loom census` / `loom recover`.
- [ ] A backup of event store, snapshot store and content store exists and a restore has been
      rehearsed (section 5).
