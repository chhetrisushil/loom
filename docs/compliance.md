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
  compliance: { subjectOf },
});

app.subjectIndex?.executionsOf("user-42"); // ["exec-a", "exec-b"]
```

It is rebuildable from a cold log (`SubjectIndex.fromEvents(events, subjectOf)`) — the live
and rebuilt indexes are identical (P2).

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

## Triage & scope

`@loom/compliance` is a 1P **authoring/application-tier** package above the kernel — subject
rights are policy, not a kernel or vendor concern. It depends only on the kernel read path
(`EventStore.read`, `foldEvents`).

**Not in scope (yet):**

- **Erasure (`eraseSubject`, T3 Phase B)** — the write side; gated on the in-flight erasure
  protocol (`ERASURE_PENDING`).
- **`loom compliance report`** cold-storage inventory — needs a `listExecutions` store-SPI
  enumerator (the live index already answers per-subject queries).
- **RoPA / breach-scoping (T3-R6)** and **tenant-scoped index (T3-R2.4)** — deferred on
  manifest-sensitivity (R1.3) and K12 tenancy respectively.
