import type { EventEnvelope, ExecutionState } from "@loom/core";
import {
  type BranchRegistry,
  type EventStore,
  StaleFenceError,
  headOf,
  isReservedStream,
  readRangeOf,
} from "@loom/event-runtime";
import { appendBatchOf } from "@loom/event-runtime";
import { ReplayVM, knownEventTypes, normalizeSnapshotState } from "@loom/replay-vm";
import { type Snapshot, type SnapshotStore, assertSnapshotIdentity } from "@loom/snapshot-runtime";
import { ulid } from "ulid";
import {
  type BlankStreamCensus,
  type BlankStreamSegment,
  type RehomeAssignment,
  planBlankStreamRepair,
  rehomedEnvelope,
} from "./blankStream";
import { chainIdOf, inboxStreamId } from "./inbox";
import { EFFECT_INDOUBT_RESOLVED, EXECUTION_RECOVERED } from "./types";
import { isWriteConflict } from "./writeConflict";

/** Reserved control stream carrying retention facts (EXECUTION_ARCHIVED/_DELETED). */
export const LIFECYCLE_STREAM = "__loom_lifecycle__";

// ── K10.1 / K10.4 — log lifecycle: retention & compaction ─────────────────────
//
// A kernel reclaims resources. Retention removes terminal executions after their
// window elapses; compaction bounds a long-lived execution's replay tail. Both
// preserve the fold: retention only removes ELIGIBLE (terminal, aged, archived)
// executions, and compaction guarantees `fold(snapshot, suffix) === fold(events)`
// so a compacted execution still resumes/replays identically.

/**
 * ADR 0116 — when an execution ended: the timestamp of its newest terminal event, found by
 * scanning the tail backwards (a late outcome sits after it). Falls back to the old formula
 * `max(last event, folded updatedAt)` only when no terminal event survives (compaction removed it).
 * Residual, recorded in the ADR: `OUTCOME_RECORDED`'s frozen handler moves `updatedAt`, so in that
 * fallback a late outcome does count; compaction keeps the tip, so it needs a compaction run AFTER
 * the terminal event AND a late outcome after that.
 */
function terminalEndedAt(events: readonly EventEnvelope[], state: ExecutionState): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventEnvelope;
    if (
      e.eventType === "EXECUTION_COMPLETED" ||
      e.eventType === "EXECUTION_FAILED" ||
      e.eventType === "EXECUTION_CANCELLED" ||
      (e.eventType === "EXECUTION_CONTINUED" && e.metadata?.kernel === true)
    ) {
      return e.timestamp;
    }
  }
  return Math.max(events[events.length - 1]!.timestamp, state.updatedAt);
}

const TERMINAL = new Set<ExecutionState["status"]>([
  "completed",
  "failed",
  "cancelled",
  "continued", // ADR 0109: terminal for retention; the successor's sequence 0 is durable first
]);

export interface RetentionPolicy {
  /** Keep a terminal execution this long after its last event, then reclaim it. */
  terminalTtlMs: number;
}

/**
 * Envelopes per archive round-trip. Bounded so a long execution cannot turn a
 * bounded-memory sweep into an unbounded one; large enough that the round-trip saving is
 * the dominant effect.
 */
const ARCHIVE_CHUNK = 256;

/** Where an execution is copied before deletion (A6 — archive-before-delete). */
export interface ArchiveStores {
  eventStore: EventStore;
  snapshotStore?: SnapshotStore;
}

/**
 * K10.6 (ADR 0055) — the pin seam: retention consults this predicate before
 * reclaiming an execution; `true` exempts it. The kernel checks the predicate;
 * WHAT pins is app/plugin policy (G3) — e.g. "executions whose log carries
 * finding events" via `@loom/plugin-content`'s `pinByEventKinds`. Content-blob
 * pinning is the companion seam (`sweepUnpinnedContent`), keyed by ref so pins
 * survive archival.
 */
export type PinPredicate = (executionId: string) => boolean | Promise<boolean>;

export type RetentionOutcome =
  | "reclaimed" // archived (if configured) then deleted
  | "kept" // terminal but still within its TTL
  | "not-terminal" // still running/suspended — never reclaimed
  | "blocked-by-branch" // a live descendant branch still depends on this prefix (R5.3)
  | "pinned" // exempted by the pin predicate (K10.6)
  | "unknown" // no events for this id
  | "unsupported" // the store can't delete (no deleteExecution)
  // the log is encrypted and the archive does not share its KeyStore: archiving would copy
  // decrypted rows out of the erasure boundary (ADR 0022 Amendment) — nothing is touched
  | "unsafe-archive";

