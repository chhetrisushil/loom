# Data protection for long-running observer agents

*DX-4 of the db-copilot infrastructure series (issue #190). A copilot that continuously
records query text, telemetry, and schema history is a data-protection surface from day one —
query literals carry PII, evidence must be tamper-evident but erasable, and tenants share
infrastructure. Every answer below is shipped mechanism; this page is the assembly order.
Not legal advice.*

## The threat model in one row each

| What leaks | Where it would live | The mechanism |
| --- | --- | --- |
| PII in query literals / tool inputs | `STEP_STARTED` payloads | `secretRef` + `redactionMiddleware` (K10.3): the log records a reference, the tool receives the value |
| PII in tool outputs | `STEP_COMPLETED` payloads | `secret()`-mark output fields (K10-R1) → derived `redactOutput` (`secretOutputPathsByStep`); or `externalized()` → content store (ADR 0046) |
| Sensitive fields that must stay queryable | event payloads at rest | crypto-shredding (`@loom/plugin-crypto`, K10.2): per-subject keys; erasure destroys the key, `PAYLOAD_SHREDDED` is loud |
| Bulk telemetry outliving its purpose | content store | claim-check (ADR 0054) + TTL sweep: `loom sweep content --ttl … --apply`; findings' evidence stays pinned (K10.6, ADR 0055) |
| Whole runs outliving their purpose | event log | `loom retention run` (K10.1) with `retention: { archive, pinned }` — archive-before-delete, pins for designated events |
| Cross-tenant reads in shared deployments | every store | `TenantScopedEventStore` (K12): scoping by construction — enumeration, reads, and the K10.6 sweep all see one tenant |
| Subject-rights requests (GDPR Art. 15/17/20) | everywhere | `@loom/compliance` (T3): subject index, export, deferred erasure (`ERASURE_PENDING`) that never shreds a live fold |

## Assembly order for a copilot-shaped app

1. **Classify at the schema, once.** Mark tool/step schemas with `secret()` (never persists —
   redaction), `sensitive()` (persists encrypted — shreddable), `externalized()` (bytes leave
   the log — residency/large). The walkers derive the runtime wiring
   (`secretOutputPathsByStep`, `externalizePathsFromSteps`, `sensitivePathsFromSteps`) — policy
   lives in one place, enforcement is mechanical.

2. **Decide, don't retain.** When orchestration must branch on a sensitive value, record the
   *decision* (`ctx.decide`) so the raw value becomes an erasable leaf the fold never re-reads
   — the single most effective shrink of the erasure blast radius.

3. **Fix the retention rule jointly**, then wire it (the perpetual-agents rule): *findings and
   their evidence are permanent; runs are archivable; raw telemetry is disposable.*

   ```ts
   defineConfig({
     durability: {
       retention: {
         archive: { eventStore: archiveEvents, snapshotStore: archiveSnaps }, // K10.1
         pinned: preset.pinPredicate(eventStore),                             // K10.6
         pinnedEventTypes: preset.pinnedEventTypes, // compaction keeps findings (ADR 0106)
       },
     },
   });
   // operator cadence (nothing prunes on a timer):
   //   loom retention run  --db … --snap … --ttl 5184000000 --apply
   //   loom sweep content  --db … --snap … --content … --archive-db … --archive-snap … \
   //     --pin FINDING_RECORDED --ttl 2592000000 --orphans --apply
   ```

   **Once retention archives, `--archive-db` is REQUIRED.** The sweep sees only the citations in
   the stores you pass it. An archived run's evidence is cited only from the archive, so a sweep
   run without the archive treats it as an orphan and `--orphans` erases it (ADR 0055 D6). The
   sweep cannot tell "no archive" from "an archive you left out", so it warns and proceeds.
   Without `--orphans`, blobs whose runs were deleted, or whose `put` crashed before its event
   was appended, are never reclaimed. The command refuses `--orphans --apply` with no archive
   unless `--no-archive` asserts there is none. Under `--config` it scans the app's
   `durability.retention.archive` itself. `--orphans` also needs the snapshot stores: a
   compacted run's prefix refs live only in its checkpoint. An app that also cites blobs from
   its own tables passes them as `roots` to `sweepUnpinnedContent` (D7). The SQLite content
   store makes every erase conditional on the blob's touch time, measured on the store's own
   clock, so a blob re-cited while the sweep runs is kept (D5).

4. **Scope tenants by construction.** Wrap stores in `TenantScopedEventStore` per tenant at
   composition time. Everything downstream — reads, retention enumeration, the pinned sweep,
   read-model catch-up — inherits the boundary; no per-query discipline required.

5. **Evidence: tamper-evident AND erasable are not in tension.** Claim-checked evidence is
   content-addressed (byte-for-byte verifiable for the audit trail's lifetime) yet lives
   outside the log — erasing an *unpinned* blob is invisible to replay by contract (ADR 0054),
   and erasing a pinned one is a deliberate act against the pin policy, not a side effect.

6. **Answer the residency question with physical separation.** The authoritative log holds
   refs and decisions; bytes live in the content store, which can sit in-region
   (`externalized()` + a regional backend) while the thin log replicates.

## What to write in a product proposal's governance section

The three sentences a security review wants, all mechanically true here: *query literals never
enter the durable log in plaintext* (redaction refs); *any subject's data in the log is erasable
without history rewrite, and erased data fails loudly rather than silently* (crypto-shredding +
`PAYLOAD_SHREDDED`/`ContentMissingError`); *evidence retention is a declared policy with an
operator-driven, dry-run-first enforcement path* (K10.1 + K10.6 CLIs).

Say the scope of the second sentence out loud: it covers the **log**. Content-store blobs
(claim-checked and externalized bytes) are deduped plaintext keyed by hash, with no subject
mapping, and `EraseCoordinator` never touches them. That is a gap. Erasing a subject's blobs
takes an explicit `contentStore.delete(ref)` for each ref you know to be theirs (ADR 0055,
Consequences of D5–D7).

See also: [data-classification.md](data-classification.md), [compliance.md](compliance.md),
[user-guide.md → Log lifecycle](user-guide.md), ADRs 0022/0046/0054/0055.
