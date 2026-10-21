import type { Snapshot } from "@loom/snapshot-runtime";
import { decryptValue, envelopeAad } from "./crypto";

// The whole-state sealing format of EncryptingSnapshotStore (`sealState: true`), in a module of its
// own so shred.ts can open a sealed state without importing the store (which imports shred.ts).

export function isWholeStateEnvelope(state: unknown): boolean {
  return typeof state === "object" && state !== null && "__loomEnc" in state;
}

/** Versioned tag of the whole-state AAD binding; stored in the envelope (`aad`). */
export const SNAP_AAD_V = "loom-snap-v1";

/** The context a whole-state envelope is bound to: the slot it lives in. */
export function slotOf(s: Pick<Snapshot, "executionId" | "sequence">): string {
  return `${s.executionId}|${s.sequence}`;
}

/**
 * Open a whole-state envelope with `key`, for a lifecycle reader that holds the key but not a store
 * (shredSubject classifying a log). `undefined` when the state is not a whole-state envelope or does
 * not open. Internal: not exported from the package index.
 */
export function openWholeState(
  snapshot: { executionId: string; sequence: number; state: unknown },
  key: Buffer
): unknown {
  try {
    if (!isWholeStateEnvelope(snapshot.state) || envelopeAad(snapshot.state) !== SNAP_AAD_V) {
      return undefined;
    }
    return decryptValue(key, snapshot.state, slotOf(snapshot));
  } catch {
    return undefined;
  }
}
