import { type ArchiveStore, type EventStore, decoratedInnerOf } from "@loom/event-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";

// ── ADR 0130 D8 (kernel half) - a checkpoint of a sealing log must itself be sealed ──────────
//
// A snapshot holds the DECRYPTED fold. When the event store seals payloads, a snapshot store that
// does not seal the WHOLE state under the SAME KeyStore moves sealed data out of reach of a key
// shred (a static `sensitive` path list cannot name the dynamic `variables._waitAnswers.<waitId>`
// keys). The kernel therefore refuses the checkpoint: at construction (fail fast) and again at each
// save (stores can be composed or reconfigured late).

/**
 * Why a checkpoint into this snapshot store is refused. `not-sealed`: the store does not report
 * `sealsWholeState`. `keys-not-shared`: it does, but not under the event store's `KeyStore`.
 */
export type PlaintextCheckpointReason = "not-sealed" | "keys-not-shared";

/**
 * The event store seals payloads but a checkpoint would not be sealed (ADR 0130 D8). A
 * configuration error, never retryable. At construction it is thrown to the caller; at save time
 * it is thrown into the best-effort checkpoint `try/catch`, i.e. it reaches `onStorageError` and
 * does NOT fail the run (the log is the source of truth; nothing was written).
 */
export class PlaintextCheckpointError extends Error {
  readonly retryable = false;
  constructor(
    readonly reason: PlaintextCheckpointReason,
    readonly executionId?: string,
    /** What the refused snapshot store is for, in the message: the runtime's, or an archive's. */
    readonly target: "snapshot store" | "archive snapshot store" = "snapshot store"
  ) {
    super(
      `${executionId !== undefined ? `execution "${executionId}": ` : ""}the event store seals payloads, but the ${target} ${
        reason === "not-sealed"
          ? "does not seal the whole folded state (a plaintext or static-`sensitive`-path store leaves variables._waitAnswers in the clear)"
          : "does not share the event store's KeyStore (a shred of the subject would not erase the checkpoint)"
      }, so the checkpoint is refused. Fix it one of two ways: (1) build the ${target} with \`new EncryptingSnapshotStore(inner, keys, { sealState: true })\` over the SAME KeyStore as the event store; or (2) accept a plaintext checkpoint (for example on an encrypted volume, or while migrating) with \`security.crypto.allowPlaintextCheckpoints: true\` (\`allowPlaintextCheckpoints: true\` on the WorkflowRuntime).`
    );
    this.name = "PlaintextCheckpointError";
    Object.setPrototypeOf(this, PlaintextCheckpointError.prototype);
  }
}

/** The structural encryption marker an encrypting store exposes (decorators carry it up). */
function keysOf(store: unknown): object | undefined {
  const keys = (store as { keys?: unknown } | undefined)?.keys;
  return typeof keys === "object" && keys !== null ? keys : undefined;
}

/**
 * Does the event store seal payloads at all (D7 capability with non-empty `covers`)? Evaluated LIVE
 * (`registerSensitive` can change it). A store without the 2.5.0 capability reports nothing: the
 * kernel cannot know, so it is unaffected (`loom doctor` still warns via the structural `keys` probe).
 * A `ShardSealingMismatchError` from a sharded store PROPAGATES: it fails closed, never a permitted
 * plaintext checkpoint.
 */
export function eventStoreSeals(eventStore: EventStore | undefined): boolean {
  const covers = eventStore?.sealingCapability?.()?.covers;
  return covers !== undefined && covers.length > 0;
}

/**
 * The D8 rule: when the event store seals, the snapshot store must report `sealsWholeState === true`
 * AND share the event store's `KeyStore` (identity; the boolean alone is forgeable by any host
 * object, the threat being misconfiguration). Returns the refusal reason, or `undefined` when a
 * checkpoint is permitted (including: the event store seals nothing, or there is no snapshot store).
 */
export function plaintextCheckpointReason(
  eventStore: EventStore | undefined,
  snapshotStore: SnapshotStore | undefined
): PlaintextCheckpointReason | undefined {
  if (snapshotStore === undefined || !eventStoreSeals(eventStore)) return undefined;
  if ((snapshotStore as { sealsWholeState?: unknown }).sealsWholeState !== true)
    return "not-sealed";
  const eventKeys = keysOf(eventStore);
  // An event store that seals but exposes no `keys` cannot be compared; the boolean must do.
  if (eventKeys !== undefined && keysOf(snapshotStore) !== eventKeys) return "keys-not-shared";
  return undefined;
}

