import type { EventEnvelope } from "@loom/core";
import {
  type EventStore,
  KeyUnavailableError,
  headOf,
  isAnsweringKind,
  isKeyUnavailable,
  isPayloadShredded,
  isReservedStream,
  recordsErasureIntent,
} from "@loom/event-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { hasEnvelope } from "./crypto";
import type { KeyStore } from "./keystore";
import { openWholeState } from "./snapshotSeal";

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
   * The raw store or the app's `EncryptingSnapshotStore` (tenant-scoped or not) both work:
   * the latest snapshot is read with `loadLatestSealed` (SnapshotStore SPI 1.1.0), which
   * never decrypts, so a retry after the key is gone still resolves. A store without it is
   * read with `loadLatest`; if THAT refuses because the key is gone, the call fails naming the
   * fix rather than guessing a sequence.
   */
  snapshotStore?: Pick<SnapshotStore, "loadLatest" | "loadLatestSealed">;
  /**
   * ADR 0130 D7 (round 5) - OPERATOR OVERRIDE. A retry that finds the key absent and an erase
   * intent in the log completes ONLY if `keys.wasDestroyed(subject)` is true: the log proves
   * intent, never destruction. For a key store that cannot answer, pass
   * `"key-destroyed-elsewhere"` to assert, as the operator, that the key was destroyed in the
   * authoritative store. A wrong assertion writes a FALSE tombstone while the key lives on.
   */
  force?: "key-destroyed-elsewhere";
}

/** What step 1 learns about one execution: already tombstoned, or where its tombstone goes. */
type Resolution =
  | { done: true }
  | {
      done: false;
      /** Where the tombstone goes. */
      sequence: number;
      /** Set when this log does not yet hold the erase intent: it goes at `sequence - 1`. */
      intentSequence?: number;
      /** Whether the log (tail or compacted snapshot state) already records the intent. */
      hasIntent: boolean;
      /** Whether the log (tail or latest snapshot) holds sealed (encrypted) data. */
      sealed: boolean;
      /** The log shows no runner: a terminal event, or a parked (suspended) tip. */
      quiescent: boolean;
      /** The STORED head the classification was made at: the compare-and-set is tied to it. */
      classifiedHead: number;
    };

const TERMINAL_EVENTS = new Set([
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "EXECUTION_CANCELLED",
  "EXECUTION_CONTINUED",
]);
const TERMINAL_STATUS = new Set(["completed", "failed", "cancelled", "continued"]);

/**
 * The execution status a snapshot records, or `undefined` when it cannot be read. With `sealState`
 * the whole state is a ciphertext envelope, so it is opened with the subject's key (still present
 * on the first call; gone on a retry, where the caller falls back to the erase intent in the log).
 */
async function snapshotStatus(
  latest: { sequence: number; state: unknown } | null,
  executionId: string,
  keys: KeyStore,
  subjectId: string
): Promise<string | undefined> {
  if (latest === null) return undefined;
  const plain = (latest.state as { status?: unknown } | null | undefined)?.status;
  if (typeof plain === "string") return plain;
  const key = await keys.get(subjectId);
  if (key === null) return undefined;
  const opened = openWholeState(
    { executionId, sequence: latest.sequence, state: latest.state },
    key
  );
  const status = (opened as { status?: unknown } | null | undefined)?.status;
  return typeof status === "string" ? status : undefined;
}

/**
 * Does the log show NO runner? Judged from data that sealing never hides: the LAST answering event
 * of the tail (`isAnsweringKind`, ignoring audit rows and this shredder's own events). A terminal
 * kind or a park is quiescent; a resume (a terminal followed by a re-open included) or a start with
 * no park is live. With no answering event above the snapshot, the snapshot's status decides
 * (opened with the key when sealed); if that is unreadable (a retry after the key was destroyed),
 * the erase intent already in the log is the proof, because it was only written to a quiescent log.
 * Anything else is "live": the caller then refuses rather than supersede a possible holder.
 */