/**
 * Thrown by {@link LogLifecycle.compact} when the event store encrypts at rest and the
 * snapshot store does not share its `KeyStore` (ADR 0022 Amendment).
 *
 * Compaction saves the DECRYPTED fold as a snapshot and then truncates the ciphertext it came
 * from. Into a plaintext snapshot store — or one encrypting under different keys — that turns
 * shreddable ciphertext into data a key shred no longer erases: the A1 "erasure theater" hole.
 * A throw, not a `null`: `null` already means "nothing to compact", and a guard that answers
 * like a no-op is one nobody notices firing.
 */
export class UnsafeCompactionError extends Error {
  constructor(readonly executionId: string) {
    super(
      `refusing to compact "${executionId}": the event store encrypts at rest, but the snapshot store does not share its KeyStore — the checkpoint would hold the decrypted fold outside the erasure boundary, so shredding the subject would no longer erase it. Wrap the snapshot store in an EncryptingSnapshotStore over the SAME KeyStore.`
    );
    this.name = "UnsafeCompactionError";
  }
}

/**
 * The structural encryption marker (`keys`) an encrypting store exposes — the same probe
 * `loom doctor` uses, so this package does not depend on `@loom/plugin-crypto`. Decorators
 * carry it up (`installOptional`), so a store wrapped above the encrypting one still shows it.
 */
function keysOf(store: unknown): object | undefined {
  const keys = (store as { keys?: unknown } | undefined)?.keys;
  return typeof keys === "object" && keys !== null ? keys : undefined;
}

/**
 * Thrown by {@link LogLifecycle.compact} when the log was compacted before and the checkpoint
 * that prefix was folded into is gone (ADR 0106). Folding what survives would checkpoint a
 * state missing the whole compacted prefix, and truncating on top of it would make the loss
 * permanent — so nothing is saved or truncated.
 */
export class CompactionCheckpointMissingError extends Error {
  constructor(
    readonly executionId: string,
    readonly missingThrough: number
  ) {
    super(
      `refusing to compact "${executionId}": its log has no events through sequence ${missingThrough} (an earlier compaction) and no snapshot at or above it holds that prefix — the checkpoint is missing, so the fold of what survives would be wrong.`
    );
    this.name = "CompactionCheckpointMissingError";
  }
}

/**
 * The highest sequence missing BELOW the log's tip, or -1 when the log is contiguous from 0.
 * Compaction is the only thing that removes events; it always removes its own checkpoint's
 * slot and never the tip unless nothing is kept (the TIP RULE, ADR 0106), so this is exactly
 * the latest checkpoint's sequence — or, for a log compacted down to `[0]`, -1 with the
 * checkpoint above the tip. One backward pass; stops at the first gap from the top.
 */
export function highestMissing(events: readonly EventEnvelope[]): number {
  for (let i = events.length - 1; i > 0; i--) {
    const at = events[i]!.sequence;
    if (at - events[i - 1]!.sequence > 1) return at - 1;
  }
  return events.length > 0 && events[0]!.sequence !== 0 ? events[0]!.sequence - 1 : -1;
}

/** Appends of one lifecycle fact before a write conflict is reported rather than retried. */
const LIFECYCLE_FACT_ATTEMPTS = 5;

/** How many executions a {@link LogLifecycle} remembers having warned about. */
const WARNED_MEMORY = 10_000;

/**
 * Every event kind the kernel writes: the fold's own kinds plus the resume signals the
 * runtime records itself (crash re-drive, in-doubt verdict). None may be kept below a
 * checkpoint: kernel log readers assume no kernel fact survives there.
 */
const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...knownEventTypes(),
  EXECUTION_RECOVERED,
  EFFECT_INDOUBT_RESOLVED,
]);

/**
 * ADR 0106 — validate `pinnedEventTypes`: non-empty strings, no kernel kinds. Exported for
 * `defineConfig`, which runs it at config time so a bad list fails at boot, not at the first
 * compaction pass.
 */
