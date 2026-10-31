import { randomBytes } from "node:crypto";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  ArchiveConflictError,
  type ArchiveSegment,
  type ArchiveStore,
  type DestructionProof,
  type EventStore,
  type InboxStreams,
  archivedReservedStreams,
  chainIdOfFirst,
  erasureWindowView,
  headerOf,
  inboxStreamsOfChainDeep,
  isAnsweringKind,
  isErasureWindow,
  isKeyUnavailable,
  isPayloadShredded,
  isQuiescent,
  recordsErasureIntent,
  senderDigestOf,
  senderErasedMarker,
} from "@loom/event-runtime";
import { foldEvents, normalizeSnapshotState } from "@loom/replay-vm";
import { assertSnapshotIdentity } from "@loom/snapshot-runtime";
import { DEFAULT_TENANT, type SubjectIndex } from "./SubjectIndex";

// ── T3-R3/R4.5 — subject erasure (GDPR Art. 17, right to be forgotten) ─────────
//
// Erasure destroys a subject's crypto key so its sensitive fields become unrecoverable
// (K10.2). The one hard rule (R4.5): NEVER shred a fold that is still in flight — a live
// execution reading the just-destroyed key would fail. So erasure is liveness-gated:
//   • all of a subject's executions terminal  → shred now.
//   • any still live                          → PARK the request (durable ERASURE_PENDING on a
//                                               control stream) and complete it automatically
//                                               when the last live execution terminates.
// Parking is honest (the request is recorded, not silently dropped) and survives a restart
// (the control stream folds back to the pending set).

/** Reserved control stream carrying deferred-erasure facts (ERASURE_PENDING). */
export const ERASURE_STREAM = "__loom_erasure__";

const TERMINAL_STATUS = new Set<ExecutionState["status"]>([
  "completed",
  "failed",
  "cancelled",
  "continued",
]);
const TERMINAL_STATUS_OF_EVENT = new Map<string, ExecutionState["status"]>([
  ["EXECUTION_COMPLETED", "completed"],
  ["EXECUTION_FAILED", "failed"],
  ["EXECUTION_CANCELLED", "cancelled"],
  ["EXECUTION_CONTINUED", "continued"],
]);
const TERMINAL_EVENTS = new Set([
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "EXECUTION_CANCELLED",
  "EXECUTION_CONTINUED",
]);

/**
 * A compaction / inbox archive (ADR 0138 / 0139) erasure must reckon with. A PLAINTEXT archive
 * (`sealsSegments` not `true`) holds the subject's moved envelopes in the clear, so a key's destruction
 * does not reach them: erasure DELETES the subject's segments from it (`deleteExecution`). A SEALING
 * archive (`EncryptingArchiveStore`, same KeyStore as the log) is erased by the shred itself.
 */
export type ErasableArchive = Pick<ArchiveStore, "headers" | "listExecutions" | "read" | "append"> &
  Partial<Pick<ArchiveStore, "deleteExecution" | "replaceSegments">> & {
    readonly sealsSegments?: unknown;
  };

/** What an erasure removed from the plaintext archives (recorded durably as `ERASURE_ARCHIVE_DELETED`). */
export interface ArchivedCopiesDeleted {
  /** Executions whose ADR 0138 compaction segments were deleted. */
  executions: string[];
  /** Reserved streams (inbox, topic, registry, quarantine, late runs; ADR 0139) whose archived segments were deleted. */
  reservedStreams: string[];
}

/** One archived reserved stream whose sender fields erasure redacted (ADR 0139 D12). */
export interface SenderRedaction {
  streamId: string;
  /** How many archived envelopes had the erased subject's identity replaced by `{ erased: true }`. */
  envelopes: number;
}

/** Does `sender` identify the erased subject? */
export type SenderMatcher = (
  subjectId: string,
  tenant: string,
  sender: { actor?: string; tenant?: string; onBehalfOf?: string }
) => boolean;

/** The default: the sender's `actor` is the subject id (and, in a tenant partition, the tenant agrees). */
export const defaultSenderMatches: SenderMatcher = (subjectId, tenant, sender) =>
  sender.actor === subjectId && (tenant === DEFAULT_TENANT || sender.tenant === tenant);

/**
 * The staging prefix an EARLIER build used to rewrite a segment list (read, stage, delete, re-add). The
 * rewrite is now one atomic `ArchiveStore.replaceSegments` (SPI 1.1.0) and nothing writes a stage any
 * more; {@link EraseCoordinator.recoverRedactions} still restores one such a build left behind.
 */
const REDACT_STAGE = "__loom_redact__:";

/** The control-stream event types of the erasure's archive work (intent first, then the completion). */
const ARCHIVE_DELETE_INTENDED = "ERASURE_ARCHIVE_DELETE_INTENDED";
const ARCHIVE_DELETED = "ERASURE_ARCHIVE_DELETED";
const SENDER_REDACTION_INTENDED = "ERASURE_SENDER_REDACTION_INTENDED";
const SENDER_REDACTED = "ERASURE_SENDER_REDACTED";

/** How many times a redaction of one key retries a concurrent writer's conflict before it gives up loudly. */
const REDACT_RETRIES = 16;

/**
 * Erasure cannot complete while a plaintext archive still holds the subject's segments and offers no
 * way to delete them. Thrown BEFORE the key is destroyed (nothing was shredded).
 */
export class ArchivedCopiesRemainError extends Error {
  readonly retryable = false;
  constructor(readonly streams: readonly string[]) {
    super(
      `refusing to erase: a plaintext archive holds the subject's archived copies (${streams.slice(0, 5).join(", ")}${streams.length > 5 ? ` (+${streams.length - 5} more)` : ""}) and has no deleteExecution, so erasure could not remove them (a key's destruction does not reach plaintext). Use an archive that can delete (the in-memory, SQLite and Postgres archives can), or seal the archive under the event store's KeyStore (EncryptingArchiveStore). Nothing was shredded.`
    );
    this.name = "ArchivedCopiesRemainError";
    Object.setPrototypeOf(this, ArchivedCopiesRemainError.prototype);
  }
}

/**
 * Erasure cannot complete: a plaintext archive holds other chains' archived inbox envelopes naming the
 * subject as their sender, and it cannot rewrite a segment atomically (`replaceSegments`, ArchiveStore SPI
 * 1.1.0), so the identity could not be redacted. Thrown BEFORE the key is destroyed (nothing was shredded).
 */