/** Throws {@link PlaintextCheckpointError} when {@link plaintextCheckpointReason} says so. */
export function assertCheckpointSealed(
  eventStore: EventStore | undefined,
  snapshotStore: SnapshotStore | undefined,
  executionId?: string,
  target: "snapshot store" | "archive snapshot store" = "snapshot store"
): void {
  const reason = plaintextCheckpointReason(eventStore, snapshotStore);
  if (reason !== undefined) throw new PlaintextCheckpointError(reason, executionId, target);
}

// ── ADR 0138 - the compaction archive must sit inside the same erasure boundary ───────────────
//
// `LogLifecycle.compact` MOVES the removed events into the archive. When the event store seals at
// rest, a plaintext archive would hold the decrypted log outside the KeyStore, so shredding the
// subject would no longer erase the archived copy. Same rule as the checkpoint above, one store over.

/** Why a compaction archive is refused: it does not seal its segments, or not under the log's KeyStore. */
export type PlaintextArchiveReason = "not-sealed" | "keys-not-shared" | "subject-mismatch";

/** The event store seals payloads but the compaction archive would not (ADR 0138). Never retryable. */
export class PlaintextArchiveError extends Error {
  readonly retryable = false;
  constructor(
    readonly reason: PlaintextArchiveReason,
    readonly executionId?: string
  ) {
    super(
      `${executionId !== undefined ? `refusing to compact "${executionId}": ` : ""}the event store seals payloads, but the compaction archive ${
        reason === "not-sealed"
          ? "does not seal its segments (it would hold the decrypted log outside the erasure boundary)"
          : reason === "keys-not-shared"
            ? "does not share the event store's KeyStore (a shred of the subject would not erase the archived copy)"
            : "seals under a different erasure subject than the event store (a custom `subjectOf` on one side only: a shred of the log's subject would leave the archived copy readable)"
      }. Wrap the archive store in \`new EncryptingArchiveStore(inner, keys, { subjectOf })\` over the SAME KeyStore and the SAME \`subjectOf\` as the event store. Nothing was archived, saved or truncated.`
    );
    this.name = "PlaintextArchiveError";
    Object.setPrototypeOf(this, PlaintextArchiveError.prototype);
  }
}

/**
 * The ADR 0138 rule: when the event store seals (or exposes a KeyStore), the archive must report
 * `sealsSegments === true` AND share the event store's KeyStore by identity. `undefined` = permitted.
 */
export function plaintextArchiveReason(
  eventStore: EventStore,
  archive: ArchiveStore
): PlaintextArchiveReason | undefined {
  const eventKeys = keysOf(eventStore);
  if (!eventStoreSeals(eventStore) && eventKeys === undefined) return undefined;
  if ((archive as { sealsSegments?: unknown }).sealsSegments !== true) return "not-sealed";
  if (eventKeys !== undefined && keysOf(archive) !== eventKeys) return "keys-not-shared";
  // M4: the SUBJECT mapping must agree too, or a shred of the log's subject misses the archive.
  // Compared by identity (both default to the shared `defaultSubjectOf`); a store that does not
  // expose its mapping (wrapped) cannot be compared and is not refused here.
  const eventSubject = (eventStore as { subjectOf?: unknown }).subjectOf;
  const archiveSubject = (archive as { subjectOf?: unknown }).subjectOf;
  if (
    typeof eventSubject === "function" &&
    typeof archiveSubject === "function" &&
    eventSubject !== archiveSubject
  ) {
    return "subject-mismatch";
  }
  return undefined;
}

/**
 * The tenant a store is scoped to (`TenantScopedEventStore` / `TenantScopedArchiveStore` expose
 * `tenantScope`). Decorators carry the marker up (`installOptional` / `forwardStoreMarkers`), and
 * the walk also looks through every layer a decorator recorded as wrapping (`decoratedInnerOf`) and
 * through a visible `inner`, so a layer that hides its inner store - or forgets the marker - cannot
 * make a scoped log read as unscoped (ADR 0138 H3).
 */
export function tenantScopeOf(store: unknown): string | undefined {
  let cur: unknown = store;
  for (let i = 0; i < 16 && typeof cur === "object" && cur !== null; i++) {
    const t = (cur as { tenantScope?: unknown }).tenantScope;
    if (typeof t === "string") return t;
    cur = decoratedInnerOf(cur) ?? (cur as { inner?: unknown }).inner;
  }
  return undefined;
}

/**
 * Compaction through a tenant-scoped event store with a shared (or differently scoped) archive would
 * mix tenants' segments: refused, nothing moved (ADR 0138 H3).
 */