export function assertPinnedEventTypes(types: readonly unknown[]): asserts types is string[] {
  const bad = types.filter((t) => typeof t !== "string" || t.length === 0);
  if (bad.length > 0) {
    throw new TypeError(
      `pinnedEventTypes must be non-empty strings; got ${bad.map((t) => JSON.stringify(t) ?? String(t)).join(", ")}. A non-string would match nothing on SQL stores but still be compared in memory, so backends would disagree about what compaction keeps.`
    );
  }
  const kernel = (types as string[]).filter((t) => KERNEL_EVENT_TYPES.has(t));
  if (kernel.length > 0) {
    throw new TypeError(
      `pinnedEventTypes names kernel event kind(s) ${kernel.join(", ")} — compaction keeps app evidence events, not kernel facts (the checkpoint already carries their fold). To keep an execution's whole log uncompacted, leave pinnedEventTypes empty and pin the execution (\`pinned\`): the predicate is consulted only when no kinds are declared.`
    );
  }
}

export class LogLifecycle {
  constructor(
    private readonly eventStore: EventStore,
    private readonly snapshotStore: SnapshotStore,
    private readonly options: {
      archive?: ArchiveStores;
      branchRegistry?: BranchRegistry;
      pinned?: PinPredicate;
      /**
       * ADR 0106 — the app's pinned event KINDS (ADR 0055 D1: the same list it gives
       * `pinByEventKinds` and `sweepUnpinnedContent`). {@link compact} keeps every event of
       * these kinds in place instead of truncating it, so a compacted run still carries its
       * findings. Kernel event kinds are refused: the fold already carries what they record,
       * and kernel log readers assume none survive below a checkpoint.
       */
      pinnedEventTypes?: readonly string[];
      /**
       * ADR 0106 — executions whose WHOLE log must stay uncompacted (a legal hold by tag, an
       * audit freeze): `compact` returns `null` for them, always. Distinct from `pinned`, which
       * governs retention and consults compaction only when no `pinnedEventTypes` are declared.
       */
      compactionExempt?: PinPredicate;
      /**
       * Where compaction reports a degraded pass — today, a store without
       * `truncatePrefixKeeping` that therefore cannot compact past a kept event (ADR 0106 D3).
       * Once per execution per `LogLifecycle` instance. Default: `console.warn`.
       */
      onWarn?: (message: string) => void;
    } = {}
  ) {
    assertPinnedEventTypes(options.pinnedEventTypes ?? []);
    this.keep = new Set(options.pinnedEventTypes);
  }

  /** {@link LogLifecycle} options' `pinnedEventTypes`, as a set. */
  private readonly keep: ReadonlySet<string>;

  /** Executions already warned about (bounded, FIFO) — a sweep warns once per execution. */
  private readonly warned = new Set<string>();

  private warnOnce(executionId: string, message: string): void {
    if (this.warned.has(executionId)) return;
    if (this.warned.size >= WARNED_MEMORY) {
      const oldest = this.warned.values().next().value;
      if (oldest !== undefined) this.warned.delete(oldest);
    }
    this.warned.add(executionId);
    (this.options.onWarn ?? ((m: string) => console.warn(`[loom] ${m}`)))(message);
  }

  /**
   * The archive retention copies into, if one is configured. Read-only. Operator passes that
   * must see every store holding citations (the content sweep's orphan pass, ADR 0055 D6)
   * take it from here, so a `--config` run cannot forget it.
   */
  get archive(): ArchiveStores | undefined {
    return this.options.archive;
  }

  /**
   * R5.3 — a terminal execution MUST NOT be deleted while a live descendant branch still
   * exists (a fork's copied prefix may alias this one, and deleting it would break that
   * branch's replay/lineage). Conservative: block if any direct child still has events.
   */
  private async hasLiveDescendant(executionId: string): Promise<boolean> {
    const registry = this.options.branchRegistry;
    if (registry === undefined) return false;
    for (const child of await registry.children(executionId)) {
      // "Has any events" is a tip query, not a read. This runs per child, per swept
      // execution, against branch logs — which are the long ones, since a branch is forked
      // precisely to do expensive work.
      if ((await headOf(this.eventStore, child.executionId)) !== null) return true;
    }
    return false;
  }