export class SenderRedactionUnsupportedError extends Error {
  readonly retryable = false;
  constructor(readonly streams: readonly string[]) {
    super(
      `refusing to erase: a plaintext archive holds the subject's identity as the sender of archived inbox envelopes (${streams.slice(0, 5).join(", ")}${streams.length > 5 ? ` (+${streams.length - 5} more)` : ""}) and has no replaceSegments (ArchiveStore SPI 1.1.0), so erasure could not redact it. Use an archive that can (the in-memory, SQLite and Postgres archives can), or seal the archive and the senders under the event store's KeyStore (EncryptingArchiveStore). Nothing was shredded.`
    );
    this.name = "SenderRedactionUnsupportedError";
    Object.setPrototypeOf(this, SenderRedactionUnsupportedError.prototype);
  }
}

/**
 * Destroy a subject's erasure key across the given executions. Wire this to the crypto
 * plugin's `shredSubject` (bound to the KeyStore + raw store + snapshot store). MUST be
 * idempotent — a re-invocation for an already-erased subject must not double-tombstone.
 * `shredSubject` is (ADR 0106): it skips every log already carrying the subject's
 * `PAYLOAD_SHREDDED` and writes the rest. Do NOT guard on key existence — a key can be gone
 * while a tombstone append failed, and that guard would never retry it.
 */
export type Shredder = (
  subjectId: string,
  executionIds: readonly string[],
  /** The per-call operator assertion of {@link EraseSubjectOptions.force}, when given. */
  options?: { force?: "key-destroyed-elsewhere" }
) => Promise<void>;

export interface EraseCoordinatorOptions {
  index: SubjectIndex;
  /**
   * `deleteExecution` (optional) lets erasure reach the RESERVED inbox streams of the subject's
   * finished executions (ADR 0110 follow-up): see {@link EraseCoordinator}. A store without it
   * cannot delete a stream, and a payload still in flight in one is then erased only by the key
   * (the crypto plugin seals inbox payloads under the owner's subject).
   */
  eventStore: Pick<EventStore, "read" | "append"> &
    Partial<Pick<EventStore, "deleteExecution" | "listExecutionsPage">>;
  shred: Shredder;
  /**
   * ADR 0138 / 0139 - the archives that may hold the subject's moved envelopes (`defineConfig` wires the
   * compaction archive, which is also the inbox archive). Over a PLAINTEXT archive erasure DELETES the
   * subject's compaction segments and their chains' reserved-stream segments after the shred and records
   * what it deleted; it never reports `erased` while plaintext copies remain. A sealing archive needs
   * nothing: the key's destruction makes its segments unreadable.
   */
  archives?: readonly ErasableArchive[];
  /**
   * ADR 0139 D12 - which archived inbox envelopes name the erased subject as their SENDER (default:
   * `sender.actor === subjectId`, and `sender.tenant === tenant` in a tenant partition). Over a PLAINTEXT
   * archive erasure rewrites those envelopes' `payload.sender` to `{ erased: true }` in the OTHER chains'
   * archived reserved segments (their digest masks the sender, so it stays valid) and journals
   * `ERASURE_SENDER_REDACTED`. A SEALING archive needs nothing: the sender is sealed under the SENDER's
   * subject (`senderSubjectOf` on the crypto stores) and the shred erases it.
   */
  senderMatches?: SenderMatcher;
  /**
   * ADR 0139 N6 - erase the subject as a message SENDER in the crypto layer (destroy the key their identity
   * is sealed under, and the seed their handle derives from). Called after `shred`, with the subject id as
   * the actor and the tenant partition; idempotent. `defineConfig` wires it from the crypto event store's
   * `eraseSender`. Without it a sealed sender is erased by whatever the app's `shred` destroys.
   */
  eraseSender?: (subjectId: string, tenant: string) => Promise<unknown>;
  /**
   * ADR 0139 D22 - reinstate an erased sender in the crypto layer (a fresh seed, so a new handle). Backs
   * {@link EraseCoordinator.reinstateSender}; `defineConfig` wires it from the crypto event store's
   * `reinstateSender`.
   */
  reinstateSender?: (
    actor: string,
    tenant: string
  ) => Promise<{ reinstated: boolean; ref?: string; epoch?: number }>;
  /** Where a recoverable, non-fatal failure is reported (default: `console.warn`). `defineConfig` wires `onWarn`. */
  onWarn?: (message: string) => void;
  /**
   * ADR 0139 N1 - told after erasure deleted or rewrote an archive key, so a runtime that remembers the
   * key's last archived sequence (`WorkflowRuntime.invalidateInboxArchive`) forgets it. `defineConfig`
   * wires it.
   */
  onArchiveKeyChanged?: (key: string) => void;
  /**
   * ADR 0130 D7 (round 5) - proof that the key store destroyed a subject's key
   * (`(s) => keys.wasDestroyed(s)`). A PROOF function only: returning `true` for a key that was
   * NOT destroyed in the authoritative store produces a FALSE erasure record, so never stub it.
   * `defineConfig` wires it from the crypto key store's `wasDestroyed` by default. Required to
   * resume an erasure in the ShredIncomplete window: the log proves INTENT, not destruction, so
   * without it a retry that reads `KeyUnavailableError` is refused rather than reported as erased.
   * For a key store that cannot prove destruction, the operator asserts it per call with
   * {@link EraseSubjectOptions.force}.
   */
  destroyed?: DestructionProof;
  /**
   * Cancel one PARKED execution under the coordinator's own authority (a system / compliance
   * grant, never a caller's), journaled with the given reason (`"erased"`), through the runtime's
   * normal fenced cancel. REQUIRED for `eraseSubject(..., { parked: "shred" })`: that mode leaves
   * no owner stuck, so every parked owner is moved to a terminal state BEFORE its subject is
   * shredded. Resolves `true` when the cancel was performed; a rejection, or an owner that is not
   * terminal afterwards (it woke up and is running), defers the subject exactly as `"defer"`
   * does. `defineConfig` wires it to `runtime.cancel(id, reason, runtime.systemOptions())`.
   */
  cancel?: (executionId: string, reason: string) => Promise<boolean>;
  /**
   * ADR 0106 — where compaction checkpoints live. A compacted execution's log no longer holds
   * its prefix (`[0]` after compacting through the tip), so folding the log alone reads a
   * TERMINAL execution as still running and a parked erasure would wait for it forever. With
   * this, liveness folds on the latest snapshot. Pass it whenever the log can be compacted.
   */
  snapshotStore?: {
    loadLatest(
      executionId: string
    ): Promise<{ executionId?: string; sequence: number; state: ExecutionState } | null>;
    /**
     * Optional (SnapshotStore SPI 1.1.0): the latest snapshot as stored at rest, readable after the
     * subject's key is destroyed. Used ONLY in the destroy window (see `foldExecution`), so a
     * sealing store (`EncryptingSnapshotStore`) does not make the erasure's retry throw
     * `KeyUnavailableError`. Without it that retry cannot read a sealed checkpoint and rethrows.
     */
    loadLatestSealed?(
      executionId: string
    ): Promise<{ executionId?: string; sequence: number; state: ExecutionState } | null>;
  };
}

