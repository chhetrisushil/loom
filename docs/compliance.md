# Data-subject rights (`@loom/compliance`)

> **T3 (GDPR/CCPA-enabling).** Event-sourcing is *structurally* strong for subject rights —
> every fact about a person is already in the log. `@loom/compliance` productizes that: a
> **subject index** answers "which records concern this person?" and **`exportSubject`**
> assembles an access/portability package. This is compliance-*enabling* tooling, **not legal
> advice**, and the kernel supplies no notion of "data subject" (G3 — that is policy).

## Naming the subject

The app names the subject with a `SubjectResolver` — given an event, return the subject it
concerns (usually read off `EXECUTION_STARTED` input), or `undefined`:

```ts
const subjectOf = (e) =>
  e.eventType === "EXECUTION_STARTED" ? e.payload.input?.userId : undefined;
```

## Subject index

`SubjectIndex` maintains `subjectId → executions` (and the O(1) reverse) as a fold over the
event stream. `defineConfig` wires it live:

```ts
const app = defineConfig({
  storage: sqliteStorage({ path: "app.db" }),
  flows: [signupFlow],
  security: { compliance: { subjectOf } },
});

app.subjectIndex?.executionsOf("user-42"); // ["exec-a", "exec-b"]
```

It is rebuildable from a cold log (`SubjectIndex.fromEvents(events, subjectOf)`) — the live
and rebuilt indexes are identical (P2).

### Multi-tenant isolation (T3-R2.4)

