# @loom/plugin-content

The content-addressed blob seam. A large value leaves the log by reference: the log keeps a thin, ordered
authority and the bytes live in a `ContentStore`, addressed by the hash of the bytes (`sha256:<hex>`).
Use it when payloads are too big or too sensitive to keep inline, when forks should share blobs, or when
you need to reclaim stored bytes safely. The durable store here is `SqliteContentStore` (`@loom/plugin-sqlite`);
`@loom/plugin-crypto` has an `EncryptingContentStore`, and you can implement the SPI for another backend.

```ts
import { defineConfig } from "@loom/app";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  ContentResolvingEventStore,
  InMemoryContentStore,
  sweepUnpinnedContent,
} from "@loom/plugin-content";

const content = new InMemoryContentStore();
const inner = new InMemoryAsyncEventStore();

// Move one payload field per event kind out of the log; reads resolve it back.
const events = new ContentResolvingEventStore(inner, content, {
  externalize: { STEP_COMPLETED: ["output.document"] },
});
export const app = defineConfig({ storage: { kind: "custom", eventStore: events } });

// Mark-and-sweep reclamation. The API erases unless `dryRun: true`, so look first.
export async function sweep(now: number) {
  return sweepUnpinnedContent({
    eventStores: [inner], // every live store and every archive; scan the raw store
    contentStore: content,
    pinnedEventTypes: ["FINDING_RECORDED"],
    olderThanMs: 30 * 24 * 3600_000,
    now, // LOG time, compared against event timestamps
    dryRun: true,
  });
}
```

## Surface

- **Store seam.** `ContentStore` (`put`, `get`, `delete`, with optional `getMany`, `touch`, `listPage`,
  `deleteIfUntouchedSince`, `touchClock`), `InMemoryContentStore`, `CachingContentStore`.
- **Log integration.** `ContentResolvingEventStore` (externalize on write, resolve on read),
  `ContentTouchingSnapshotStore`, `externalizePathsFromSteps` (derives paths from steps that mark an
  output `externalized()`), `ContentRef`, `collectContentRefs`.
- **Reclamation.** `sweepUnpinnedContent`, `pinByEventKinds`, and the errors it refuses with
  (`ReclaimOrphansAckError`, `ArchiveStoresRequiredError`, `SealedArchiveScanError`, and others).

## Behaviour that surprises people

- **Which refs can be reclaimed.** A bare ref in a payload is load-bearing: the resolving store throws
  `ContentMissingError` when its blob is gone, so a sweep keeps it while any scanned event cites it. The
  same goes for a ref cited by a `pinnedEventTypes` event, a `roots` address, an archive segment or a
  snapshot. Only an ADR 0054 claim-check envelope's `ref` is TTL-reclaimable, and not even that when the
  envelope has `retain: true` at the top-level `output` of a `STEP_COMPLETED` (ADR 0140). A nested
  `retain: true` lookalike does not count.
- **Reclaimable refs age from the end of the run.** A cited ref's age runs from the citing execution's
  end if that is later than the citation (ADR 0146), so a blob cannot be erased while the log citing it
  is retained under the same policy. A running or re-opened execution keeps the citation clock. The
  change only ever deletes less; a dry run lists what it kept in `heldByEndClock`.
- **Two clocks.** `now` is LOG time, compared with event timestamps. The race guard uses the store's
  own touch clock (`touchedBefore`, default `touchClock() - olderThanMs`). Without
  `deleteIfUntouchedSince` the sweep falls back to a plain delete and reports `raceSafe: false`.
- **The API erases by default.** Only `dryRun: true` is a dry run (the `loom sweep content` CLI defaults
  to one). Give exactly one of `olderThanMs` or `policy`.
- **Erasing orphans is gated.** `reclaimOrphans` needs `{ completeScan: true }` (a bare `true` throws),
  a store with `touch`, `listPage` and `deleteIfUntouchedSince`, and a margin of at least 60 s. It also
  needs `snapshotsTouchContent: true` when you pass `snapshotStores`. Passing it asserts that
  `eventStores`, `snapshotStores` and `roots` cover every place that cites content; the sweep cannot
  detect a store you left out.
- **Compaction needs archives.** An erasing pass refuses a compacted log its `archiveStores` do not
  cover (`ArchiveStoresRequiredError`) unless `acknowledgeUnarchivedLogs: true`.
- **Deleting a log does not delete blobs.** `deleteExecution` and `truncatePrefix` leave them, because
  forks share content. Reclamation is the sweep, or `contentStore.delete(ref)`.
- **A sealing store cannot back `ContentResolvingEventStore`.** The constructor throws `TypeError` for
  `sealsContent: true`, since that path does not carry the owning execution. Compose it inside an
  audit chain, not outside, or the chain hashes only the ref.

## See also

- API reference: section "`@loom/plugin-content` — the content-addressed blob seam" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [operations](../../docs/operations.md), [plugins](../../docs/plugins.md).
- ADRs: [0046 content store seam](../../docs/adr/0046-content-store-seam-thin-authoritative-log.md),
  [0055 pin seam and content GC](../../docs/adr/0055-k10-6-pin-seam-content-gc.md),
  [0140 agent claim-check](../../docs/adr/0140-agent-claim-check-opt-in.md),
  [0145 retention policy](../../docs/adr/0145-app-owned-retention-policy.md),
  [0146 content age from execution end](../../docs/adr/0146-content-age-from-execution-end.md).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).