function classify(
  tail: readonly EventEnvelope[],
  snapshot: string | undefined,
  hasIntent: boolean
): boolean {
  const last = [...tail].reverse().find((e) => isAnsweringKind(e));
  if (last !== undefined) {
    return TERMINAL_EVENTS.has(last.eventType) || last.eventType === "EXECUTION_SUSPENDED";
  }
  if (snapshot !== undefined) return TERMINAL_STATUS.has(snapshot) || snapshot === "suspended";
  return hasIntent;
}

/** Whether a folded state records this subject's erase intent (an `ERASURE_PENDING` folded by compaction). */
function recordsIntentInState(state: unknown, subjectId: string): boolean {
  const audit = (state as { variables?: { _erasure?: unknown } } | undefined)?.variables?._erasure;
  return (
    Array.isArray(audit) &&
    audit.some(
      (a) =>
        (a as { op?: unknown; subjectId?: unknown } | null)?.op === "pending" &&
        (a as { subjectId?: unknown }).subjectId === subjectId
    )
  );
}

/** Whether a folded state records this subject's shred (a compacted-away tombstone). */
export function recordsShred(state: unknown, subjectId: string): boolean {
  const shredded = (state as { variables?: { _shredded?: { subjectId?: unknown } } } | undefined)
    ?.variables?._shredded;
  return shredded?.subjectId === subjectId;
}

/**
 * ADR 0106 — is `executionId` already tombstoned for `subjectId`, and if not, where does its
 * tombstone go? Done means the latest snapshot's state records the shred (compaction folded
 * the tombstone into it) OR the log ABOVE that snapshot carries it; only that tail is read.
 * The sequence is the folded tip + 1.
 */