In a shared runtime serving several tenants (K12), two tenants can legitimately use the
**same** subject id (`"alice"` at tenant A ≠ `"alice"` at tenant B). Merging them would leak
one tenant's records into another's access/erasure request. Supply a `tenantOf` resolver to
**partition** the index — the tenant is not persisted in events by default (principal chains
aren't), so read it from input/metadata:

```ts
const app = defineConfig({
  storage: sqliteStorage({ path: "app.db" }),
  flows: [signupFlow],
  security: {
    compliance: {
      subjectOf: (e) => e.payload.input?.userId,
      tenantOf: (e) => e.payload.input?.tenant, // partition key
    },
  },
});

app.subjectIndex?.executionsOf("alice", "acme");   // only acme's alice
await app.exportSubject("alice", { tenant: "acme" }); // never crosses into globex
await app.eraseSubject("alice", "acme");              // erases only acme's alice
```

Every query, export, and erasure is tenant-scoped; `tenants()` lists the partitions. Omit
`tenantOf` and everything falls in one default partition (single-tenant apps are unchanged).

## Access & portability (Art. 15 / 20)

`app.exportSubject(subjectId)` gathers every execution the index attributes to the subject,
folds each to its current state, and (by default) includes the raw log:

```ts
const pkg = await app.exportSubject("user-42");
// { subjectId, executions: [{ executionId, workflowId, status, state, events }] }

// Access-only (no raw event log):
await app.exportSubject("user-42", { includeEvents: false });
```

An execution whose log was deleted by retention is skipped. For a **partially-erased**
subject (crypto-shredded fields), wire the crypto store in tolerant mode
(`onShredded: "tolerate"`, [K10-R4](data-classification.md)) so shredded fields export as
`{ $shredded }` rather than throwing — an honest export of what remains.

## Erasure (Art. 17 — right to be forgotten)

`app.eraseSubject(subjectId)` destroys the subject's crypto key so its sensitive fields
become unrecoverable (K10.2). Wire the shredder to the crypto plugin:

```ts
const app = defineConfig({
  storage: { kind: "custom", eventStore: encryptingStore, snapshotStore },
  flows: [signupFlow],
  security: {
    compliance: {
      subjectOf,
      erase: {
        // MUST be idempotent. shredSubject is: a re-run (key already gone) writes only the
        // tombstones still missing, so do NOT skip it just because the key is gone — that is
        // "done" only once every log also carries PAYLOAD_SHREDDED, and shredSubject checks
        // exactly that per execution (ADR 0106).
        shred: async (subjectId, executionIds) => {
          await shredSubject(keys, rawEventStore, executionIds[0], {
            subjectId,
            executionIds,
            snapshotStore, // raw or encrypting: the tombstone follows the folded tip
          });
        },
      },
    },
  },
});

const result = await app.eraseSubject("user-42");
// { outcome: "erased" | "parked" | "unknown", erased: [...], pending: [...] }
```

`shredSubject` appends its `ERASURE_PENDING` and `PAYLOAD_SHREDDED` events to the raw store
itself. An execution that ever acquired a fence (a fenced resume or inbox wake, a remote cancel,
a worker, recovery, and every parked owner that `parked: "shred"` cancels) refuses an unfenced
append, so on `StaleFenceError` the shredder takes a fence and retries; an execution that was
never fenced is not given one. It does so only when the log shows no runner (its last answering
event is a terminal or a park), by compare-and-set on the head it classified where the store
supports it. A direct call on a live fenced
execution still fails with `StaleFenceError`, before the key is destroyed. `eraseSubject` shreds
only terminal executions. A shredder you write yourself must do the same.

The **one hard rule** (T3-R4.5): never shred a fold that is still in flight. Erasure is
**liveness-gated**:

- all of the subject's executions terminal → **shred now** (`"erased"`).
- any still live → **park** the request (a durable `ERASURE_PENDING` fact on a control
  stream) and complete it automatically when the last live execution terminates
  (`"parked"`, with the blocking executions named). The park survives a restart — the
  control stream folds back to the pending set.

This is honest deferral: the request is recorded and named, never silently dropped.

**"Live" means "not terminal", a PARKED execution included.** An execution suspended on an
approval, a timer or `ctx.receive` is not `completed`/`failed`/`cancelled`/`continued`, so the
coordinator defers on it. A chat agent that parks on `receive` forever therefore blocks the
coordinated erasure forever (you get `parked` + `pending`, not a silent success). Two ways out:
cancel the execution, or opt in to shredding parked owners:

```ts
await app.eraseSubject("user-42", undefined, { parked: "shred" });
// { outcome: "erased", ..., parkedShredded: ["exec-1"] }
```

`parked: "shred"` leaves **no owner stuck**. When every non-terminal execution is **suspended**
it first CANCELS each parked owner (reason `"erased"`, under the runtime's own system authority,
through the same fenced path a normal `cancel` takes) and only then shreds, so every owner is
terminal (`cancelled`) afterwards and `parkedShredded` names the ones it cancelled. A **running**
owner still defers (its fold would read the key as it is destroyed), and so does a subject whose
cancel failed or whose owner woke up before the key went (nothing is shredded; owners already
cancelled stay cancelled). A deferred request completes only when every owner is terminal; re-issue
the call to shred once the running owner parks. Because the owners are terminal heads, the
coordinator's terminal-head purge also deletes their reserved inbox streams, which removes
plaintext inbox payloads written before crypto was enabled (see the migration edge below).
`EraseCoordinator` needs its `cancel` option for this (`defineConfig` wires it); without it the call
throws. An execution STARTED for the subject while an erasure runs is not covered by it: after the key
is destroyed its sealed writes fail loudly (the key store never mints a destroyed subject's key
again), so quiesce new work for the subject before erasing. The journaled cancel records only
`reason: "erased"` (no actor), like any cancel; keep the erasure request itself as the audit record.

An owner that was shredded some OTHER way (a direct `shredSubject` call on a parked owner) can still
be cancelled: `cancel` needs no sealed field (status, tip and workflow id are plaintext), so it
folds the redacted view of the log and appends `EXECUTION_CANCELLED` under the fence. Its `resume`
and `loadState` stay strict: both throw the typed `PayloadShreddedError` (and append nothing); the
error's `redacted` property carries the events with each sealed field replaced by
`{ $shredded: true }` for operator tooling. A compacted log whose checkpoint is sealed cannot be
rebuilt that way and keeps the error. Re-running the erasure over an already-shredded subject is
idempotent: liveness is judged on that redacted view.

### A message still in flight in an inbox (ADR 0110)

A durable inbox (`kernel.features.inbox`) holds a message in a reserved stream
(`__loom_inbox__:<chainId>`, and with per-topic streams one `…#<hash>` stream per topic plus a
`…#reg` registry, ADR 0110 D10b) until its owner consumes it, so an erasure must reach the streams
as well as the owner's log. It does, twice (every stream of the chain, the registry last, on both halves):

- **Cryptographically.** With `security.crypto` composed, `defineConfig` registers the inbox
  payload path, and the encrypting store seals a stream's payload under the OWNER's subject (the
  chain id is the generation-0 execution id, so your `subjectOf` already knows it). `shredSubject`
  therefore makes an unconsumed payload unreadable; a consumer that reaches it afterwards gets the
  `{ $shredded: true }` marker (journaled in the owner's log like any delivery, so a replay of that
  log is identical), never the raw value. Inbox reads never throw `PayloadShreddedError`: a
  sender's backlog scan and the trim must keep working. Only a DESTROYED key reads as the marker:
  ciphertext that an existing key cannot open (corruption, a drifted `subjectOf`) throws
  `PayloadUndecryptableError`, so a defect cannot pass for an erasure. A `subscribe` handler on the
  stream gets the marker too. Once the key is destroyed a `send` is refused (a destroyed key is never
  recreated; a `KeyStore` must not re-mint one). A sender cannot forge the marker: `send` refuses a
  payload that is exactly `{ $shredded: true }`. `defineConfig` also registers
  `MESSAGE_CONSUMED.payload`, so the consumed copy in the owner's log is sealed (new writes only; an
  older plaintext consumption still reads and replays). The marker is stored verbatim ONLY there
  (`MESSAGE_CONSUMED.payload`, an erased message's consumption); the same bytes on any other sensitive
  path (a step output, say) are data, sealed like any value. If the owner's workflow id cannot be
  resolved for a chain (a `subjectOf` keyed on it) the send FAILS and can be retried; nothing is ever
  sealed under a guessed subject, and the crypto layer refuses `""` as a sealing subject.
- **Physically.** When the erasure runs (every execution of the subject terminal), the
  coordinator deletes the inbox stream of each execution that is the HEAD of its chain (terminal
  and not `continued`), read BEFORE the key is destroyed. The runtime already deletes a finished
  chain's stream; this reaches the orphan a crash between a sender's append and its re-read leaves,
  which the runtime cannot map back to an owner for a fork's chain. A store without
  `deleteExecution` skips this half; the key still erases the payload.

**Migration edge: plaintext written before crypto was enabled survives a shred.** A decrypting
read passes an unsealed payload through unchanged, so a message appended (or a consumption
journaled) before `security.crypto` was composed is plaintext, and destroying the key does not
touch it. Only deleting the stream erases it, which the coordinator does for a TERMINAL chain
head. *Remedy:* before relying on the key for such a chain, cancel the owner and run the erasure
(its stream is then deleted), or delete the stream yourself; there is no re-seal API, and a
parked owner's stream is never deleted by the default erasure (it still reads it); `parked: "shred"` cancels the owner first, so its stream is then deleted.

### A node that cannot open a sealed stream (mixed fleets, ADR 0130 residuals D7)

With `security.crypto`, the encrypting store stamps `metadata.seal` (`{ v, cipher, covers }`: the
exact `EVENT_TYPE.path` entries sealed in THAT envelope) in the same append that seals a field. The
kernel checks the marker before anything is folded, replayed, handed to a flow or authorised
against. A node that cannot open it (a raw store, a crypto node whose `sensitive` map is narrower,
an older config) or that lacks the key (a different or empty `KeyStore`) refuses the whole stream:
nothing is appended, the execution is never failed, and a node that CAN open it completes it.

- **The refusal looks like an ordinary denial.** The caller gets an `ExecutionDeniedError` with the
  unknown-owner reason (`UNKNOWN_OWNER_REASON`), indistinguishable from the denial of an id that does
  not exist, and `onExecutionDenied` fires with that generic reason. No `EXECUTION_DENIED` fact is
  written (an incapable node must not write into a log it cannot read). The true cause
  (`marker-unopenable` / `key-unavailable`, sequence, covered paths) goes to operators only:
  `onStorageError` and the log, the first refusal and then every 16th, and `sealedDetailOf(err)` from
  `@loom/workflow-runtime/operator`.
- **A sealed principal is refused before the policy is consulted**, whatever `unknownOwner` says (a
  lenient policy can no longer admit a stranger to a stream this node cannot read).
- **Key gone is two different facts.** A real `shredSubject` leaves a `PAYLOAD_SHREDDED` tombstone:
  reads keep raising `PayloadShreddedError`. No tombstone means this node's `KeyStore` lacks the key:
  the store raises `KeyUnavailableError`, which the kernel turns into the refusal above. Between
  `keys.destroy` and a failed tombstone write (`ShredIncompleteError`) a read reports key-unavailable
  until the retry completes. That window is recognised only on durable evidence that THIS erasure
  began: `shredSubject` appends an `ERASURE_PENDING` (an existing, ignorable, pure-audit kind) naming
  the subject to each affected execution's log BEFORE it destroys the key (intent, then destroy,
  then tombstone). `eraseSubject` and `exportSubject` complete in the window only when the log holds
  that intent; a node whose key store never had the key (a wrong key, a partitioned key store) has
  none, so `eraseSubject`/`exportSubject` rethrow `KeyUnavailableError` and `shredSubject` refuses
  with it, writing and destroying nothing, whenever sealed data is present and the key is absent. A
  window left by a pre-intent version has no intent and must be completed by hand.
  **The sealed snapshot read follows the same rule.** `EraseCoordinator` also folds each
  execution's latest checkpoint (`snapshotStore`), and a sealing store (`EncryptingSnapshotStore`,
  notably `sealState: true`) cannot open it once the key is gone. In the window the coordinator reads
  it through the store's `loadLatestSealed` (SnapshotStore SPI 1.1.0, as `shredSubject` does) under
  the same gate: this subject's erase intent in the log AND the destruction proof. A whole-state
  sealed checkpoint has no readable status, so liveness is folded from the log above it and, when
  that settles nothing, the intent (written only to a quiescent log) reads it as terminal. A key
  that is unavailable but not proved destroyed, or with no intent, still throws
  `KeyUnavailableError`. So a crash between `keys.destroy` and the tombstones is finished by simply
  calling `eraseSubject` again (or by the next terminal event of a parked request): the liveness
  gate, `finishedChains`, the inbox-stream purge and the park bookkeeping all run on that retry.
  **Intent is not destruction (round 5).** A dangling intent (a crash before `keys.destroy`, or
  intent N of M failed) leaves the key ALIVE on the node that wrote it, and a retry on a wrong-key
  node would see the intent. So the retry also needs the KEY STORE's proof: the optional
  `KeyStore.wasDestroyed(subjectId)`, true only if THIS store destroyed the key. `shredSubject`
  throws `KeyUnavailableError` (writing nothing) when the key is absent, an intent is present and
  `wasDestroyed` is missing or false; `EraseCoordinator({ destroyed })`, `exportSubject({ destroyed })`
  and `compliance.erase.destroyed` take the same proof (`(s) => keys.wasDestroyed(s)`) and refuse
  without it. `defineConfig` wires that proof by default from the key store behind
  `security.crypto`; an explicit `compliance.erase.destroyed` overrides it, and it stays a PROOF
  function (returning `true` for a key not destroyed in the authoritative store produces a false
  erasure record). The operator's override, for a key store that cannot answer, is the per-call
  `force: "key-destroyed-elsewhere"` on `shredSubject(...)`, `app.eraseSubject(..., { force })` and
  `app.exportSubject(..., { force })`: an assertion that the key was destroyed in the authoritative
  store, and a wrong one writes a false tombstone. Third-party key stores (KMS, vault, HSM) should implement `wasDestroyed` and persist the
  destroy tombstone.
