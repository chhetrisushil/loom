import type { ArchiveStore, EventStore } from "@loom/event-runtime";
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
export type PlaintextArchiveReason = "not-sealed" | "keys-not-shared";

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
          : "does not share the event store's KeyStore (a shred of the subject would not erase the archived copy)"
      }. Wrap the archive store in \`new EncryptingArchiveStore(inner, keys)\` over the SAME KeyStore as the event store. Nothing was archived, saved or truncated.`
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
  return undefined;
}

/** `LogLifecycle.compact` was called with no compaction archive configured. Fail closed (ADR 0138). */
export class CompactionArchiveRequiredError extends Error {
  readonly retryable = false;
  constructor(readonly executionId: string) {
    super(
      `refusing to compact "${executionId}": no compaction archive is configured, and compaction MOVES the removed events into one (ADR 0138) — it never deletes them. Configure one: \`sqliteStorage()\`/\`postgresStorage()\` provide it; otherwise pass \`storage.archiveStore\` (or \`retention.compactionArchive\`) to defineConfig, or \`compactionArchive\` to \`new LogLifecycle(...)\` (for example \`new InMemoryArchiveStore()\` for a volatile log). Nothing was archived, saved or truncated.`
    );
    this.name = "CompactionArchiveRequiredError";
    Object.setPrototypeOf(this, CompactionArchiveRequiredError.prototype);
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
    readonly sequences: readonly number[]
  ) {
    super(
      `refusing to compact "${executionId}": event(s) at sequence ${sequences.slice(0, 5).join(", ")}${sequences.length > 5 ? ` (+${sequences.length - 5} more)` : ""} are below the compaction archive's last segment but not in it (a kind an earlier compaction kept in place, released since), and the archive is append-only, so truncating them would lose them. Keep \`pinnedEventTypes\` as it was for this execution. Nothing was archived, saved or truncated.`
    );
    this.name = "ArchiveGapError";
    Object.setPrototypeOf(this, ArchiveGapError.prototype);
  }
}