export interface EraseSubjectResult {
  subjectId: string;
  /** `erased` — key destroyed now; `parked` — deferred (live execution); `unknown` — no records. */
  outcome: "erased" | "parked" | "unknown";
  /** Executions whose data is now shredded (all of the subject's, when erased). */
  erased: string[];
  /**
   * What the erasure deleted from plaintext archives (ADR 0138 / 0139); present when it deleted anything.
   * The same fact is journaled on the control stream as `ERASURE_ARCHIVE_DELETED`.
   */
  archivedCopiesDeleted?: ArchivedCopiesDeleted;
  /** Archived reserved segments of OTHER chains whose sender fields naming the subject were redacted (plaintext archives). */
  senderRedactions?: SenderRedaction[];
  /** Live executions blocking completion (a parked request completes when these terminate). */
  pending: string[];
  /**
   * `parked: "shred"` only — the executions that were PARKED (suspended, waiting for an approval, a
   * message or a timer) when their subject was shredded. They are not finished: see
   * {@link EraseSubjectOptions.parked} for what one experiences when it resumes.
   */
  parkedShredded?: string[];
}

export interface EraseSubjectOptions {
  /**
   * What to do with a subject whose executions are not all terminal.
   *
   * - `"defer"` (**default**): any execution that is not terminal (a `suspended` one included) is
   *   LIVE: the request is recorded durably (`ERASURE_PENDING`) and completes when the last one
   *   terminates. A flow parked forever (a chat agent on `receive`) therefore blocks erasure
   *   forever; the result is an honest `parked` naming it.
   * - `"shred"` (opt-in): shred NOW when every non-terminal execution is PARKED (`suspended`).
   *   An execution that is `running` (or `pending`) still defers: its fold is in flight and would
   *   read the key as it is destroyed, which is the one hard rule (R4.5). The window between the
   *   check and the key's destruction is the shredder's to close: a parked execution that a timer,
   *   a send or a resume wakes in it becomes a running one whose reads fail (below).
   *
   * Leaves NO stuck owner. Each parked (`suspended`) owner is first CANCELLED under the
   * coordinator's own authority ({@link EraseCoordinatorOptions.cancel}, reason `"erased"`, the
   * same fenced path a normal cancel takes), and only when every owner is terminal is the subject
   * shredded. The owners are therefore terminal (`cancelled`) afterwards, so the terminal-head
   * purge of the reserved inbox streams also runs for them, which removes plaintext inbox payloads
   * written before crypto was enabled (these survive the key's destruction) too. If a cancel
   * fails, or an owner woke up and is running by then, nothing is shredded and the subject
   * defers as `"defer"` does (owners already cancelled stay cancelled: the request to erase
   * them was made). Requires {@link EraseCoordinatorOptions.cancel}; without it the call throws.
   *
   * An owner shredded some other way (a direct `shredSubject` call) can still be cancelled:
   * `cancel` folds the redacted view of its log. `resume` of it rejects with the typed
   * `PayloadShreddedError` and appends nothing; so does `loadState` (the strict, authoritative
   * read; its error carries the `redacted` events for operator tooling).
   */
  parked?: "defer" | "shred";
  /**
   * ADR 0130 D7 (round 6) - OPERATOR OVERRIDE, per call (mirrors `ShredOptions.force`). Asserts
   * that the subject's key was destroyed in the authoritative key store, for a store that cannot
   * prove it (no `wasDestroyed`). It lets a retry in the ShredIncomplete window complete, and is
   * passed through to the shredder. A wrong assertion writes a FALSE erasure record while the key
   * lives on.
   */
  force?: "key-destroyed-elsewhere";
}

const defaultWarn = (message: string): void => {
  console.warn(`[loom] ${message}`);
};

/**
 * Coordinates liveness-gated subject erasure and the auto-completion of parked requests.
 * Feed `handleEvent` the event stream (e.g. from `defineConfig`'s `onEvent`) so a parked
 * erasure completes the moment the subject's last live execution terminates.
 */
export class EraseCoordinator {
  // Parked requests keyed by `tenant\x00subject` (T3-R2.4 — two tenants may share a subject
  // id; they must not collide into one park entry). Authoritative live view; also durable.
  private readonly parked = new Set<string>();

  constructor(private readonly options: EraseCoordinatorOptions) {}

  /** Best-effort: repopulate the parked set from the durable control stream (restart recovery). */
  async loadParked(): Promise<void> {
    // The parked set FIRST: it is what the key-window guard reads, so a failure of the archive recovery
    // below must never leave it empty (that would fail open).
    for (const event of await this.options.eventStore.read(ERASURE_STREAM)) {
      if (event.eventType === "ERASURE_PENDING") {
        const p = event.payload as { subjectId: string; tenant?: string };
        this.parked.add(parkKey(p.tenant ?? DEFAULT_TENANT, p.subjectId));
      }
    }
    // ADR 0139 N1: a stage an earlier build left (a crash mid-redaction) is restored at BOOT, not at the
    // next erasure that happens to scan the archive. A failing archive (down, unreadable) is LOUD but not
    // fatal here: recovery stays pending, to be retried by `recoverRedactions` (the operator verb
    // `app.recoverArchiveRedactions`) and by the next redaction.
    try {
      await this.recoverRedactions();
    } catch (err) {
      (this.options.onWarn ?? defaultWarn)(
        `erasure coordinator: restoring interrupted archive redactions failed (${err instanceof Error ? err.message : String(err)}); the parked erasures were loaded, and the recovery stays pending - retry it with recoverArchiveRedactions() once the archive is reachable`
      );
    }
  }