export class ArchiveTenantMismatchError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly eventTenant: string | undefined,
    readonly archiveTenant: string | undefined,
    /** The operator's declared tenant (`LogLifecycle` option `tenant`), when one was given. */
    readonly declaredTenant?: string
  ) {
    super(
      `refusing to compact "${executionId}": ${
        declaredTenant === undefined
          ? ""
          : `the lifecycle is declared for tenant "${declaredTenant}"; `
      }the event store is ${
        eventTenant === undefined
          ? declaredTenant === undefined
            ? "not tenant-scoped"
            : "not visibly tenant-scoped (a store layer that hides its inner store without forwarding the tenantScope marker is refused, not assumed unscoped)"
          : `scoped to tenant "${eventTenant}"`
      } but the compaction archive is ${
        archiveTenant === undefined ? "not tenant-scoped" : `scoped to tenant "${archiveTenant}"`
      } — a shared archive would mix tenants' history (cross-tenant reads, and a retention delete of another tenant's segments). Wrap the archive in \`new TenantScopedArchiveStore(archive, tenant)\` for the same tenant. Nothing was archived, saved or truncated.`
    );
    this.name = "ArchiveTenantMismatchError";
    Object.setPrototypeOf(this, ArchiveTenantMismatchError.prototype);
  }
}

/** A range of sequences the archive and the log together cannot show (see `LogLifecycle.archiveCoverage`). */
export interface UnarchivedRange {
  readonly from: number;
  readonly through: number;
  /**
   * `"legacy"`: removed by a compaction that predates the archive (ADR 0138); only a folded checkpoint
   * remains (in the snapshot store, and preserved in the archive by the next compaction:
   * `readLegacyCheckpoints`). `"missing"`: a compaction that DID archive removed it, and no archive
   * segment holds it now - the archive was wiped, swapped for an empty one, or truncated. A loss to
   * investigate. Limit: the distinction rests on the compaction's checkpoint (its id carries the
   * archiving mark); a log whose last checkpoint was since pruned or replaced reads as `"legacy"`.
   */
  readonly why: "legacy" | "missing";
}

/**
 * An audit read of the original log was asked for a range the archive cannot fully return: events
 * a pre-ADR-0138 compaction removed, whose only trace is a legacy checkpoint, or events nothing
 * holds. Reported, never a silent hole; pass \`{ allowIncomplete: true }\` to read what exists.
 */
export class ArchiveIncompleteError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly ranges: readonly UnarchivedRange[]
  ) {
    super(
      `archive "${executionId}": the original log is not fully recoverable as events — ${ranges
        .map(
          (r) =>
            `[${r.from}..${r.through}] ${r.why === "legacy" ? "was compacted before the archive existed (only its folded checkpoint survives: in the snapshot store, and LogLifecycle.readLegacyCheckpoints once a compaction preserved it)" : "is held by neither the log nor the archive"}`
        )
        .join("; ")}. Pass { allowIncomplete: true } to read the events that exist.`
    );
    this.name = "ArchiveIncompleteError";
    Object.setPrototypeOf(this, ArchiveIncompleteError.prototype);
  }
}

/** The log and the archive hold DIFFERENT bytes for the same sequence (a duplicate that should be identical). */
export class ArchiveLogMismatchError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly sequences: readonly number[]
  ) {
    super(
      `archive "${executionId}": the surviving log and the archive disagree on sequence ${sequences.slice(0, 5).join(", ")}${sequences.length > 5 ? ` (+${sequences.length - 5} more)` : ""} — the same sequence holds different bytes in each, so neither is taken as the original. One was altered after the compaction.`
    );
    this.name = "ArchiveLogMismatchError";
    Object.setPrototypeOf(this, ArchiveLogMismatchError.prototype);
  }
}

/** `LogLifecycle.compact` was called with no compaction archive configured. Fail closed (ADR 0138). */
export class CompactionArchiveRequiredError extends Error {
  readonly retryable = false;
  constructor(readonly executionId: string) {
    super(
      `refusing to compact "${executionId}": no compaction archive is configured, and compaction MOVES the removed events into one (ADR 0138) — it never deletes them. Configure one: \`sqliteStorage()\`/\`postgresStorage()\` provide it; otherwise pass \`storage.archiveStore\` (or \`durability.retention.compactionArchive\`) to defineConfig, or \`compactionArchive\` to \`new LogLifecycle(...)\` (for example \`new InMemoryArchiveStore()\` for a volatile log). Nothing was archived, saved or truncated.`
    );
    this.name = "CompactionArchiveRequiredError";
    Object.setPrototypeOf(this, CompactionArchiveRequiredError.prototype);
  }
}

/**
 * ADR 0139 - a reserved-stream trim or delete (`trimInbox`, the topic-stream trim, the quarantine
 * trim, `deleteInbox`) was asked to remove envelopes and no archive is configured. Such a removal
 * MOVES the envelopes (ids, timestamps, sender metadata) into the archive first; it never discards
 * them. Fail closed: nothing was archived or removed.
 */