- **Unmarked streams behave exactly as before.** A stream written without a marker (before 1.25.0,
  or by a third-party sealer) makes no claim and is never refused for lacking one; the inbox shape
  guard (ADR 0130 D2-D4) still covers inbox payloads. Pre-1.25.0 nodes ignore the marker and keep
  today's exposure: upgrade every node, then rely on it.
- Caveats, not residuals: with no authorizer, or `unknownOwner: "allow"`, a missing id is "not
  found" rather than denied; a custom authorizer should return `UNKNOWN_OWNER_REASON` for an unknown
  owner to be indistinguishable.

**Snapshots: use `sealState`.** A snapshot's `variables._waitAnswers` holds an answered payload under a
dynamic key (the `waitId`), which a static `sensitive` path cannot name, so a snapshot taken while an
answered wait is in the fold holds that payload verbatim under a path-list `EncryptingSnapshotStore`.
Build the snapshot store with `new EncryptingSnapshotStore(inner, keys, { sealState: true, events: rawEventStore })` (`events` is the RAW event store beside it and is optional: with it a real shred keeps `PayloadShreddedError` for a caller outside the kernel; without it a key-gone load reads as key-unavailable unless the shred is folded into the snapshot, which the runtime turns into the generic denial and whose own log probe still surfaces a real shred as the erasure error; a production store built WITHOUT `events` therefore reports a shredded subject's pre-shred snapshot as `KeyUnavailableError` to a DIRECT (non-kernel) caller, while the kernel and the content GC resolve it through the log tombstone: pass `events` for the exact error) (the SAME
`KeyStore` as the event store; mutually exclusive with `sensitive`): the whole folded state is sealed as
one envelope (only `id`, `executionId`, `workflowId`, `sequence`, `createdAt` stay in the clear), and a
shred makes the snapshot unreadable (`PayloadShreddedError`) along with the events. `loom doctor`
reports `snapshot-plaintext-under-encrypting-events` (error for a plaintext or different-keys snapshot
store, warning for static paths) and names `security.crypto.allowPlaintextCheckpoints` as the explicit
opt-out (ADR 0130 D8). The sealed state is bound to its
execution id and sequence, so a row copied elsewhere or rolled back fails with `SnapshotUndecryptableError`;
`legacyPlaintext: "refuse"` forbids unsealed rows once none remain (the doctor checks wiring only and
cannot count plaintext snapshots still at rest). Pass the `EncryptingSnapshotStore` itself, not its inner
store, to `sweepUnpinnedContent` (an erasing pass over the raw sealed rows throws `SealedSnapshotScanError`). Snapshots already written in plaintext are not rewritten: they stay readable and the next
`save` seals the state.

