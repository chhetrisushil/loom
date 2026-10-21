import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  type DestructionProof,
  type EventStore,
  type InboxStreams,
  chainIdOfFirst,
  erasureWindowView,
  inboxStreamsOfChainDeep,
  isAnsweringKind,
  isErasureWindow,
  isPayloadShredded,
  isQuiescent,
  recordsErasureIntent,
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
    for (const event of await this.options.eventStore.read(ERASURE_STREAM)) {
      if (event.eventType === "ERASURE_PENDING") {
        const p = event.payload as { subjectId: string; tenant?: string };
        this.parked.add(parkKey(p.tenant ?? DEFAULT_TENANT, p.subjectId));
      }
    }
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
      if (options.force !== undefined) {
        await this.options.shred(subjectId, executions, { force: options.force });
      } else {
        await this.options.shred(subjectId, executions);
      }
      await this.purgeInboxStreams(chains);
      this.parked.delete(parkKey(tenant, subjectId));
      return {
        subjectId,
        outcome: "erased",
        erased: executions,
        pending: [],
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
    await this.options.shred(subjectId, executions);
    await this.purgeInboxStreams(chains);
    this.parked.delete(parkKey(tenant, subjectId));
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
  private async purgeInboxStreams(chains: readonly InboxStreams[]): Promise<void> {
    const remove = this.options.eventStore.deleteExecution?.bind(this.options.eventStore);
    if (remove === undefined) return;
    for (const { legacy, registry, topics, quarantine } of chains) {
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
  ): Promise<InboxStreams[]> {
    if (this.options.eventStore.deleteExecution === undefined) return [];
    const chains = new Set<string>();
    for (const executionId of executions) {
      const folded = await this.foldExecution(executionId, proof);
      if (folded === undefined) continue;
      if (!TERMINAL_STATUS.has(folded.status) || folded.status === "continued") continue;
      if (folded.head === false) continue; // terminal, but not PROVEN a chain head: keep its streams
      chains.add(chainIdOfFirst(folded.first, executionId));
    }
    const streams: InboxStreams[] = [];
    const store = this.options.eventStore;
    const view = {
      read: (id: string) => this.readErasedOk(id, proof),
      // The registry may miss a topic stream (a sender that died before it registered): the prefix
      // scan is the backstop, so erasure reaches an unregistered stream too.
      ...(store.listExecutionsPage !== undefined && {
        listExecutionsPage: store.listExecutionsPage.bind(store),
      }),
    };
    for (const chain of chains) streams.push(await inboxStreamsOfChainDeep(view, chain));
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
      return { snapshot, opaque };
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
      // (1) The log is not compacted (gap-free from 0; compaction keeps
      // only sequence 0 of the prefix): ignore the checkpoint and fold the WHOLE log by its plaintext event types, the no-snapshot path. Exact: continued, suspended and a re-open
      // after the intent all read as they are.
      if (events.every((e, i) => e.sequence === i)) {
        return { status: foldEvents(events, { executionId }).status, first };
      }
      // (2) Compacted: only the tail above the checkpoint is left. Judge it by the rule
      // `shredSubject` uses (`isQuiescent`). A chain HEAD is claimed only when the tail itself shows
      // a non-`continued` terminal kind; anything less keeps the inbox streams (the key's
      // destruction already makes their payloads unreadable).
      const tail = events.filter((e) => e.sequence > snapshot.sequence);
      const quiescent = isQuiescent(tail, undefined, recordsErasureIntent(events));
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

// `tenant\x00subject` — NUL separates the two id spaces (never appears in a real id), so a
// tenant/subject boundary can't be spoofed by crafting an id that contains the separator.
function parkKey(tenant: string, subject: string): string {
  return `${tenant}\x00${subject}`;
}
function subjectOfKey(key: string): string {
  return key.slice(key.indexOf("\x00") + 1);
}