export class ReservedStreamArchiveRequiredError extends Error {
  readonly retryable = false;
  constructor(
    readonly streamId: string,
    readonly op: "trim" | "delete" = "trim"
  ) {
    super(
      `refusing to ${op} reserved stream "${streamId}": no archive is configured, and removing its envelopes MOVES them into one (ADR 0139) - the message payload survives in MESSAGE_CONSUMED, but the envelope's id, timestamp and sender metadata would be lost. Configure one: \`sqliteStorage()\`/\`postgresStorage()\` and \`storage: { kind: "memory" }\` provide it; otherwise pass \`storage.archiveStore\` (or \`durability.retention.compactionArchive\`) to defineConfig, or \`inboxArchive\` to \`new WorkflowRuntime(...)\`. Nothing was archived or removed.`
    );
    this.name = "ReservedStreamArchiveRequiredError";
    Object.setPrototypeOf(this, ReservedStreamArchiveRequiredError.prototype);
  }
}

/**
 * ADR 0139 M1 - the durable inbox is on and no archive was configured for it (and none could be defaulted:
 * the event store is not in-memory, or it seals/is tenant-scoped in a way a default cannot follow). The
 * inbox MOVES what a trim or delete removes into an archive, so a deployment without one could only
 * keep every stream forever (until `inboxMaxRetained` refuses sends). Refused at construction rather than
 * discovered at the first trim. Pass `inboxArchive` (the compaction archive; `defineConfig` does), or
 * `inboxArchive: "none"` to run without trimming and say so.
 */
export class InboxArchiveRequiredError extends Error {
  readonly retryable = false;
  constructor() {
    super(
      'kernel.features.inbox needs an archive to MOVE trimmed and deleted inbox envelopes into (ADR 0139), and none was configured. Pass `inboxArchive` to `new WorkflowRuntime(...)`, or `storage.archiveStore` / `durability.retention.compactionArchive` to defineConfig (`sqliteStorage()`, `postgresStorage()` and `storage: { kind: "memory" }` provide one). To run WITHOUT trimming, say so: `inboxArchive: "none"` (streams then grow until `inboxMaxRetained` refuses sends). An in-memory event store gets an in-memory archive by default; a sealing or tenant-scoped one needs it passed explicitly.'
    );
    this.name = "InboxArchiveRequiredError";
    Object.setPrototypeOf(this, InboxArchiveRequiredError.prototype);
  }
}

/**
 * ADR 0139 D8 - a reserved-stream delete needs `EventStore.deleteThrough` (SPI 2.6.0), the one atomic
 * delete bounded by what was archived, and the event store has none. The only alternative is a
 * whole-stream `deleteExecution`, which would remove a message appended after the archive's read
 * without archiving it, so the delete is REFUSED: the stream is kept (archived, intact, and retried
 * by the next terminal, send re-check or `reclaimInbox`). Nothing was removed.
 */
export class ReservedStreamDeleteUnsupportedError extends Error {
  readonly retryable = false;
  constructor(readonly streamId: string) {
    super(
      `refusing to delete reserved stream "${streamId}": the event store has no \`deleteThrough\` (EventStore SPI 2.6.0), so a message appended after the stream was archived could not be told from one that was, and a whole-stream delete would lose it silently (ADR 0139 D8). The stream was kept. Use a store that implements \`deleteThrough\` (the in-memory, SQLite and Postgres stores do; decorators forward it; \`hashChainedEventStore\` offers it only with \`allowCompaction\`).`
    );
    this.name = "ReservedStreamDeleteUnsupportedError";
    Object.setPrototypeOf(this, ReservedStreamDeleteUnsupportedError.prototype);
  }
}

/**
 * Compaction would remove an event that is neither in the archive nor after the archive's last
 * segment (for example a kind a previous compaction kept, released later by changing
 * `pinnedEventTypes`): the archive is append-only and contiguous, so it cannot take the event.
 * Nothing was truncated.
 */
export class ArchiveGapError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly sequences: readonly number[],
    op: "compact" | "trim" | "delete" = "compact"
  ) {
    super(
      `refusing to ${op} "${executionId}": event(s) at sequence ${sequences.slice(0, 5).join(", ")}${sequences.length > 5 ? ` (+${sequences.length - 5} more)` : ""} are below the compaction archive's last segment but not in it (a kind an earlier compaction kept in place, released since), and the archive is append-only, so truncating them would lose them. Keep \`pinnedEventTypes\` as it was for this execution. Nothing was archived, saved or truncated.`
    );
    this.name = "ArchiveGapError";
    Object.setPrototypeOf(this, ArchiveGapError.prototype);
  }
}