**The kernel refuses a plaintext checkpoint (ADR 0130 D8).** When the event store seals payloads
(`sealingCapability()` reports covers), `new WorkflowRuntime` / `defineConfig` throws
`PlaintextCheckpointError` (`reason: "not-sealed"` or `"keys-not-shared"`) unless the snapshot store reports
`sealsWholeState` AND shares the event store's `KeyStore`: a plaintext store, a static-`sensitive`-path
`EncryptingSnapshotStore` and a `sealState` store under other keys are all refused, and the message names both
ways out. The rule is re-checked at every `save` (a store can start sealing after construction): the
breach reaches `onStorageError`, nothing is written and the run is unaffected, because a checkpoint is an
optimisation and a resume folds the log. `LogLifecycle` applies it to the retention ARCHIVE snapshot store
too (`unsafe-archive`). With `storage: { kind: "custom", eventStore }` and NO `snapshotStore`, the in-memory
default is built with `sealState` on the event store's `KeyStore` instead of being refused. The explicit
opt-out is `security.crypto.allowPlaintextCheckpoints: true` (also exposed as
`app.security.crypto.allowPlaintextCheckpoints`; `loom doctor` downgrades its findings to advisories): use it
for a snapshot store on an encrypted volume, or to keep booting while you migrate. Plaintext snapshots already
written are not rewritten or deleted.