  /**
   * ADR 0139 D22 (owner ruling 2026-10-31) - REINSTATE an erased message sender: the explicit, RECORDED
   * operator verb that lets a sender erased by {@link eraseSubject} send again, under a NEW handle (their
   * old messages stay erased and unlinkable to it). Without it a send from an erased sender keeps throwing
   * `SenderErasedError`. Journaled on the control stream: `SENDER_REINSTATE_INTENDED` first, then
   * `SENDER_REINSTATED` with the keyed non-identifying `ref`, the epoch, who (`options.by`) and when;
   * NEVER the plaintext identity. Resolves with whether anything was reinstated (`false`: the sender is
   * not erased, or never sent). Throws unless the coordinator was given `reinstateSender`.
   */
  async reinstateSender(
    actor: string,
    tenant: string = DEFAULT_TENANT,
    options: { by?: string } = {}
  ): Promise<{ reinstated: boolean; ref?: string; epoch?: number }> {
    const reinstate = this.options.reinstateSender;
    if (reinstate === undefined) {
      throw new TypeError(
        "reinstateSender needs the crypto layer's default sender handles: pass `reinstateSender` to the EraseCoordinator (defineConfig wires it from the crypto event store)"
      );
    }
    const by = options.by ?? "operator";
    const intentId = await this.appendControl("SENDER_REINSTATE_INTENDED", {
      ...(tenant !== DEFAULT_TENANT && { tenant }),
      by,
      at: Date.now(),
    });
    const result = await reinstate(actor, tenant);
    await this.appendControl("SENDER_REINSTATED", {
      ...(tenant !== DEFAULT_TENANT && { tenant }),
      intentId,
      by,
      at: Date.now(),
      reinstated: result.reinstated,
      ...(result.ref !== undefined && { ref: result.ref }),
      ...(result.epoch !== undefined && { epoch: result.epoch }),
    });
    return result;
  }

  /** Request erasure of a subject within a tenant. Shreds now if all executions are terminal, else parks. */
  async eraseSubject(
    subjectId: string,
    tenant: string = DEFAULT_TENANT,
    options: EraseSubjectOptions = {}
  ): Promise<EraseSubjectResult> {
    const executions = this.options.index.executionsOf(subjectId, tenant);
    if (executions.length === 0) {
      return { subjectId, outcome: "unknown", erased: [], pending: [] };
    }
    const shredParked = options.parked === "shred";
    if (shredParked && this.options.cancel === undefined) {
      throw new TypeError(
        'eraseSubject({ parked: "shred" }) cancels each parked owner before shredding: pass `cancel` to the EraseCoordinator (defineConfig wires it)'
      );
    }
    const proof = this.proofFor(options.force);
    let nonTerminal = await this.liveExecutions(executions, proof);
    // `defer`: every non-terminal execution blocks. `shred`: only a RUNNING one does.
    let live = shredParked
      ? nonTerminal.filter((x) => x.status !== "suspended").map((x) => x.id)
      : nonTerminal.map((x) => x.id);
    let parkedOwners: string[] = [];
    if (shredParked && live.length === 0 && nonTerminal.length > 0) {
      // No owner may be left stuck: cancel every parked one FIRST (the log is still readable and
      // the fence is the runtime's own). A failure, or an owner that is not terminal afterwards,
      // defers the subject.
      parkedOwners = nonTerminal.map((x) => x.id);
      try {
        for (const id of parkedOwners) await this.options.cancel!(id, "erased");
      } catch {
        // fall through to the recheck: whatever did not become terminal blocks the shred
      }
      nonTerminal = await this.liveExecutions(executions, proof);
      live = nonTerminal.map((x) => x.id);
    }
    if (live.length === 0) {
      // Resolved BEFORE the key is destroyed: a decrypting store cannot read these logs afterwards.
      const chains = await this.finishedChains(executions, proof);
      // ADR 0138 / 0139: a plaintext archive that cannot delete would outlive the erasure - refuse BEFORE
      // the key is destroyed.
      await this.assertArchivesErasable(subjectId, tenant, executions, chains);
      if (options.force !== undefined) {
        await this.options.shred(subjectId, executions, { force: options.force });
      } else {
        await this.options.shred(subjectId, executions);
      }
      await this.options.eraseSender?.(subjectId, tenant);
      await this.purgeInboxStreams(chains);
      const archived = await this.deleteArchivedCopies(subjectId, tenant, executions, chains);
      const redactions = await this.redactSenderCopies(subjectId, tenant);
      this.parked.delete(parkKey(tenant, subjectId));
      return {
        subjectId,
        outcome: "erased",
        erased: executions,
        pending: [],
        ...(archived !== undefined && { archivedCopiesDeleted: archived }),
        ...(redactions.length > 0 && { senderRedactions: redactions }),
        ...(shredParked && { parkedShredded: parkedOwners }),
      };
    }
    // R4.5 — a live fold is in flight; record the request durably and defer.
    if (!this.parked.has(parkKey(tenant, subjectId))) {
      this.parked.add(parkKey(tenant, subjectId));
      await this.appendPending(subjectId, tenant);
    }
    return { subjectId, outcome: "parked", erased: [], pending: live };
  }

  /** Complete a parked erasure when the subject's last live execution terminates. */
  async handleEvent(event: EventEnvelope): Promise<void> {
    if (!TERMINAL_EVENTS.has(event.eventType) || this.parked.size === 0) return;
    const subjectId = this.options.index.subjectOfExecution(event.executionId);
    if (subjectId === undefined) return;
    const tenant = this.options.index.tenantOfExecution(event.executionId) ?? DEFAULT_TENANT;
    if (!this.parked.has(parkKey(tenant, subjectId))) return;
    const executions = this.options.index.executionsOf(subjectId, tenant);
    if ((await this.liveExecutions(executions, this.options.destroyed)).length > 0) return; // still blocked
    const chains = await this.finishedChains(executions, this.options.destroyed);
    await this.assertArchivesErasable(subjectId, tenant, executions, chains);
    await this.options.shred(subjectId, executions);
    await this.options.eraseSender?.(subjectId, tenant);
    await this.purgeInboxStreams(chains);
    await this.deleteArchivedCopies(subjectId, tenant, executions, chains);
    await this.redactSenderCopies(subjectId, tenant);
    this.parked.delete(parkKey(tenant, subjectId));
  }

