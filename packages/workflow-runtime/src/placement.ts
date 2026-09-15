import { type EventStore, readRangeOf } from "@loom/event-runtime";

// ── Where an execution belongs, after the process that decided has gone ───────
//
// `ExecutionPolicy` is a caller-side struct mapped to `DispatchMetadata` at dispatch time,
// so placement lived in the memory of whichever process dispatched. For an execution that
// runs once that is invisible. For one that suspends for a human it is gone by the time a
// timer or a recovery pass re-drives it — which is how a branch sized for a cloned database
// wakes up inside a web server (#392).
//
// `start({ computeTarget })` records the hint on the `EXECUTION_STARTED` anchor, where
// compaction preserves it and deletion removes it. This reads it back.

/** Metadata key on sequence 0. Exported so a worker/dispatcher can agree without guessing. */
export const COMPUTE_TARGET_KEY = "computeTarget";

/**
 * The compute lane this execution was started in, or `undefined` if it never declared one.
 *
 * One indexed point-read of sequence 0 — the same anchor `foldState` already probes for
 * existence, so this is cheap enough for a wake path to do on every fire.
 *
 * A HINT, not a pin. Hand it to a `PlacementPolicy` as input; a policy may route elsewhere,
 * and must, when the recorded target no longer exists — a retired lane must not strand the
 * executions that named it.
 */
export async function placementOf(
  eventStore: EventStore,
  executionId: string
): Promise<string | undefined> {
  const [anchor] = await readRangeOf(eventStore, executionId, 0, 0);
  const target = anchor?.metadata?.[COMPUTE_TARGET_KEY];
  return typeof target === "string" ? target : undefined;
}