Three limits of the sealed default, stated plainly. (1) The default keys snapshots by `executionId`; if your
`EncryptingEventStore` maps executions to subjects with a different `subjectOf` (the field is private and is
not visible to `defineConfig`), build the snapshot store yourself with the SAME `subjectOf`, or a shred of
the subject will not erase the checkpoint. (2) The in-memory default is node-local and unbounded, so a
durable event store without a durable `snapshotStore` loses checkpoints on restart (and replays from the
log); `defineConfig` warns through `observability.onWarn` when it chooses that default for a store it cannot
see to be in-memory. (3) The kernel judges the snapshot store structurally (`sealsWholeState === true` and
the identical `keys` object). A plaintext decorator that inherits BOTH properties from a sealing store (a tee
or cache layer built with `Object.create(sealing)`) would pass; the guard is against misconfiguration, not a
hostile host object.

The sender recorded on a message (`tenant`, `actor`, `onBehalfOf`) is the SENDER's identity, not
the owner's, and is not sealed by the inbox path: declare `INBOX_MESSAGE` / `MESSAGE_CONSUMED`
`sender.*` paths sensitive yourself if the sender is a data subject.

### Erasure does not reach a derived read model

A shred erases the **log**. It says nothing about anything built *from* the log, and a
[read model](plugins.md) is exactly that: RM-2 makes it "a cache of the log with a
watermark, never an authority". `eraseSubject` knows the event store and the key store;
it does not know a read model exists, and the only removal verb on `ReadModelStore` is
`clear(modelId)` — the whole model, never a row.