  /**
   * Journal a retention control fact to the dedicated lifecycle stream (P9: audit its own
   * pruning). `read().length` is the next sequence only because a reserved stream is never
   * compacted — {@link compact} refuses one (ADR 0106).
   */
  private async emitLifecycleFact(
    eventType: "EXECUTION_ARCHIVED" | "EXECUTION_DELETED" | "EVENTS_REHOMED",
    executionId: string,
    now: number,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    // Two lifecycle writers (a retention sweep beside a repair, say) can read the same length.
    // The loser's append is a write conflict and nothing was written, so re-read and retry.
    // One imprecision, accepted: a `CoalescingEventStore` over a store without `appendBatch`
    // can hand a caller the conflict of a batch its own fact was part of AND landed in, so the
    // retry may journal that fact twice. A duplicated audit fact is harmless; a lost one is not.
    for (let attempt = 1; ; attempt++) {
      const prior = await this.eventStore.read(LIFECYCLE_STREAM);
      const fact: EventEnvelope = {
        id: ulid(),
        workflowId: LIFECYCLE_STREAM,
        executionId: LIFECYCLE_STREAM,
        eventType,
        sequence: prior.length,
        timestamp: now,
        payload: { executionId, ...detail },
      };
      try {
        await this.eventStore.append(fact);
        return;
      } catch (err) {
        if (attempt >= LIFECYCLE_FACT_ATTEMPTS || !isWriteConflict(err)) throw err;
      }
    }
  }

  /**
   * K10.1 — reclaim one execution if it is terminal AND older than the policy
   * window. Archive-before-delete when an archive is configured (A6 — naive
   * deletion starves the learning plane + deploy-sim corpus): every event is
   * copied to the archive, plus its latest snapshot, and only then is the
   * primary deleted. Replay of an archived execution requires rehydration but
   * remains byte-identical. Returns what happened (idempotent: a second call is
   * `unknown`).
   */
  /**
   * Every gate `applyRetention` applies, with nothing done — `"reclaimable"` means a real run
   * would delete this execution.
   *
   * Exists so a preview cannot drift from the thing it previews. `loom retention run`'s dry
   * run used to re-implement eligibility locally (terminal + aged), which silently omitted the
   * branch and pin gates: it printed `would-reclaim` for executions the library would refuse,
   * and a `--apply` flag whose preview disagrees with its apply is worse than no preview.
   */
  async evaluate(
    executionId: string,
    policy: RetentionPolicy,
    now: number
  ): Promise<RetentionOutcome | "reclaimable"> {
    if (this.eventStore.deleteExecution === undefined) return "unsupported";
    if (!this.archiveIsSafe()) return "unsafe-archive";
    const events = await this.eventStore.read(executionId);
    if (events.length === 0) return "unknown";

    const state = await this.foldForRetention(executionId, events);
    if (!TERMINAL.has(state.status)) return "not-terminal";
    // ADR 0116 — the clock runs from the newest TERMINAL event, not the last event: a late
    // outcome (or an audit row) appended days after the end must not postpone reclamation.
    const endedAt = terminalEndedAt(events, state);
    if (now - endedAt < policy.terminalTtlMs) return "kept";

    // R5.3 — never delete a parent a live descendant branch still depends on.
    if (await this.hasLiveDescendant(executionId)) return "blocked-by-branch";

    // K10.6 — the pin gate, last before anything is copied or destroyed.
    if (this.options.pinned !== undefined && (await this.options.pinned(executionId)) === true) {
      return "pinned";
    }
    return "reclaimable";
  }

  /**
   * Fold what retention judges eligibility on. A contiguous log `[0..n]` with n > 0 IS the
   * whole history: under the tip rule (ADR 0106) compaction always leaves a gap below the tip
   * it keeps, so a gap-free log was never compacted. A gapped log — or only the bootstrap
   * left, which is what compacting through the tip leaves — keeps its prefix in the
   * checkpoint: folding the surviving suffix alone reads a completed execution as
   * not-terminal forever, so a compacted execution could never be reclaimed. One snapshot
   * point-read, only then.
   */
  private async foldForRetention(
    executionId: string,
    events: EventEnvelope[]
  ): Promise<ExecutionState> {
    const last = events[events.length - 1]!;
    if (events.length > 1 && last.sequence === events.length - 1) {
      return new ReplayVM(events).getState();
    }
    const snapshot = await this.snapshotStore.loadLatest(executionId);
    if (snapshot === null) return new ReplayVM(events).getState();
    const suffix = events.filter((e) => e.sequence > snapshot.sequence);
    return new ReplayVM(suffix, normalizeSnapshotState(snapshot.state)).getState();
  }

  /**
   * ADR 0022 Amendment — an archive receives what retention READ through the event store,
   * i.e. plaintext, plus the DECRYPTED latest snapshot. When the source encrypts, each archive
   * store must encrypt under the SAME KeyStore, or archiving moves the subject's data out of
   * reach of a key shred. Structural (identity of `keys`); whether the archive's `sensitive`
   * paths cover the source's cannot be checked this way (ADR 0022, `loom doctor`).
   */
  private archiveIsSafe(): boolean {
    const archive = this.options.archive;
    if (archive === undefined) return true;
    const eventKeys = keysOf(this.eventStore);
    if (eventKeys !== undefined && keysOf(archive.eventStore) !== eventKeys) return false;
    if (archive.snapshotStore !== undefined) {
      const snapshotKeys = keysOf(this.snapshotStore);
      const target = keysOf(archive.snapshotStore);
      if (eventKeys !== undefined && target !== eventKeys) return false;
      if (snapshotKeys !== undefined && target !== snapshotKeys) return false;
    }
    return true;
  }