  /**
   * ADR 0139 D12 - a PLAINTEXT archive holds other chains' reserved segments naming the erased subject as
   * the sender. Each is rewritten with the identity replaced by an erased marker (the segment digest masks
   * the sender, so it still verifies; the segment's sender digest is recomputed in the same swap) through
   * ONE atomic `ArchiveStore.replaceSegments` per key (ADR 0139 N1: a trim on another node that appends a
   * segment after this read makes the swap fail, and the key is re-read and retried - never lost, never
   * restored over). The INTENT (the keys) is journaled first (`ERASURE_SENDER_REDACTION_INTENDED`) and the
   * completion after (`ERASURE_SENDER_REDACTED`), so a crash between the two is finished by the retry from
   * the intent and a redaction is never unrecorded. Cost: ONE pass over the archive's reserved keys per
   * erasure (a `listExecutions` prefix walk and a `read` of each key; not indexed - an erasure is rare).
   * A live, not yet archived envelope keeps its sender until it is trimmed (a plaintext store has no key to
   * shred; the sender is sealed by default in a sealing deployment, ADR 0139 N6).
   */
  private async redactSenderCopies(subjectId: string, tenant: string): Promise<SenderRedaction[]> {
    const ref = randomBytes(8).toString("hex"); // one stable non-identifying reference per erased sender
    await this.recoverRedactions(); // (a stage an earlier build left; a no-op on a clean archive)
    const open = await this.openIntent(
      SENDER_REDACTION_INTENDED,
      SENDER_REDACTED,
      subjectId,
      tenant
    );
    // 1. PLAN: one pass over the reserved keys, reading each once.
    const plan: Array<{
      archive: ErasableArchive & Required<Pick<ErasableArchive, "replaceSegments">>;
      key: string;
      segments: ArchiveSegment[];
      changed: number;
    }> = [];
    for (const archive of this.plaintextArchives()) {
      if (archive.replaceSegments === undefined) continue; // refused before the shred if it held a copy
      for (const key of await this.reservedArchiveKeys(archive)) {
        const segments = await archive.read(key);
        const changed = this.redactedSegments(segments, subjectId, tenant, ref).changed;
        if (changed > 0) {
          plan.push({
            archive: archive as (typeof plan)[number]["archive"],
            key,
            segments,
            changed,
          });
        }
      }
    }
    const intended = (open?.payload as { redactions?: SenderRedaction[] } | undefined)?.redactions;
    if (plan.length === 0 && open === undefined) return [];
    // 2. INTENT first (what is about to be rewritten), unless an interrupted attempt already journaled it.
    const intentId =
      open?.id ??
      (await this.appendIntent(SENDER_REDACTION_INTENDED, subjectId, tenant, {
        redactions: plan.map((p) => ({ streamId: p.key, envelopes: p.changed })),
      }));
    // 3. APPLY: one atomic swap per key; a concurrent append makes it conflict, and the key is re-read.
    const done = new Map<string, number>();
    for (const item of plan) {
      let segments = item.segments;
      for (let attempt = 0; ; attempt++) {
        const next = this.redactedSegments(segments, subjectId, tenant, ref);
        if (next.changed === 0) break; // another writer redacted it already
        try {
          await item.archive.replaceSegments(item.key, segments.map(headerOf), next.segments);
          done.set(item.key, next.changed);
          this.options.onArchiveKeyChanged?.(item.key);
          break;
        } catch (err) {
          if (!(err instanceof ArchiveConflictError) || attempt + 1 >= REDACT_RETRIES) throw err;
          segments = await item.archive.read(item.key);
        }
      }
    }
    // 4. COMPLETION: the planned redactions, plus any key this pass found beyond the intent.
    const all = new Map<string, number>();
    for (const r of intended ?? []) all.set(r.streamId, r.envelopes);
    for (const p of plan)
      all.set(p.key, Math.max(all.get(p.key) ?? 0, done.get(p.key) ?? p.changed));
    const redactions = [...all].map(([streamId, envelopes]) => ({ streamId, envelopes }));
    await this.appendCompletion(SENDER_REDACTED, subjectId, tenant, intentId, { redactions });
    return redactions;
  }

  /** `segments` with the matching senders replaced by the erased marker, and the sender digest recomputed. */
  private redactedSegments(
    segments: readonly ArchiveSegment[],
    subjectId: string,
    tenant: string,
    ref: string
  ): { segments: ArchiveSegment[]; changed: number } {
    const matches = this.options.senderMatches ?? defaultSenderMatches;
    let changed = 0;
    const out = segments.map((seg) => {
      let here = 0;
      const envelopes = seg.envelopes.map((e) => {
        const sender = (e.payload as { sender?: unknown } | null)?.sender;
        if (
          e.eventType !== "INBOX_MESSAGE" ||
          typeof sender !== "object" ||
          sender === null ||
          !matches(subjectId, tenant, sender as never)
        ) {
          return e;
        }
        here++;
        return {
          ...e,
          payload: { ...(e.payload as object), sender: senderErasedMarker(ref) },
        };
      });
      if (here === 0) return seg;
      changed += here;
      return { ...seg, envelopes, senderDigest: senderDigestOf(envelopes) };
    });
    return { segments: out, changed };
  }

