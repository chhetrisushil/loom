import { StorageWriteError } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { appendBatchOf } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { KERNEL_STAMPED_EVENT_TYPES } from "@loom/replay-vm";
import type { ReplayVM } from "@loom/replay-vm";

/**
 * Per-execution write pipeline + sequence allocator. The single source of truth
 * for sequence numbers and the only thing that calls `eventStore.append`, shared
 * by WorkflowRuntime (EXECUTION_* + cancel events) and WorkflowContext (STEP_* +
 * ctx.emit / ctx.stream / ctx.ui).
 *
 * Why it exists: it decouples the *synchronous* in-memory event flow (allocate a
 * sequence, fold the VM, fire onEvent) from the *asynchronous* durable write, so
 * `ctx.emit` / `handle.cancel` can stay synchronous even when the backing store
 * is an async/network backend. Durable writes are chained onto a single serial
 * FIFO promise, so `append` runs in strict sequence order regardless of backend
 * latency. Callers `await drain()` at durability barriers (completion, suspend
 * before snapshot, failure).
 *
 * Invariant: exactly one ExecutionJournal per live execution (single allocator).
 */
export class ExecutionJournal {
  private seq: number;
  private tail: Promise<void> = Promise.resolve();
  private firstWriteError: unknown;

  constructor(
    private readonly store: EventStore,
    // L11 (ADR 0106) — WHOSE log this journal writes. Taken from the caller, never from the
    // folded state: a state seeded from a snapshot carries whatever identity the snapshot was
    // saved with, and a checkpoint with a blank one sent every appended event to execution "".
    private readonly identity: { readonly executionId: string; readonly workflowId: string },
    private readonly vm: ReplayVM,
    private readonly onEvent: ((event: EventEnvelope) => void) | undefined,
    // Fired once, on the first durable-write rejection — used to abort in-flight
    // effects so the run stops promptly rather than pressing on against a dead store.
    private readonly onWriteError: (err: unknown) => void,
    // Fired synchronously after each commit with the new sequence — used for
    // snapshot cadence (bounding the replay tail on long-running executions).
    private readonly onCommit?: (sequence: number) => void,
    // K9.4 — the fencing token this run holds; stamped onto every envelope's
    // metadata so a fencing store can reject a zombie predecessor's writes.
    private readonly fence?: number,
    // Injectable clock for envelope timestamps (DST/simulation — the same
    // time-injection principle as TimerStore.due(now)). Default: wall clock.
    private readonly now: () => number = Date.now
  ) {
    // ADR 0106 — a blank identity is the pre-0106 compaction checkpoint's, and every event this
    // journal wrote under it went to execution "". Refuse it here, where the writes begin:
    // whatever path built the identity (a legacy `restoreFromState` state included), nothing
    // is appended to a log that is not this execution's.
    if (identity.executionId === "" || identity.workflowId === "") {
      throw new Error(
        `ExecutionJournal: refusing a blank identity (executionId "${identity.executionId}", workflowId "${identity.workflowId}") — events would be appended to no execution's log. A state restored from a pre-ADR-0106 compaction checkpoint must be given its identity first.`
      );
    }
    // Seed from the folded VM tip: -1 for a fresh start (first commit → seq 0),
    // or the last applied sequence on resume/restore (next commit continues).
    this.seq = vm.peekState().sequence;
  }

  /**
   * The ONE envelope builder, shared by {@link commit} and {@link bootstrapEnvelope} so the
   * two can never drift: a caller-chosen-id start (ADR 0103) writes its sequence 0 through
   * `bootstrapEnvelope` BEFORE a journal exists, and that envelope must be byte-identical to
   * the one `commit` would have written — same id, same injected-clock timestamp, same
   * `fence` stamp merged over the caller's metadata.
   */
  private static build(
    identity: { executionId: string; workflowId: string },
    sequence: number,
    eventType: string,
    payload: unknown,
    opts: { id?: string; timestamp?: number; metadata?: Record<string, unknown> } | undefined,
    fence: number | undefined,
    now: () => number
  ): EventEnvelope {
    // EVENT_SCHEMA 1.23.0 — the journal stamps `kernel: true` on the kinds whose fold requires
    // it. The stamp is applied LAST, so it is the journal's alone: no caller metadata sets it
    // for any other kind, and a userspace emit of these kinds is refused before it gets here.
    const stamp = KERNEL_STAMPED_EVENT_TYPES.has(eventType);
    const metadata =
      opts?.metadata !== undefined || fence !== undefined || stamp
        ? {
            ...opts?.metadata,
            ...(fence !== undefined && { fence }),
            ...(stamp && { kernel: true }),
          }
        : undefined;
    return {
      id: opts?.id ?? `${identity.executionId}-${sequence}`,
      workflowId: identity.workflowId,
      executionId: identity.executionId,
      eventType,
      sequence,
      timestamp: opts?.timestamp ?? now(),
      payload,
      ...(metadata !== undefined && { metadata }),
    };
  }