So after an erasure, every derived row still holds whatever the extractor copied out
before the key died — and those rows are what a console query reads. **Invalidating them
is a separate, explicit step.**

### Purge the subject's rows (preferred)

```ts
await readModels.purge("actions-by-operator", { operator: "user-42" });
```

`purge` deletes by indexed-field equality — the same semantics `query` uses, so the rows
it removes are exactly the rows the equivalent query returns — and returns the count
([ADR 0093](adr/0093-read-model-row-purge.md)). Work is proportional to the erased
subject, and it never reads the log, so none of the rebuild hazards below apply.

Three things it deliberately refuses, because an erasure that quietly does nothing is
worse than one that fails: an **empty filter** (neither "every row" — that is `clear` —
nor "no rows"), a filter naming an **undeclared field** (it could never match, so the
report would be a successful erasure of zero rows), and a **backend without the method**
(`PurgeUnsupportedError`, naming the fallback). Watermarks are untouched, which is what
makes the deletion stick: the next catch-up has nothing left to re-read.

### Folded read-model state (ADR 0132)

A [folded read model](plugins.md) keeps one state per execution, folded from the log, so it can copy
plaintext out of the log (the live event and every catch-up through `EncryptingEventStore` are decrypted).
What the model does about it, and what stays yours ([ADR 0132 D11, D12, D15](adr/0132-folded-state-read-model.md)):

- **Declare the sensitive map.** Give `ReadModelService({ sensitive })` the union of
  `sensitivePathsFromSteps(flow.steps)` and `sensitiveMapFromCovers(enc.sealingCapability().covers)`, computed
  after `defineConfig` (it also registers the framework-sealed paths: principal identity, `recordedBy`, inbox
  payloads; see [data classification](data-classification.md)). Handlers then
  receive a copy of the event with those paths (and any cipher envelope) replaced by `"[redacted]"`, and a
  state holding an envelope or a value lifted from a sensitive path is refused with `SensitiveStateError`
  (it names the model, execution, event and state path, never the value). There is no off switch.
  Prefer decrypted sources for catch-up and rebuild: on an at-rest source only masking applies.