  /** Every reserved key (inbox, quarantine, late run) the archive holds, by prefix walk. */
  private async reservedArchiveKeys(archive: ErasableArchive): Promise<string[]> {
    const keys: string[] = [];
    for (const prefix of ["__loom_inbox__:", "__loom_quarantine__:", "__loom_late__:"]) {
      let cursor: string | undefined = prefix.slice(0, -1);
      for (;;) {
        const page = await archive.listExecutions({ cursor, limit: 200 });
        let past = false;
        for (const key of page.executionIds) {
          if (!key.startsWith(prefix)) {
            if (key < prefix) continue;
            past = true;
            break;
          }
          keys.push(key);
        }
        if (past || page.nextCursor === undefined || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      }
    }
    return keys;
  }

  /**
   * Restore what an EARLIER build's staged rewrite left behind (a `__loom_redact__:<key>` whose original
   * is gone is copied back; a stage whose original is whole is dropped). The current rewrite is one atomic
   * `replaceSegments` and leaves no stage, so this is a no-op on a clean archive. Run at boot (`loadParked`)
   * and exposed as an operator verb (`app.recoverArchiveRedactions`). Returns the keys restored.
   */
  async recoverRedactions(): Promise<string[]> {
    const restored: string[] = [];
    for (const archive of this.plaintextArchives()) {
      const del = archive.deleteExecution?.bind(archive);
      if (del === undefined) continue;
      let cursor: string | undefined = REDACT_STAGE.slice(0, -1);
      for (;;) {
        const page = await archive.listExecutions({ cursor, limit: 200 });
        let past = false;
        for (const stage of page.executionIds) {
          if (!stage.startsWith(REDACT_STAGE)) {
            if (stage < REDACT_STAGE) continue;
            past = true;
            break;
          }
          const key = stage.slice(REDACT_STAGE.length);
          if ((await archive.headers(key)).length === 0) {
            for (const seg of await archive.read(stage)) await archive.append(key, seg);
            restored.push(key);
            this.options.onArchiveKeyChanged?.(key);
          }
          await del(stage);
        }
        if (past || page.nextCursor === undefined || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      }
    }
    return restored;
  }

  /**
   * The open intent of `intentType` for the subject: journaled and not yet completed by a `completionType`
   * event naming it (`intentId`). The latest one, or `undefined`.
   */
  private async openIntent(
    intentType: string,
    completionType: string,
    subjectId: string,
    tenant: string
  ): Promise<EventEnvelope | undefined> {
    const events = await this.options.eventStore.read(ERASURE_STREAM);
    const done = new Set<string>();
    for (const e of events) {
      if (e.eventType === completionType) {
        const id = (e.payload as { intentId?: unknown } | null)?.intentId;
        if (typeof id === "string") done.add(id);
      }
    }
    let found: EventEnvelope | undefined;
    for (const e of events) {
      if (e.eventType !== intentType || done.has(e.id)) continue;
      const p = e.payload as { subjectId?: string; tenant?: string };
      if (p.subjectId === subjectId && (p.tenant ?? DEFAULT_TENANT) === tenant) found = e;
    }
    return found;
  }

  private async appendIntent(
    type: string,
    subjectId: string,
    tenant: string,
    body: object
  ): Promise<string> {
    return this.appendControl(type, {
      subjectId,
      ...(tenant !== DEFAULT_TENANT && { tenant }),
      ...body,
    });
  }

  private async appendCompletion(
    type: string,
    subjectId: string,
    tenant: string,
    intentId: string | undefined,
    body: object
  ): Promise<void> {
    await this.appendControl(type, {
      subjectId,
      ...(tenant !== DEFAULT_TENANT && { tenant }),
      ...(intentId !== undefined && { intentId }),
      ...body,
    });
  }

  private async appendControl(type: string, payload: object): Promise<string> {
    const prior = await this.options.eventStore.read(ERASURE_STREAM);
    const id = `erasure-${prior.length}`;
    await this.options.eventStore.append({
      id,
      workflowId: ERASURE_STREAM,
      executionId: ERASURE_STREAM,
      eventType: type,
      sequence: prior.length,
      timestamp: 0,
      payload,
    });
    return id;
  }

  /** The plaintext archives (`sealsSegments` is not `true`); a sealing one is erased by the shred. */
  private plaintextArchives(): ErasableArchive[] {
    return (this.options.archives ?? []).filter((a) => a.sealsSegments !== true);
  }

  /** Every archive key holding the subject's copies: its executions' compaction segments and its chains' reserved segments. */
  private async archivedKeys(
    archive: ErasableArchive,
    executions: readonly string[],
    chains: readonly FinishedChain[]
  ): Promise<{ executions: string[]; reservedStreams: string[] }> {
    const held: string[] = [];
    for (const id of executions) {
      if ((await archive.headers(id)).length > 0) held.push(id);
    }
    const reserved: string[] = [];
    for (const { chainId } of chains) {
      reserved.push(...(await archivedReservedStreams(archive, chainId)));
    }
    return { executions: held, reservedStreams: reserved };
  }

  private async assertArchivesErasable(
    subjectId: string,
    tenant: string,
    executions: readonly string[],
    chains: readonly FinishedChain[]
  ): Promise<void> {
    for (const archive of this.plaintextArchives()) {
      if (archive.deleteExecution === undefined) {
        const keys = await this.archivedKeys(archive, executions, chains);
        const all = [...keys.executions, ...keys.reservedStreams];
        if (all.length > 0) throw new ArchivedCopiesRemainError(all);
      }
      // ADR 0139 N5: an archive that cannot swap a segment atomically cannot redact the subject's identity
      // out of OTHER chains' archived envelopes. Refuse BEFORE the shred when it holds any (the scan is the
      // price of finding out; an archive that can redact is scanned once, after the shred).
      if (archive.replaceSegments === undefined) {
        const held: string[] = [];
        for (const key of await this.reservedArchiveKeys(archive)) {
          const segments = await archive.read(key);
          if (this.redactedSegments(segments, subjectId, tenant, "").changed > 0) held.push(key);
        }
        if (held.length > 0) throw new SenderRedactionUnsupportedError(held);
      }
    }
  }

  /**
   * ADR 0138 / 0139 - the physical half of erasure for the ARCHIVES: delete the subject's compaction
   * segments and its chains' reserved-stream segments from every plaintext archive. ADR 0139 N4: the
   * INTENT (the keys) is journaled BEFORE anything is deleted (`ERASURE_ARCHIVE_DELETE_INTENDED`) and the
   * completion after (`ERASURE_ARCHIVE_DELETED`, naming the intent), so a crash between the delete and the
   * record is finished by the retry from the intent: a deletion is never unrecorded. Idempotent: a retry
   * with nothing left and no open intent records nothing. Over a sealing archive the shred has already made
   * the segments unreadable, so nothing is deleted.
   */
  private async deleteArchivedCopies(
    subjectId: string,
    tenant: string,
    executions: readonly string[],
    chains: readonly FinishedChain[]
  ): Promise<ArchivedCopiesDeleted | undefined> {
    const deleted: ArchivedCopiesDeleted = { executions: [], reservedStreams: [] };
    // 1. Finish an interrupted attempt from its journaled intent.
    const open = await this.openIntent(ARCHIVE_DELETE_INTENDED, ARCHIVE_DELETED, subjectId, tenant);
    const pending = new Set<string>();
    if (open !== undefined) {
      const p = open.payload as Partial<ArchivedCopiesDeleted>;
      for (const id of p.executions ?? []) deleted.executions.push(id);
      for (const id of p.reservedStreams ?? []) deleted.reservedStreams.push(id);
      for (const id of [...deleted.executions, ...deleted.reservedStreams]) pending.add(id);
    }
    // 2. What is held now.
    const fresh: ArchivedCopiesDeleted = { executions: [], reservedStreams: [] };
    for (const archive of this.plaintextArchives()) {
      if (archive.deleteExecution === undefined) continue; // asserted before the shred
      const keys = await this.archivedKeys(archive, executions, chains);
      for (const id of keys.executions) if (!pending.has(id)) fresh.executions.push(id);
      for (const id of keys.reservedStreams) if (!pending.has(id)) fresh.reservedStreams.push(id);
    }
    if (open === undefined && fresh.executions.length === 0 && fresh.reservedStreams.length === 0) {
      return undefined;
    }
    deleted.executions.push(...fresh.executions);
    deleted.reservedStreams.push(...fresh.reservedStreams);
    // 3. INTENT first (only when this pass found something new), then delete, then the completion.
    const intentId =
      open?.id ??
      (await this.appendIntent(ARCHIVE_DELETE_INTENDED, subjectId, tenant, {
        executions: deleted.executions,
        reservedStreams: deleted.reservedStreams,
      }));
    for (const archive of this.plaintextArchives()) {
      const del = archive.deleteExecution?.bind(archive);
      if (del === undefined) continue;
      for (const id of [...deleted.executions, ...deleted.reservedStreams]) {
        await del(id); // idempotent: an absent key is a no-op
        this.options.onArchiveKeyChanged?.(id);
      }
    }
    await this.appendCompletion(ARCHIVE_DELETED, subjectId, tenant, intentId, { ...deleted });
    return deleted;
  }

  /**
   * ADR 0110 follow-up — erasure reaches payloads still in flight in a RESERVED inbox stream.
   *
   * A chain's inbox (`__loom_inbox__:<chainId>`, and with per-topic streams `…#<hash>` and `…#reg`) holds undelivered messages for its owner. The
   * runtime deletes it when the chain's head turns terminal, but a crash between a sender's append
   * and its re-read can leave an orphan, and until it is reclaimed it holds the subject's data.
   * Once the subject is erased (every execution of it terminal, so nothing can consume) the stream
   * of each execution that is the HEAD of its chain (terminal and not `continued`: a continued
   * execution's successor owns the stream) is deleted. Idempotent, and a no-op for a store that
   * cannot delete or an execution whose stream is already gone.
   *
   * This is the physical half. The cryptographic half is the key: the crypto plugin seals inbox
   * payloads under the OWNER's subject, so `shred` makes a payload unreadable even where a stream
   * cannot be deleted (a consumer then receives the `{ $shredded: true }` marker, never the raw
   * value).
   */
  private async purgeInboxStreams(chains: readonly FinishedChain[]): Promise<void> {
    const remove = this.options.eventStore.deleteExecution?.bind(this.options.eventStore);
    if (remove === undefined) return;
    for (const {
      streams: { legacy, registry, topics, quarantine },
    } of chains) {
      // ADR 0110 D10b — EVERY stream of the chain: its per-topic streams, the legacy one and, last,
      // the registry that names the topic streams (a crash midway leaves them findable).
      for (const stream of topics) await remove(stream);
      await remove(legacy);
      // ADR 0130 residuals D9: the chain's quarantine copies are in-flight payloads too.
      await remove(quarantine);
      if (registry !== undefined) await remove(registry);
    }
  }

  /**
   * The inbox streams of the chains whose HEAD is among `executions`: terminal and not `continued`
   * (a continued execution's successor owns the chain's inbox and is judged on its own events).
   * Folded, and each chain's registry read, while the logs are still readable, so a decrypting store
   * has not yet lost its key.
   */
  private async finishedChains(
    executions: readonly string[],
    proof: DestructionProof | undefined
  ): Promise<FinishedChain[]> {
    // (a store that cannot delete streams still has chains whose ARCHIVED segments erasure removes)
    const chains = new Set<string>();
    for (const executionId of executions) {
      const folded = await this.foldExecution(executionId, proof);
      if (folded === undefined) continue;
      if (!TERMINAL_STATUS.has(folded.status) || folded.status === "continued") continue;
      if (folded.head === false) continue; // terminal, but not PROVEN a chain head: keep its streams
      chains.add(chainIdOfFirst(folded.first, executionId));
    }
    const streams: FinishedChain[] = [];
    const store = this.options.eventStore;
    const view = {
      read: (id: string) => this.readErasedOk(id, proof),
      // The registry may miss a topic stream (a sender that died before it registered): the prefix
      // scan is the backstop, so erasure reaches an unregistered stream too.
      ...(store.listExecutionsPage !== undefined && {
        listExecutionsPage: store.listExecutionsPage.bind(store),
      }),
    };
    for (const chainId of chains) {
      streams.push({ chainId, streams: await inboxStreamsOfChainDeep(view, chainId) });
    }
    return streams;
  }

  /** The window proof for one call: the operator's per-call `force` asserts it, else the configured proof. */
  private proofFor(force: "key-destroyed-elsewhere" | undefined): DestructionProof | undefined {
    return force === "key-destroyed-elsewhere" ? () => true : this.options.destroyed;
  }

  /** Subjects with a deferred erasure still awaiting completion (sorted, deduped across tenants). */
  pendingSubjects(): string[] {
    return [...new Set([...this.parked].map(subjectOfKey))].sort();
  }

  /** The subset of `executions` that are not yet terminal (a live fold reading the key), with status. */
  private async liveExecutions(
    executions: readonly string[],
    proof: DestructionProof | undefined
  ): Promise<Array<{ id: string; status: ExecutionState["status"] }>> {
    const live: Array<{ id: string; status: ExecutionState["status"] }> = [];
    for (const executionId of executions) {
      const folded = await this.foldExecution(executionId, proof);
      if (folded === undefined) continue; // deleted by retention — nothing to protect
      if (!TERMINAL_STATUS.has(folded.status))
        live.push({ id: executionId, status: folded.status });
    }
    return live;
  }

  /**
   * The log, or — when its subject is ALREADY shredded (a direct `shredSubject`, a retry, or the
   * window between the key's destruction and its tombstone) — the redacted view the typed error
   * carries: status and tip are plaintext, so liveness and the
   * chain's head can still be judged, and a re-run of the erasure stays idempotent.
   */
  private async readErasedOk(
    executionId: string,
    proof: DestructionProof | undefined
  ): Promise<EventEnvelope[]> {
    try {
      return await this.options.eventStore.read(executionId);
    } catch (err) {
      const redacted = (err as { name?: unknown; redacted?: EventEnvelope[] } | null)?.redacted;
      if (isPayloadShredded(err) && redacted) {
        return redacted;
      }
      // The ShredIncomplete window (ADR 0130 D7): the key is destroyed but the tombstone append
      // failed, so no PAYLOAD_SHREDDED exists yet and the read is `KeyUnavailableError`. Its
      // redacted view (plaintext status and tip) lets the retry judge liveness and complete, but
      // ONLY when the log records this subject's durable erase intent: without it the node merely
      // lacks the key (wrong key, partitioned key store) and the error is rethrown.
      const window = await erasureWindowView(err, proof);
      if (window !== undefined) return [...window];
      throw err;
    }
  }

  /**
   * The latest checkpoint, or — in the destroy window — its at-rest form. A sealing snapshot store
   * throws `KeyUnavailableError` for a sealed checkpoint whose key is destroyed while no
   * `PAYLOAD_SHREDDED` exists yet (the crash between `keys.destroy` and the tombstones), and
   * `PayloadShreddedError` once a shred is recorded. Both are handled exactly like the event read
   * (`readErasedOk`) and `shredSubject` (`loadLatestSealed`): the proven shred reads sealed, the
   * unavailable key only when the log holds this subject's erase intent AND `proof` shows the key
   * store destroyed it. Anything else (a key merely missing, no intent) is rethrown: real key loss
   * is never masked. `opaque` is set when the sealed state carries no plaintext status.
   */
  private async readSnapshotErasedOk(
    executionId: string,
    events: readonly EventEnvelope[],
    proof: DestructionProof | undefined
  ): Promise<{
    snapshot: { executionId?: string; sequence: number; state: ExecutionState } | null;
    opaque: boolean;
    subjectId?: string;
  }> {
    const store = this.options.snapshotStore;
    if (store === undefined) return { snapshot: null, opaque: false };
    try {
      return { snapshot: await store.loadLatest(executionId), opaque: false };
    } catch (err) {
      const sealedRead = store.loadLatestSealed?.bind(store);
      const inWindow = isPayloadShredded(err) || (await isErasureWindow(err, events, proof));
      if (!inWindow || sealedRead === undefined) throw err;
      const snapshot = await sealedRead(executionId);
      const opaque =
        typeof (snapshot?.state as { status?: unknown } | undefined)?.status !== "string";
      return { snapshot, opaque, ...(isKeyUnavailable(err) && { subjectId: err.subjectId }) };
    }
  }

  /** One execution's folded status and its first event, or `undefined` when its log is gone. */
  private async foldExecution(
    executionId: string,
    proof: DestructionProof | undefined
  ): Promise<
    { status: ExecutionState["status"]; first: EventEnvelope; head?: boolean } | undefined
  > {
    const events = await this.readErasedOk(executionId, proof);
    const first = events[0];
    if (first === undefined) return undefined;
    const read = await this.readSnapshotErasedOk(executionId, events, proof);
    const snapshot = read.snapshot;
    // Fill a blank legacy identity; a NON-blank one naming another execution is a store or
    // tenant-scoping defect, refused as everywhere else a fold is seeded (ADR 0106).
    if (snapshot !== null) {
      // The row's index columns are plaintext even when its state is sealed: always refuse a
      // checkpoint of another execution (a store or tenant-scoping defect, ADR 0106).
      if (snapshot.executionId !== undefined && snapshot.executionId !== executionId) {
        throw new TypeError(
          `snapshot store returned a checkpoint of "${snapshot.executionId}" for "${executionId}"`
        );
      }
      if (!read.opaque) assertSnapshotIdentity(snapshot.state, executionId, first.workflowId ?? "");
    }
    if (read.opaque && snapshot !== null) {
      // A whole-state sealed checkpoint whose key is gone: its status is unreadable.
      // (1) The log is not compacted: gap-free from 0 AND reaching the checkpoint (compaction
      // keeps only sequence 0 of the prefix). Then ignore the checkpoint and fold the WHOLE log by
      // its plaintext event types, the no-snapshot path: continued, suspended and a re-open after
      // the intent all read as they are.
      const last0 = events[events.length - 1];
      if (
        events.every((e, i) => e.sequence === i) &&
        last0 !== undefined &&
        last0.sequence >= snapshot.sequence
      ) {
        return { status: foldEvents(events, { executionId }).status, first };
      }
      // (2) Compacted: only the tail above the checkpoint is left. Judge it by the rule
      // `shredSubject` uses (`isQuiescent`). A chain HEAD is claimed only when the tail itself shows
      // a non-`continued` terminal kind; anything less keeps the inbox streams (the key's
      // destruction already makes their payloads unreadable).
      const tail = events.filter((e) => e.sequence > snapshot.sequence);
      // The intent is looked for under THIS subject (the one whose key is gone), as shredSubject does.
      const quiescent = isQuiescent(tail, undefined, recordsErasureIntent(events, read.subjectId));
      const last = [...tail].reverse().find((e) => isAnsweringKind(e));
      const status = !quiescent
        ? foldEvents(tail, { executionId }).status
        : last?.eventType === "EXECUTION_SUSPENDED"
          ? "suspended"
          : last === undefined
            ? "completed" // quiescent on the intent alone: terminal for liveness, head unproven
            : (TERMINAL_STATUS_OF_EVENT.get(last.eventType) ?? "completed");
      const head = last !== undefined && status !== "continued" && TERMINAL_STATUS.has(status);
      return { status, first, head };
    }
    const state =
      snapshot !== null
        ? foldEvents(
            events.filter((e) => e.sequence > snapshot.sequence),
            // A pre-ADR-0106 checkpoint may carry a blank identity: fill it, as the kernel does.
            // A pre-1.21.0 snapshot may read `failed` for a caught step failure: repair it
            // (ADR 0105), or a live execution would read terminal and be shredded.
            {
              ...normalizeSnapshotState(snapshot.state),
              executionId: snapshot.state.executionId || executionId,
              workflowId: snapshot.state.workflowId || (first.workflowId ?? ""),
            }
          )
        : foldEvents(events, { executionId });
    return { status: state.status, first };
  }

  // `prior.length` is the next sequence only because a reserved stream is never compacted:
  // `LogLifecycle.compact` refuses one (ADR 0106).
  private async appendPending(subjectId: string, tenant: string): Promise<void> {
    const prior = await this.options.eventStore.read(ERASURE_STREAM);
    await this.options.eventStore.append({
      id: `erasure-${prior.length}`,
      workflowId: ERASURE_STREAM,
      executionId: ERASURE_STREAM,
      eventType: "ERASURE_PENDING",
      sequence: prior.length,
      timestamp: 0, // deterministic; the fact of the request is what matters
      payload: { subjectId, ...(tenant !== DEFAULT_TENANT && { tenant }) },
    });
  }
}

/** A chain whose head the subject owned, with the live streams of its inbox. */
interface FinishedChain {
  chainId: string;
  streams: InboxStreams;
}

// `tenant\x00subject` — NUL separates the two id spaces (never appears in a real id), so a
// tenant/subject boundary can't be spoofed by crafting an id that contains the separator.
function parkKey(tenant: string, subject: string): string {
  return `${tenant}\x00${subject}`;
}
function subjectOfKey(key: string): string {
  return key.slice(key.indexOf("\x00") + 1);
}