async function resolve(
  keys: KeyStore,
  store: EventStore,
  executionId: string,
  subjectId: string,
  options: ShredOptions
): Promise<Resolution> {
  const snapshots = options.snapshotStore;
  let latest: { sequence: number; state: unknown } | null = null;
  if (snapshots !== undefined) {
    try {
      latest =
        snapshots.loadLatestSealed !== undefined
          ? await snapshots.loadLatestSealed(executionId)
          : await snapshots.loadLatest(executionId);
    } catch (err) {
      // Key gone: a retry after the key was destroyed (the snapshot may predate the shred, so it
      // cannot record it, and reads as key-unavailable, ADR 0130 residuals D7).
      if (!isPayloadShredded(err) && !isKeyUnavailable(err)) throw err;
      throw new TypeError(
        `shredSubject("${subjectId}"): the snapshot store refused to read "${executionId}" because the key is already destroyed (a retry), and it does not offer loadLatestSealed (SnapshotStore SPI 1.1.0). Pass a store that does — EncryptingSnapshotStore does, and TenantScopedSnapshotStore forwards it — or the raw snapshot store, or tombstoneSequenceOf. No sequence was guessed; nothing was written.`
      );
    }
  }
  if (latest !== null && recordsShred(latest.state, subjectId)) return { done: true };
  const tail = await store.readFrom(executionId, (latest?.sequence ?? -1) + 1);
  if (
    tail.some(
      (e) =>
        e.eventType === "PAYLOAD_SHREDDED" &&
        (e.payload as { subjectId?: unknown } | null)?.subjectId === subjectId
    )
  ) {
    return { done: true };
  }
  const hasIntent =
    recordsErasureIntent(tail, subjectId) ||
    (latest !== null && recordsIntentInState(latest.state, subjectId));
  const sealed =
    tail.some((e) => hasEnvelope(e.payload)) || (latest !== null && hasEnvelope(latest.state));
  const quiescent = classify(
    tail,
    await snapshotStatus(latest, executionId, keys, subjectId),
    hasIntent
  );
  let next: number;
  if (options.tombstoneSequenceOf !== undefined) {
    next = await options.tombstoneSequenceOf(executionId);
  } else {
    const head =
      tail.length > 0
        ? tail[tail.length - 1]!.sequence
        : ((await headOf(store, executionId)) ?? -1);
    next = Math.max(head, latest?.sequence ?? -1) + 1;
  }
  // The STORED head (what `acquireFenceIf` / `appendIfUnchanged` compare against), NOT the folded
  // tip: a log compacted through its tip is `[0]` plus a checkpoint, whose stored head is 0 while
  // the folded tip is the checkpoint's sequence.
  const classifiedHead =
    tail.length > 0 ? tail[tail.length - 1]!.sequence : ((await headOf(store, executionId)) ?? -1);
  // No intent yet: it takes `next`, the tombstone follows it.
  return hasIntent
    ? { done: false, sequence: next, hasIntent, sealed, quiescent, classifiedHead }
    : {
        done: false,
        sequence: next + 1,
        intentSequence: next,
        hasIntent,
        sealed,
        quiescent,
        classifiedHead,
      };
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

/** Per-execution state for the out-of-band lifecycle appends of one `shredSubject` call. */
interface LifecycleState {
  /** The log shows no runner (terminal or parked), so taking its fence supersedes nobody live. */
  quiescent: boolean;
  /** The head the log was classified at, advanced by this call's own appends. */
  head: number;
  /** The token acquired for this execution by an earlier append of this call; reused by the next. */
  fence?: number;
}

const isStaleFence = (err: unknown): boolean =>
  (err as { name?: unknown } | null)?.name === "StaleFenceError";

/**
 * Append one erasure lifecycle event (`ERASURE_PENDING`, `PAYLOAD_SHREDDED`) out of band.
 *
 * An execution that ever held a fence (a fenced resume or inbox wake, a remote cancel, a worker,
 * recovery, every parked owner `eraseSubject({ parked: "shred" })` cancels) refuses an UNFENCED
 * append with `StaleFenceError`, so erasure could never complete for it. Mirrors the repair
 * `LogLifecycle.rehomeExecution` makes: try the plain append first, and only on `StaleFenceError`
 * take a fence and retry under it. An execution that was never fenced is therefore not given one
 * (a fence would refuse every later unfenced write to its log). The token is reused for the next
 * append of the same call.
 *
 * Escalation is guarded: the fence is taken only when the log shows no runner (a terminal event or
 * a parked tip), and by compare-and-set on exactly the observed `{head, fence}` where the store
 * offers `acquireFenceIf` (as `LogLifecycle.restoreTerminalEvent` does), so a holder that moved is
 * never superseded. Otherwise the original `StaleFenceError` is rethrown: a direct `shredSubject`
 * on a live fenced execution refuses, before the key is destroyed, as it always did.
 *
 * Shredding by `EraseCoordinator` happens only once every execution of the subject is terminal
 * (eraseSubject.ts), so the guard always passes there.
 */
async function appendLifecycle(
  store: EventStore,
  event: EventEnvelope,
  state: LifecycleState
): Promise<void> {
  const id = event.executionId;
  const withFence = (fence: number): EventEnvelope => ({
    ...event,
    metadata: { ...event.metadata, fence },
  });
  try {
    await store.append(state.fence !== undefined ? withFence(state.fence) : event);
    state.head = event.sequence;
    return;
  } catch (err) {
    if (!isStaleFence(err) || store.acquireFence === undefined || !state.quiescent) throw err;
    // Escalate: observe, then take the token by compare-and-set on that very observation, which
    // must still be the head the log was classified at (plus this call's own appends): a resume
    // between the classification and now moves the head and the shred refuses.
    let fence: number;
    if (store.appendIfUnchanged !== undefined && store.acquireFenceIf !== undefined) {
      const seen = await store.appendIfUnchanged(id, null);
      if (seen.appended || seen.head !== state.head) throw err;
      const got = await store.acquireFenceIf(id, { fence: seen.fence, parkSeq: state.head });
      if ("stale" in got) throw err; // the holder moved: not ours to supersede
      fence = got.fence;
    } else {
      // A store that cannot compare-and-set: the best available check, immediately before.
      if (((await headOf(store, id)) ?? -1) !== state.head) throw err;
      fence = await store.acquireFence(id);
    }
    state.fence = fence;
    await store.append(withFence(fence));
    state.head = event.sequence;
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
  // ADR 0107 — a tombstone belongs in an execution's log. `""` names no execution (it holds
  // what the pre-0106 compaction bug misfiled) and `__loom_*` are the kernel's control streams.
  // The SUBJECT may still be "" — to destroy the key the blank stream was encrypted under, pass
  // `{ executionIds: [] }` (or the real executions its events were re-homed into).
  const reserved = executionIds.filter(isReservedStream);
  if (reserved.length > 0) {
    throw new TypeError(
      `shredSubject: ${reserved.map((id) => JSON.stringify(id)).join(", ")} ${reserved.length === 1 ? "is a" : "are"} reserved stream id${reserved.length === 1 ? "" : "s"}, not an execution to tombstone. To destroy a subject's key without tombstoning a reserved stream, pass the real executionIds (or []).`
    );
  }
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
  //    store can still decrypt now, and a failure here leaves nothing irreversible done. An
  //    execution already tombstoned — in its log tail, or folded into its latest snapshot by
  //    compaction — is skipped: that is what makes a re-run (key already gone) write exactly
  //    the missing ones (ADR 0106).
  const pending: EventEnvelope[] = [];
  const intents: EventEnvelope[] = [];
  const lackIntent: string[] = [];
  const lifecycle = new Map<string, LifecycleState>();
  const windowed: string[] = []; // intent present, sealed data, tombstone missing
  for (const exId of executionIds) {
    const resolution = await resolve(keys, rawEventStore, exId, subjectId, options);
    if (resolution.done) continue;
    const sequence = resolution.sequence;
    lifecycle.set(exId, { quiescent: resolution.quiescent, head: resolution.classifiedHead });
    if (resolution.hasIntent && resolution.sealed) windowed.push(exId);
    if (!resolution.hasIntent) {
      if (resolution.sealed) lackIntent.push(exId);
      intents.push({
        id: `${exId}-erase-intent-${resolution.intentSequence}`,
        workflowId: "",
        executionId: exId,
        eventType: "ERASURE_PENDING",
        sequence: resolution.intentSequence!,
        timestamp: 0,
        payload: {
          subjectId,
          ...(options.reason !== undefined && { reason: options.reason }),
        },
      });
    }
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

  // 1b. ADR 0130 D7 (round 4): the key being absent is NOT, by itself, evidence that an erasure of
  //     this subject began here. A node whose key store never had the key (a wrong key, a
  //     partitioned key store) reads the same, and destroying a no-op key then tombstoning would
  //     falsely claim an erasure while the real key lives on capable nodes. Only a durable erase
  //     intent in the log proves the retry window; without it, REFUSE: nothing is written or destroyed.
  if (lackIntent.length > 0 && (await keys.get(subjectId)) === null) {
    throw new KeyUnavailableError(subjectId, lackIntent[0]);
  }
  //     Round 5: intent is not destruction. A DANGLING intent (a crash before `destroy`, or intent N
  //     of M failed) leaves the key ALIVE on the node that wrote it; a retry on a wrong-key node
  //     would see the intent, destroy nothing, and tombstone. When the key is absent and the
  //     window is entered on intent alone, proceed ONLY on the key store's own proof
  //     (`wasDestroyed`) or the operator's explicit `force`.
  if (
    windowed.length > 0 &&
    options.force !== "key-destroyed-elsewhere" &&
    (await keys.get(subjectId)) === null &&
    (await keys.wasDestroyed?.(subjectId)) !== true
  ) {
    throw new KeyUnavailableError(subjectId, windowed[0]);
  }
  //     Intent first, then destroy, then tombstone: a crash after the intent leaves the key
  //     present (the retry destroys it); a crash after the destroy leaves intent + no tombstone
  //     (the retry window, which the intent proves). An intent that cannot be written aborts
  //     BEFORE anything irreversible. `ERASURE_PENDING` is an existing, ignorable, pure-audit kind.
  for (const intent of intents) {
    await appendLifecycle(rawEventStore, intent, lifecycle.get(intent.executionId)!);
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
      await appendLifecycle(rawEventStore, tombstone, lifecycle.get(tombstone.executionId)!);
    } catch (error) {
      failures.push({ executionId: tombstone.executionId, error });
    }
  }
  if (failures.length > 0) throw new ShredIncompleteError(subjectId, failures);
}
