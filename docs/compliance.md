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
        // MUST be idempotent (no-op if already erased).
        shred: async (subjectId, executionIds) => {
          if ((await keys.get(subjectId)) !== null) {
            await shredSubject(keys, rawEventStore, executionIds[0], { subjectId, executionIds });
          }
        },
      },
    },
  },
});

const result = await app.eraseSubject("user-42");
// { outcome: "erased" | "parked" | "unknown", erased: [...], pending: [...] }
```

The **one hard rule** (T3-R4.5): never shred a fold that is still in flight. Erasure is
**liveness-gated**:

- all of the subject's executions terminal → **shred now** (`"erased"`).
- any still live → **park** the request (a durable `ERASURE_PENDING` fact on a control
  stream) and complete it automatically when the last live execution terminates
  (`"parked"`, with the blocking executions named). The park survives a restart — the
  control stream folds back to the pending set.

This is honest deferral: the request is recorded and named, never silently dropped.

### Erasure does not reach a derived read model

A shred erases the **log**. It says nothing about anything built *from* the log, and a
[read model](plugins.md) is exactly that: RM-2 makes it "a cache of the log with a
watermark, never an authority". `eraseSubject` knows the event store and the key store;
it does not know a read model exists, and the only removal verb on `ReadModelStore` is
`clear(modelId)` — the whole model, never a row.

So after an erasure, every derived row still holds whatever the extractor copied out
before the key died — and those rows are what a console query reads. Three obligations
follow, and the middle one is the one designs miss because "just rebuild it" sounds free
([ADR 0092](adr/0092-adaptive-operator-profiles-placement.md) D6):

1. **Invalidate what the subject touched.** `clear(modelId)` then re-scan. Erasure cost
   is therefore *O(log)*, not *O(subject)*: an unrelated subject's rows are rebuilt too.
   Budget it against the erasure SLA before a model grows.
2. **Rebuild through a tolerant source.** The rebuild is a read, and the authoritative
   read of a shredded subject throws `PayloadShreddedError` by design (K10-R4) — so a
   rebuild through the store the fold uses **cannot run at all**. It needs an
   `EncryptingEventStore` configured `onShredded: "tolerate"`, the same off-log posture
   `exportSubject` takes.
3. **Decide what a shredded field means to the extractor.** A tolerant read substitutes
   `{ $shredded: true }` for each erased field. An extractor that indexes it verbatim
   rebuilds the *placeholder* into the cache: not a leak — the value is genuinely gone —
   but every erased subject collapses onto one bucket in a field the app declared as an
   id. Use `isShredded` and skip the row, or map it to an explicit tombstone.

`plugins/read-model/src/erasure.test.ts` pins all three, including the rebuild that
throws.

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