  /**
   * ADR 0103 — the sequence-0 envelope a fresh execution's journal WOULD commit, built
   * without a journal so `start()` can make it durable before the body runs. Pass the same
   * `fence` and clock the journal will be constructed with; then hand the stored envelope to
   * {@link adopt} so the journal folds it without writing it again.
   */
  static bootstrapEnvelope(
    identity: { executionId: string; workflowId: string },
    eventType: string,
    payload: unknown,
    opts: { metadata?: Record<string, unknown>; fence?: number; now?: () => number } = {}
  ): EventEnvelope {
    return ExecutionJournal.build(
      identity,
      0,
      eventType,
      payload,
      opts.metadata !== undefined ? { metadata: opts.metadata } : undefined,
      opts.fence,
      opts.now ?? Date.now
    );
  }

  /**
   * SYNCHRONOUS. Allocate the next sequence, fold the envelope into the VM, fire
   * onEvent, and enqueue the durable write. Returns the committed envelope.
   */
  commit(
    eventType: string,
    payload: unknown,
    opts?: { id?: string; timestamp?: number; metadata?: Record<string, unknown> }
  ): EventEnvelope {
    const sequence = ++this.seq;
    const envelope = ExecutionJournal.build(
      this.identity,
      sequence,
      eventType,
      payload,
      opts,
      this.fence,
      this.now
    );
    this.vm.applyEvent(envelope); // in-memory fold — synchronous, authoritative
    this.onEvent?.(envelope); // live projection fold — synchronous, durability-independent
    this.enqueue(envelope); // durable write — async, order-preserving
    this.onCommit?.(sequence); // snapshot cadence hook
    return envelope;
  }

  /**
   * SYNCHRONOUS, like {@link commit}, but the envelopes become durable as ONE write
   * (`EventStore.appendBatch`, atomic per execution): all of them land or none do. ADR 0110 D5 — the
   * notify path's `[MESSAGE_CONSUMED…, EXECUTION_RESUMED]`: a crash cannot leave the consumption
   * journaled with its resume missing. A store without `appendBatch` falls back to sequential
   * appends (the next notify then heals a half-written pair: it resumes a park whose wait is
   * already answered, consuming nothing twice).
   */
  commitAtomic(
    events: ReadonlyArray<{
      eventType: string;
      payload: unknown;
      metadata?: Record<string, unknown>;
    }>
  ): EventEnvelope[] {
    const envelopes: EventEnvelope[] = [];
    for (const e of events) {
      const sequence = ++this.seq;
      const envelope = ExecutionJournal.build(
        this.identity,
        sequence,
        e.eventType,
        e.payload,
        e.metadata !== undefined ? { metadata: e.metadata } : undefined,
        this.fence,
        this.now
      );
      this.vm.applyEvent(envelope);
      this.onEvent?.(envelope);
      envelopes.push(envelope);
    }
    this.tail = this.tail
      .then(() => {
        if (this.firstWriteError !== undefined) return;
        return appendBatchOf(this.store, envelopes);
      })
      .catch((err: unknown) => {
        if (this.firstWriteError === undefined) {
          this.firstWriteError = err;
          this.onWriteError(err);
        }
      });
    for (const envelope of envelopes) this.onCommit?.(envelope.sequence);
    return envelopes;
  }

  /**
   * ADR 0103 — take in an envelope that is ALREADY DURABLE (written by `start()`'s bootstrap
   * barrier): claim its sequence, fold it, fire onEvent and onCommit — everything
   * {@link commit} does except the append, which has already happened. It must be the next
   * sequence this journal would have allocated; anything else is a kernel bug, not input.
   */
  adopt(envelope: EventEnvelope): void {
    if (envelope.sequence !== this.seq + 1) {
      throw new Error(
        `ExecutionJournal.adopt: expected sequence ${this.seq + 1}, got ${envelope.sequence}`
      );
    }
    this.seq = envelope.sequence;
    this.vm.applyEvent(envelope);
    this.onEvent?.(envelope);
    this.onCommit?.(envelope.sequence);
  }

  private enqueue(envelope: EventEnvelope): void {
    this.tail = this.tail
      .then(() => {
        if (this.firstWriteError !== undefined) return; // stop after first failure
        return this.store.append(envelope);
      })
      .catch((err: unknown) => {
        if (this.firstWriteError === undefined) {
          this.firstWriteError = err;
          this.onWriteError(err);
        }
      });
  }

  /**
   * Flush barrier: await the serial writer draining. Throws {@link StorageWriteError}
   * if any durable write rejected. Call before resolving completion/suspend and
   * before saving a snapshot, so persistence is guaranteed at those points.
   */
  async drain(): Promise<void> {
    await this.tail;
    if (this.firstWriteError !== undefined) {
      throw new StorageWriteError(this.firstWriteError);
    }
  }

  get failed(): boolean {
    return this.firstWriteError !== undefined;
  }
}