  async applyRetention(
    executionId: string,
    policy: RetentionPolicy,
    now: number
  ): Promise<RetentionOutcome> {
    const verdict = await this.evaluate(executionId, policy, now);
    if (verdict !== "reclaimable") return verdict;
    // `evaluate` already refused a store that cannot delete; this re-reads it to narrow the
    // type rather than asserting one.
    const deleteExecution = this.eventStore.deleteExecution;
    if (deleteExecution === undefined) return "unsupported";
    const events = await this.eventStore.read(executionId);
    const headState = await this.foldForRetention(executionId, events);

    if (this.options.archive !== undefined) {
      const archive = this.options.archive;
      // ADR 0074 R7 — one round-trip per chunk instead of one per event. Reclamation has
      // to keep pace with ingest or the log grows without bound, and a serialized
      // per-event append loop is orders of magnitude short of that. `appendBatchOf` falls
      // back to that loop when the archive backend has no `appendBatch`, so this is a
      // straight improvement for backends that implement the hook and a no-op for the rest.
      //
      // Chunked rather than one giant batch: an execution's log can be arbitrarily long,
      // and a single statement carrying all of it would trade a bounded-memory sweep for
      // an unbounded one — the opposite of what the paged enumeration exists for.
      for (let i = 0; i < events.length; i += ARCHIVE_CHUNK) {
        await appendBatchOf(archive.eventStore, events.slice(i, i + ARCHIVE_CHUNK));
      }
      if (archive.snapshotStore !== undefined) {
        const snap = await this.snapshotStore.loadLatest(executionId);
        if (snap !== null) await archive.snapshotStore.save(snap);
      }
      await this.emitLifecycleFact("EXECUTION_ARCHIVED", executionId, now);
    }

    // Journal the deletion fact BEFORE deleting — the values go, the fact survives (P9).
    await this.emitLifecycleFact("EXECUTION_DELETED", executionId, now);
    await deleteExecution.call(this.eventStore, executionId);
    // ADR 0110 D1 — the inbox stream is deleted WITH its chain: this execution is the chain's
    // head (a continued predecessor is never retained past its successor), so nothing can read
    // `__loom_inbox__:<chainId>` any more. Idempotent; a store without the stream is a no-op.
    if (headState.status !== "continued") {
      await deleteExecution.call(this.eventStore, inboxStreamId(chainIdOf(headState, executionId)));
    }
    await this.snapshotStore.deleteExecution?.(executionId);
    // The fork edge described data that no longer exists. Dropping it here is the only
    // point where the id is known AND the data is provably gone — and leaving it would
    // make every future sweep walk a dead child (see `hasLiveDescendant`), so the cost of
    // retention would grow with every fork ever taken. Optional on the SPI: a registry
    // that omits it keeps its edges, byte-identically to before.
    await this.options.branchRegistry?.removeLineage?.(executionId);
    return "reclaimed";
  }

  /**
   * ADR 0107 — what the pre-0106 compaction bug left in the blank execution `""`: which of
   * its events are provably whose (a snapshot the same run saved under the real id folds
   * them), which an operator assignment covers, which are already re-homed, and which nobody
   * can attribute. Reads only. See `planBlankStreamRepair` for the proof.
   */
  async blankStreamCensus(
    opts: { assign?: readonly RehomeAssignment[] } = {}
  ): Promise<BlankStreamCensus> {
    return (await planBlankStreamRepair(this.eventStore, this.snapshotStore, opts.assign)).census;
  }

