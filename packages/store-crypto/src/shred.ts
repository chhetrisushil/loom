import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
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

  // 1. Destroy the key FIRST — the erasure is effective even if a tombstone
  //    append later fails (a retry re-appends; the data is already unrecoverable).
  await keys.destroy(subjectId);

  // 2. Tombstone each affected execution's log (A3).
  for (const exId of executionIds) {
    const sequence =
      options.tombstoneSequenceOf !== undefined
        ? await options.tombstoneSequenceOf(exId)
        : (await rawEventStore.read(exId)).length; // next sequence after the tip
    const tombstone: EventEnvelope = {
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
    };
    await rawEventStore.append(tombstone);
  }
}
