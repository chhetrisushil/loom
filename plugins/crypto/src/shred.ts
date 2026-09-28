import type { EventEnvelope } from "@loom/core";
import { type EventStore, headOf } from "@loom/event-runtime";
import type { KeyStore } from "./keystore";

export interface ShredOptions {
  /** The erasure subject whose key is destroyed. Default: the executionId. */
  subjectId?: string;
  /** Optional reason recorded on the tombstone (audit). */
  reason?: string;
  /**
   * Executions to tombstone with `PAYLOAD_SHREDDED`. Default: `[executionId]`.
   * When several executions (e.g. a parent and its forks, A2) share the subject,
   * pass them all so each log records the erasure.
   */
  executionIds?: string[];
  /**
   * Append the tombstone directly to the RAW inner store (NOT the encrypting
   * wrapper) so it lands after the key is gone. Provide the same inner store the
   * wrapper wraps; the append carries a monotonic sequence you supply.
   */
  tombstoneSequenceOf?: (executionId: string) => Promise<number>;
  /**
   * ADR 0106 — the snapshot store beside `rawEventStore`, so the default tombstone sequence
   * is the FOLDED tip + 1: `max(log head, latest snapshot) + 1`. A compacted log's last event
   * can sit BELOW its checkpoint (`[0]` after compacting through the tip), and a tombstone at
   * `head + 1` then lands in or below the checkpoint's slot — the next compaction deletes the
   * A3 evidence, and a gap-free `[0, 1]` reads as never compacted. REQUIRED (or
   * `tombstoneSequenceOf`) when `rawEventStore` can `truncatePrefix`.
   *
   * The raw store or the app's `EncryptingSnapshotStore` both work: sequences are resolved
   * BEFORE the key is destroyed, and a retry after it is gone reads only the sequence
   * (`latestSequence`, never a decrypt).
   */
  snapshotStore?: {
    loadLatest(executionId: string): Promise<{ sequence: number } | null>;
    latestSequence?(executionId: string): Promise<number | null>;
  };
}

/** The next sequence after the folded tip — or the log head, on a store that never compacts. */
async function nextSequence(
  store: EventStore,
  executionId: string,
  snapshots: ShredOptions["snapshotStore"]
): Promise<number> {
  const head = (await headOf(store, executionId)) ?? -1;
  let checkpoint = -1;
  if (snapshots !== undefined) {
    checkpoint =
      snapshots.latestSequence !== undefined
        ? ((await snapshots.latestSequence(executionId)) ?? -1)
        : ((await snapshots.loadLatest(executionId))?.sequence ?? -1);
  }
  return Math.max(head, checkpoint) + 1;
}

/** Whether `executionId`'s log already carries this subject's tombstone (idempotency). */
async function hasTombstone(
  store: EventStore,
  executionId: string,
  subjectId: string
): Promise<boolean> {
  return (await store.read(executionId)).some(
    (e) =>
      e.eventType === "PAYLOAD_SHREDDED" &&
      (e.payload as { subjectId?: unknown } | null)?.subjectId === subjectId
  );
}

/** Thrown when some tombstones could not be written. Re-running `shredSubject` completes them. */
export class ShredIncompleteError extends Error {
  constructor(
    readonly subjectId: string,
    readonly failures: ReadonlyArray<{ executionId: string; error: unknown }>
  ) {
    super(
      `shredSubject("${subjectId}"): the key is destroyed, but ${failures.length} tombstone(s) could not be written (${failures.map((f) => f.executionId).join(", ")}). Re-run shredSubject with the same arguments: it writes only the missing tombstones.`
    );
    this.name = "ShredIncompleteError";
    Object.setPrototypeOf(this, ShredIncompleteError.prototype);
  }
}

/**
 * K10.2 — crypto-shred a subject: destroy its key (irreversible erasure of every
 * sensitive field encrypted under it, in events AND snapshots), then append a
 * durable `PAYLOAD_SHREDDED` tombstone to each affected execution's log.
 *
 * A3 — the tombstone is written AT SHRED TIME by this lifecycle call, never at
 * replay time, so replay stays a pure read and deterministically ENCOUNTERS the
 * erasure. After this, any decrypting read of an affected execution throws
 * `PayloadShreddedError` (loud failure), and the folded state carries
 * `variables._shredded`.
 *
 * Retry-safe (ADR 0106): every tombstone sequence is resolved BEFORE the key is destroyed,
 * every append is attempted, and a partial failure throws {@link ShredIncompleteError}.
 * Re-running with the same arguments — key already gone — writes only the tombstones still
 * missing (a log that carries this subject's `PAYLOAD_SHREDDED` is skipped). So call it again
 * rather than guarding on the key: "key gone" does not mean "every log tombstoned".
 *
 * Pass the RAW inner event store (the one the {@link EncryptingEventStore}
 * wraps) so the tombstone append isn't itself encrypted and doesn't need the
 * just-destroyed key.
 */
export async function shredSubject(
  keys: KeyStore,
  rawEventStore: EventStore,
  executionId: string,
  options: ShredOptions = {}
): Promise<void> {
  const subjectId = options.subjectId ?? executionId;
  const executionIds = options.executionIds ?? [executionId];
  // Refused BEFORE the key is destroyed: nothing irreversible happens on a call that cannot
  // place its tombstone safely.
  if (
    options.tombstoneSequenceOf === undefined &&
    options.snapshotStore === undefined &&
    rawEventStore.truncatePrefix !== undefined
  ) {
    throw new TypeError(
      "shredSubject: this event store can be compacted (truncatePrefix), so the tombstone's sequence must follow the FOLDED tip — pass `snapshotStore` (the snapshot store beside it) or `tombstoneSequenceOf`. After compaction the log's last event can sit below the checkpoint, and a tombstone there would be deleted by the next compaction (ADR 0106)."
    );
  }

  // 1. Resolve every missing tombstone BEFORE the key is destroyed: an encrypting snapshot
  //    store can still decrypt now, and a failure here leaves nothing irreversible done. A
  //    log that already carries this subject's tombstone is skipped — that is what makes a
  //    re-run (key already gone) write exactly the missing ones (ADR 0106).
  const pending: EventEnvelope[] = [];
  for (const exId of executionIds) {
    if (await hasTombstone(rawEventStore, exId, subjectId)) continue;
    const sequence =
      options.tombstoneSequenceOf !== undefined
        ? await options.tombstoneSequenceOf(exId)
        : await nextSequence(rawEventStore, exId, options.snapshotStore);
    pending.push({
      id: `${exId}-shred-${sequence}`,
      workflowId: "",
      executionId: exId,
      eventType: "PAYLOAD_SHREDDED",
      sequence,
      timestamp: 0, // stamped 0 → deterministic; the fact of shredding is what matters
      payload: {
        subjectId,
        ...(options.reason !== undefined && { reason: options.reason }),
      },
    });
  }

  // 2. Destroy the key — the erasure is effective even if a tombstone append below fails
  //    (the data is already unrecoverable). Destroying an absent key is a no-op.
  await keys.destroy(subjectId);

  // 3. Tombstone each affected execution's log (A3). Every append is attempted; failures are
  //    collected, so one conflict cannot strand the executions after it. A re-run completes
  //    them (step 1 skips the ones already written).
  const failures: Array<{ executionId: string; error: unknown }> = [];
  for (const tombstone of pending) {
    try {
      await rawEventStore.append(tombstone);
    } catch (error) {
      failures.push({ executionId: tombstone.executionId, error });
    }
  }
  if (failures.length > 0) throw new ShredIncompleteError(subjectId, failures);
}
