# @loomwork/compliance — data-subject export and erasure

Tooling for GDPR and CCPA style requests, built on the fact that the event log already holds everything
about a person. A **subject index** maps a subject id to the executions that concern them, `exportSubject`
assembles an access and portability package (Art. 15 and 20), and `EraseCoordinator` handles erasure
(Art. 17) by destroying the subject's encryption key so their sensitive fields cannot be read, and by
deleting copies the key does not cover (archived segments, claim-checked blobs, inbox streams). It is
compliance-enabling tooling, not legal advice, and the kernel itself has no notion of a "data subject":
you supply a `subjectOf` resolver. In an app you use it through `defineConfig` (`security.compliance`),
which exposes `app.subjectIndex`, `app.exportSubject` and `app.eraseSubject`. The full erasure behaviour is
in [docs/compliance.md](../../docs/compliance.md).

```ts
import { defineConfig } from "@loomwork/app";
import { helloFlow } from "./config"; // a flow whose input is { name }

const app = defineConfig({
  storage: { kind: "memory" },
  flows: [helloFlow],
  security: {
    compliance: {
      // Name the subject an event concerns, or return undefined.
      subjectOf: (e) =>
        e.eventType === "EXECUTION_STARTED"
          ? (e.payload as { input?: { name?: string } }).input?.name
          : undefined,
    },
    // Compliance refuses to compose unless the log is kept free of a principal's identity:
    // pass `security.crypto`, or a codec that records an opaque ref. This one records nothing.
    principalCodec: { toRef: () => undefined, fromRef: () => undefined },
  },
});

const handle = await app.runtime.start(helloFlow, { name: "ada" });
await handle.waitForCompletion();

app.subjectIndex?.executionsOf("ada"); // ["<execution id>"]
const pkg = await app.exportSubject("ada"); // Art. 15 / 20: folded state and raw events per execution
console.log(pkg.executions.length); // 1
// app.eraseSubject("ada") also needs security.compliance.erase.shred; see docs/compliance.md
await app.close();
```

## Surface

- **Index.** `SubjectIndex` (`SubjectIndex.fromEvents(events, subjectOf)` rebuilds it from a cold log),
  `SubjectResolver`, `TenantResolver`, `DEFAULT_TENANT`.
- **Export.** `exportSubject(subjectId, options)` returning a `SubjectExport` of per-execution
  `SubjectExecutionExport` (`state`, `events`, and when relevant `claimChecked`, `reservedStreams`,
  `legacyCheckpoints`, `unarchived`).
- **Erasure.** `EraseCoordinator`, `ERASURE_STREAM` (the reserved control stream its facts live on),
  `EraseSubjectResult` (`outcome` of `erased`, `parked` or `unknown`) and the `Shredder` type.
  `shredSubject` itself is in `@loomwork/plugin-crypto`.
- **Errors.** `ArchivedCopiesRemainError`, `ContentCopiesRemainError`, `SenderRedactionUnsupportedError`.

## Behaviour that surprises people

- **Compliance needs a plan for principal identity.** `defineConfig` refuses to compose with
  `security.compliance` unless `security.crypto` is composed or a `security.principalCodec` keeps the
  identity out of the log (`PrincipalRecordingRefusedError`).
- **Erasure is liveness-gated.** If every execution of the subject is terminal it shreds now (`erased`).
  If any is live it records the request durably and completes it when the last one terminates (`parked`),
  naming the blockers. A parked execution counts as live, so a chat agent waiting on `receive` blocks it
  until you cancel it or call `eraseSubject(..., { parked: "shred" })`, which cancels suspended owners
  first. A running owner still defers.
- **It fails closed before the key is destroyed.** A plaintext archive with no `deleteExecution`, or one
  holding the subject as a sender without `replaceSegments`, makes erasure throw with nothing shredded.
- **Tenants share subject ids unless you partition.** Two tenants can both have an `"alice"`; without
  `tenantOf` the index merges them. With it, every query, export and erasure is tenant-scoped.
- **Work started for the subject during an erasure is not covered.** After the key is destroyed its sealed
  writes fail, so quiesce new work first.
- **A destroyed key is evidence only if the store can prove it.** `destroyed` is a proof function; never
  stub it, because a wrong `true` produces a false erasure record.
- **Plaintext written before crypto was enabled survives a shred**, since destroying a key cannot touch
  it; only deleting its stream erases it.
- **Align `subjectOf` with the crypto plugin's.** When claim-checked blobs are sealed per subject, a
  mismatch makes erasure slower and may retain ciphertext.

## Install

`npm install @loomwork/compliance` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/compliance` — subject export & erasure (T3)" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [data-subject rights](../../docs/compliance.md) (full erasure behaviour, archives, inbox streams, claim-checked outputs), [data protection patterns](../../docs/data-protection-patterns.md), [encryption at rest](../../docs/loom-2.0/11-encryption-at-rest.md).
- ADRs: [0022 log lifecycle, retention, redaction and encryption](../../docs/adr/0022-k10-log-lifecycle-retention-redaction-encryption.md), [0138 compaction archives](../../docs/adr/0138-compaction-archives-what-it-removes.md), [0140 agent claim check](../../docs/adr/0140-agent-claim-check-opt-in.md).
- Source: `packages/compliance/src`.