- **What the guard cannot catch**: (a) data in a field nobody classified; (b) a transformed copy (hash,
  truncation, case folding, concatenation, substring); (c) a copy from an earlier event or another execution,
  or one under the length thresholds (6 characters, 6 digits); (d) data a handler gets from outside the event
  (handlers are pure by contract, not sandboxed); (e) free text in undeclared paths; (f) on an at-rest source
  there is nothing to compare a copy against; (g) on the live feed with no declared map, a sealed field whose
  seal marker is absent reaches the handler as delivered. State should hold identifiers, enums, counters and
  timestamps.
- **Erase what slips through** with `purgeFolded(model, { scope })` (or `{ executionId }` / `{ key }`) after
  `eraseSubject`. It writes a **tombstone**: the state becomes `NULL` and `erased` is set, but the
  watermark is kept. Live and catch-up never resurrect it: later events advance the sequence
  (`"applied-erased"`) and leave the state empty. Be honest in your records: a tombstone still carries the
  subject's `executionId` and `scope`. Those are identifiers, not values; if an identifier is itself personal
  data in your reading of the law, that is a decision for your DPO (ADR 0132 D12).
- **The cache is never served.** The per-node state cache feeds only the node's own write path and never
  answers `getMany`, `getManyByKey` or `refresh`. It is dropped on purge on that node; other nodes may hold the
  last state they wrote in memory until eviction, restart or the next event for that execution, and an erased
  marker there is re-checked against the store before use.
- **Rebuild un-tombstones.** `rebuild` clears and re-folds, so erased state returns unless the rebuild is
  erasure-safe: the log must be shredded, the source must tolerate shredded payloads (`onShredded: "tolerate"`),
  and handlers must skip `{ $shredded: true }`. A rebuild through a strict source fails part-way and leaves
  the model cleared (tombstones and watermarks gone): re-run it through a tolerant source, never a catch-up
  from a non-shredded plaintext source.
- **Error reports are safe.** The folded engine's `onError` receives the event with `payload` and `metadata`
  removed, whatever the error kind. A row model's `onError` still receives the full event, so do not log it
  unfiltered.

### `clear` + rebuild (the fallback)

Correct, always available, and *O(log)* — measured at 68× the cost of a purge for one
subject of 50 in a 20k-event corpus (`plugins/read-model/src/purge.bench.ts`). Rebuild's
cost does not depend on how much of the model the subject owned, so budget it against the
erasure SLA. Two obligations it carries that a purge does not
([ADR 0092](adr/0092-adaptive-operator-profiles-placement.md) D6 and its addendum):

1. **Rebuild through a tolerant source.** The rebuild is a read, and the authoritative
   read of a shredded subject throws `PayloadShreddedError` by design (K10-R4) — so a
   rebuild through the store the fold uses **cannot run at all**. It needs an
   `EncryptingEventStore` configured `onShredded: "tolerate"`, the same off-log posture
   `exportSubject` takes.
2. **Decide what a shredded field means to the extractor.** A tolerant read substitutes
   `{ $shredded: true }` for each erased field. An extractor that indexes it verbatim
   rebuilds the *placeholder* into the cache: not a leak — the value is genuinely gone —
   but every erased subject collapses onto one bucket in a field the app declared as an
   id. Use `isShredded` and skip the row, or map it to an explicit tombstone.

`plugins/read-model/src/erasure.test.ts` pins all of it, including the rebuild that
throws and the purge that works through the same strict source.

## Triage & scope

`@loom/compliance` is a 1P **authoring/application-tier** package above the kernel — subject
rights are policy, not a kernel or vendor concern. It depends only on the kernel read path
(`EventStore.read`/`append`, `foldEvents`). The `shred` mechanism is injected, so the package
stays decoupled from any specific crypto plugin.

**Not in scope (yet):**

- **`loom compliance report`** cold-storage inventory — needs a `listExecutions` store-SPI
  enumerator (the live index already answers per-subject queries).
- **RoPA / breach-scoping (T3-R6)** and **tenant-scoped index (T3-R2.4)** — deferred on
  manifest-sensitivity (R1.3) and K12 tenancy respectively.
