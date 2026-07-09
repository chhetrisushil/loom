import { StorageWriteError } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
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
    private readonly fence?: number
  ) {
    // Seed from the folded VM tip: -1 for a fresh start (first commit → seq 0),
    // or the last applied sequence on resume/restore (next commit continues).
    this.seq = vm.getState().sequence;
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
    const state = this.vm.getState();
    const metadata =
      opts?.metadata !== undefined || this.fence !== undefined
        ? { ...opts?.metadata, ...(this.fence !== undefined && { fence: this.fence }) }
        : undefined;
    const envelope: EventEnvelope = {
      id: opts?.id ?? `${state.executionId}-${sequence}`,
      workflowId: state.workflowId,
      executionId: state.executionId,
      eventType,
      sequence,
      timestamp: opts?.timestamp ?? Date.now(),
      payload,
      ...(metadata !== undefined && { metadata }),
    };
    this.vm.applyEvent(envelope); // in-memory fold — synchronous, authoritative
    this.onEvent?.(envelope); // live projection fold — synchronous, durability-independent
    this.enqueue(envelope); // durable write — async, order-preserving
    this.onCommit?.(sequence); // snapshot cadence hook
    return envelope;
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