  /**
   * ADR 0107 — re-home the blank stream's provable events (and any `assign`ed range that folds
   * onto its execution) into the execution they belong to, at the sequences they were written
   * at. A DRY RUN unless `apply: true`: without it this is {@link blankStreamCensus}.
   *
   * Per execution, ONE batch (`appendBatchOf`) carries every slot its segments still lack, so a
   * crash never leaves half of an execution re-homed. Each event is re-stamped with that
   * execution's identity, `id` `<executionId>-<sequence>` and `metadata.rehomedFrom` (its
   * blank-stream id). Before writing, the execution's tip is re-read and must equal what the
   * census saw, and its sequence 0 must exist; anything else refuses that execution. A fenced
   * execution (a worker, a fenced `TimerService`, `recoverAbandoned({ fenced })` or `cancel`
   * ever fenced it) refuses an unfenced append: the repair then takes a NEW fence and writes
   * under it, which also fences out any runner still holding the old one. An execution that
   * was never fenced is not given a fence, because every later unfenced write to it would then
   * be refused.
   *
   * Then every re-homed segment gets its `EVENTS_REHOMED` fact on the lifecycle stream,
   * including a segment an earlier run re-homed whose fact never landed. One failing execution
   * is reported in `failed` and does not stop the others. The blank stream itself is left as it
   * is: append-only evidence, and what makes a re-run idempotent.
   *
   * Refuses to apply (nothing written) when the stray events still carry ciphertext: the store
   * is the raw one under an encrypting store, and would copy ciphertext under the wrong key.
   * Run it with the affected executions quiesced and retention/compaction paused.
   */
  async rehomeBlankStream(
    opts: { assign?: readonly RehomeAssignment[]; apply?: boolean; now?: number } = {}
  ): Promise<
    BlankStreamCensus & {
      rehomed: BlankStreamSegment[];
      failed: Array<{ executionId: string; error: string }>;
    }
  > {
    const plan = await planBlankStreamRepair(this.eventStore, this.snapshotStore, opts.assign);
    const rehomed: BlankStreamSegment[] = [];
    const failed: Array<{ executionId: string; error: string }> = [];
    if (opts.apply !== true) return { ...plan.census, rehomed, failed };
    if (plan.census.shredded) {
      throw new TypeError(
        'rehomeBlankStream: the events in execution "" carry { $shredded: true } placeholders — the key they were encrypted under is gone, so their payloads are unrecoverable. Re-homing would write placeholders into an execution\'s history as if they were its events. Nothing was written.'
      );
    }
    if (plan.census.ciphertext) {
      throw new TypeError(
        'rehomeBlankStream: the events in execution "" still carry ciphertext as this store reads them. It is the raw store under an encrypting one, and re-homing through it would copy ciphertext under the wrong key. Run the repair through the app\'s own stores (`loom repair blank-stream --config <module>`).'
      );
    }
    const now = opts.now ?? Date.now();
    const byExecution = new Map<string, BlankStreamSegment[]>();
    for (const seg of plan.missing.keys()) {
      const list = byExecution.get(seg.executionId);
      if (list === undefined) byExecution.set(seg.executionId, [seg]);
      else list.push(seg);
    }
    for (const [id, segs] of byExecution) {
      try {
        await this.rehomeExecution(id, segs, plan);
        for (const seg of segs) {
          seg.status = "rehomed";
          rehomed.push(seg);
        }
      } catch (err) {
        failed.push({ executionId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // The facts, after the events: a segment re-homed now, or by an earlier run whose fact
    // never landed. One read of the lifecycle stream says which exist.
    const journaled = new Set<string>();
    for (const f of await this.eventStore.read(LIFECYCLE_STREAM)) {
      if (f.eventType !== "EVENTS_REHOMED") continue;
      const p = f.payload as { executionId: string; fromSequence: number; throughSequence: number };
      journaled.add(`${p.executionId}\u0000${p.fromSequence}\u0000${p.throughSequence}`);
    }
    for (const seg of plan.census.segments) {
      if (seg.status !== "rehomed") continue;
      const key = `${seg.executionId}\u0000${seg.fromSequence}\u0000${seg.throughSequence}`;
      if (journaled.has(key)) continue;
      try {
        await this.emitLifecycleFact("EVENTS_REHOMED", seg.executionId, now, {
          fromSequence: seg.fromSequence,
          throughSequence: seg.throughSequence,
          proof: seg.proof,
          count: seg.throughSequence - seg.fromSequence + 1,
        });
        journaled.add(key);
      } catch (err) {
        failed.push({
          executionId: seg.executionId,
          error: `re-homed ${seg.fromSequence}..${seg.throughSequence}, but its EVENTS_REHOMED fact did not land (a re-run writes it): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return { ...plan.census, rehomed, failed };
  }

  /** One execution's missing slots, in one batch, fenced if the execution is. */
  private async rehomeExecution(
    id: string,
    segs: readonly BlankStreamSegment[],
    plan: Awaited<ReturnType<typeof planBlankStreamRepair>>
  ): Promise<void> {
    const planned = plan.tipOf.get(id);
    const tip = await headOf(this.eventStore, id);
    const anchor = await readRangeOf(this.eventStore, id, 0, 0);
    if (anchor.length === 0 || tip !== planned) {
      throw new Error(
        `${id} changed since the census (tip ${planned} then, ${tip ?? "none"} now${anchor.length === 0 ? ", no sequence 0" : ""}) — re-run the census with it quiesced`
      );
    }
    const workflowId = plan.workflowIdOf.get(id)!;
    const sequences = segs.flatMap((seg) => plan.missing.get(seg) ?? []).sort((a, b) => a - b);
    const batch = (fence?: number) =>
      sequences.map((q) => rehomedEnvelope(plan.stray.get(q)!, id, workflowId, fence));
    try {
      await appendBatchOf(this.eventStore, batch());
    } catch (err) {
      const fenced =
        err instanceof StaleFenceError ||
        (err as { name?: unknown } | null)?.name === "StaleFenceError";
      if (!fenced || this.eventStore.acquireFence === undefined) throw err;
      await appendBatchOf(this.eventStore, batch(await this.eventStore.acquireFence(id)));
    }
  }

  /**
   * K10.4 — compact an execution: checkpoint the folded state as a snapshot at sequence `c`,
   * then truncate the prefix `(0..c]` (sequence 0 stays as the bootstrap anchor). Afterward
   * the replay tail is bounded to events after the checkpoint, while
   * `fold(snapshot, suffix) === fold(events)` still holds — a resume/replay is identical.
   *
   * ADR 0106 (L11) — what the checkpoint and the truncation must preserve:
   *
   *  - **Identity.** The checkpoint's `executionId`/`workflowId` come from the log (sequence
   *    0 names both); `workflowVersion`, which no event records, from the snapshots the
   *    runtime took. A blank identity made every event a resume appended land in execution
   *    `""`.
   *  - **The earlier prefix.** The fold starts from the latest snapshot at or below `c` when
   *    there is one, never from the surviving events alone of a compacted log. A gapped log
   *    with no snapshot at or above its gap throws {@link CompactionCheckpointMissingError},
   *    touching nothing.
   *  - **Pinned kinds (ADR 0055 D1).** Events of `pinnedEventTypes` stay in place
   *    (`truncatePrefixKeeping`). THE TIP RULE: when any kept event would survive, `c` is the
   *    highest non-kept sequence strictly BELOW the tip, so the tip is never removed, `c`'s
   *    own slot always is, and every reader finds the checkpoint as the highest missing
   *    sequence — a gap-free log was never compacted. With nothing kept, `c` is the tip (the
   *    log becomes `[0]`, checkpoint above it), as before. On a store without
   *    `truncatePrefixKeeping`, `c` stops below the FIRST kept event, forever: such a log is
   *    never compacted past its first finding, and `onWarn` says so (once per execution).
   *  - **The `pinned` predicate** is consulted ONLY when `pinnedEventTypes` is empty: then the
   *    kernel cannot tell which of a pinned execution's events carry the pin, so it leaves
   *    that execution uncompacted. With `pinnedEventTypes` declared, the kept kinds ARE the
   *    pin, and a pinned execution compacts around them — the documented sentinel setup pins
   *    by the very kinds it keeps (`pinByEventKinds(FINDING_RECORDED)` beside
   *    `pinnedEventTypes: [FINDING_RECORDED]`), and honouring the predicate there would stop
   *    it compacting after its first finding.
   *  - **`compactionExempt`** is consulted always: an execution it names keeps its whole log
   *    (a legal hold by tag, which no event kind expresses).
   *  - **Reserved control streams** (`__loom_*`) are refused: their writers allocate sequences
   *    from `read().length`, which only holds for a log that is never compacted.
   *
   * Returns the sequence compacted through, or `null` when the store can't truncate (no
   * `truncatePrefix`), there is nothing to compact, or the execution is pinned (as above). Throws
   * {@link UnsafeCompactionError} when the event store encrypts at rest and the snapshot
   * store does not share its KeyStore.
   */
  async compact(executionId: string): Promise<number | null> {
    if (executionId === "") {
      throw new TypeError(
        `refusing to compact "": a blank id names no execution. Its stream holds what the pre-0106 compaction bug misfiled — census and repair it with LogLifecycle.blankStreamCensus / rehomeBlankStream (ADR 0107); compacting it would fold unrelated executions together and delete the evidence.`
      );
    }
    if (isReservedStream(executionId)) {
      throw new TypeError(
        `refusing to compact "${executionId}": a reserved control stream is an append-only audit trail whose writers take their next sequence from read().length — compacting it would make them overwrite its own freed slots.`
      );
    }
    const store = this.eventStore;
    if (store.truncatePrefix === undefined) return null;
    // ADR 0022 Amendment — checked before anything is read, saved or truncated.
    const eventKeys = keysOf(store);
    if (eventKeys !== undefined && keysOf(this.snapshotStore) !== eventKeys) {
      throw new UnsafeCompactionError(executionId);
    }
    const events = await store.read(executionId);
    if (events.length <= 1) return null; // nothing beyond the bootstrap to reclaim
    if (
      this.options.compactionExempt !== undefined &&
      (await this.options.compactionExempt(executionId)) === true
    ) {
      return null;
    }
    const keep = this.keep;
    if (
      keep.size === 0 &&
      this.options.pinned !== undefined &&
      (await this.options.pinned(executionId)) === true
    ) {
      return null;
    }

    // Choose the checkpoint slot `at` (an index into `events`) under the tip rule.
    const tipIndex = events.length - 1;
    let firstKept = -1;
    for (let i = 1; i <= tipIndex; i++) {
      if (keep.has(events[i]!.eventType)) {
        firstKept = i;
        break;
      }
    }
    let at = tipIndex;
    if (firstKept !== -1) {
      at = tipIndex - 1;
      while (at > 0 && keep.has(events[at]!.eventType)) at--;
    }
    let keptBelow = firstKept !== -1 && firstKept < at;
    if (keptBelow && store.truncatePrefixKeeping === undefined) {
      // No atomic keep-in-place: stop below the first kept event. Its predecessor is a
      // non-kept event (removed now) or the bootstrap (nothing to do).
      at = firstKept - 1;
      keptBelow = false;
      this.warnOnce(
        executionId,
        `compact("${executionId}"): the event store has no truncatePrefixKeeping (EventStore SPI 1.5.0), so compaction cannot pass the pinned ${events[firstKept]!.eventType} event at sequence ${events[firstKept]!.sequence} — this log will never be compacted past it and its replay tail grows without bound. Use a store that implements truncatePrefixKeeping.`
      );
    }
    if (at <= 0) return null;
    const through = events[at]!.sequence;

    // Every event above the checkpoint survives and its own slot does not, so a gapped log's
    // checkpoint sits at its gap or above it: at or below the gap, nothing is new.
    const gap = highestMissing(events);
    if (gap >= 0 && through <= gap) return null;

    // The fold at `through`, on the latest snapshot at or below it when there is one — which
    // a gapped (compacted) log MUST have.
    const base = await this.snapshotStore.loadLatestBefore(executionId, through);
    if (gap >= 0 && (base === null || base.sequence < gap)) {
      throw new CompactionCheckpointMissingError(executionId, gap);
    }
    let workflowVersion = base?.state.workflowVersion ?? "";
    if (workflowVersion === "") {
      // Not an event fact: a pre-0106 checkpoint carries it blank, so ask the latest snapshot
      // (the runtime checkpoints every suspend) before settling for "unrecorded".
      workflowVersion =
        (await this.snapshotStore.loadLatest(executionId))?.state.workflowVersion ?? "";
    }
    const identity = { executionId, workflowId: events[0]!.workflowId, workflowVersion };
    // Fill blanks (a pre-0106 checkpoint), refuse a non-blank mismatch — the same rule the
    // runtime applies when it seeds a fold from a snapshot.
    if (base !== null) assertSnapshotIdentity(base.state, executionId, identity.workflowId);
    const state =
      base !== null
        ? new ReplayVM(
            events.filter((e) => e.sequence > base.sequence && e.sequence <= through),
            { ...normalizeSnapshotState(base.state), ...identity }
          ).getState()
        : new ReplayVM(events.slice(0, at + 1), identity).getState();

    const snapshot: Snapshot = {
      id: ulid(),
      executionId,
      workflowId: identity.workflowId,
      sequence: through,
      state,
      createdAt: 0, // deterministic; the sequence, not the wall clock, is load-bearing
    };
    // MUST persist the checkpoint before truncating — the snapshot is what the
    // suffix folds onto; truncating first would lose the prefix irrecoverably.
    await this.snapshotStore.save(snapshot);
    if (keptBelow) {
      await store.truncatePrefixKeeping!(executionId, through, [...keep]);
    } else {
      await store.truncatePrefix(executionId, through);
    }
    return through;
  }
}
